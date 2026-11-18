use std::{fs, path::{Path, PathBuf}, sync::Arc, time::Duration};

use rusqlite::{params, Connection};
use serde_json::Value;

use crate::{
    application::ports::ProjectRepository,
    domain::models::{MediaAsset, ProjectSummary},
};

#[derive(Clone)]
pub struct SqliteProjectRepository {
    database_path: Arc<PathBuf>,
}

impl SqliteProjectRepository {
    pub fn initialize(database_path: PathBuf, legacy_projects_directory: &Path) -> Result<Self, String> {
        if let Some(parent) = database_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Não foi possível criar a pasta do banco de dados: {error}"))?;
        }

        let repository = Self { database_path: Arc::new(database_path) };
        {
            let connection = repository.connect()?;
            connection.pragma_update(None, "journal_mode", "WAL")
                .map_err(|error| format!("Não foi possível ativar o modo WAL: {error}"))?;
            connection.pragma_update(None, "synchronous", "NORMAL")
                .map_err(|error| error.to_string())?;
            repository.migrate_schema(&connection)?;
        }
        repository.import_legacy_projects(legacy_projects_directory)?;
        tracing::info!(database = %repository.database_path.display(), "SQLite repository initialized");
        Ok(repository)
    }

    fn connect(&self) -> Result<Connection, String> {
        let connection = Connection::open(self.database_path.as_path())
            .map_err(|error| format!("Não foi possível abrir o banco de dados local: {error}"))?;
        connection.busy_timeout(Duration::from_secs(5)).map_err(|error| error.to_string())?;
        connection.pragma_update(None, "foreign_keys", "ON").map_err(|error| error.to_string())?;
        Ok(connection)
    }

    fn migrate_schema(&self, connection: &Connection) -> Result<(), String> {
        let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|error| error.to_string())?;
        if version > 1 {
            return Err(format!("A versão do banco de dados ({version}) é mais recente que a suportada."));
        }
        if version == 0 {
            connection.execute_batch(
                "
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY NOT NULL,
                    name TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    width INTEGER NOT NULL,
                    height INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS assets (
                    id TEXT PRIMARY KEY NOT NULL,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    name TEXT NOT NULL,
                    original_name TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    mime_type TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
                    relative_path TEXT NOT NULL,
                    source TEXT NOT NULL,
                    source_url TEXT,
                    duration_ms INTEGER,
                    width INTEGER,
                    height INTEGER,
                    created_at TEXT NOT NULL,
                    UNIQUE(project_id, relative_path)
                );

                CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at DESC);
                CREATE INDEX IF NOT EXISTS idx_assets_project_created ON assets(project_id, created_at DESC);
                PRAGMA user_version = 1;
                "
            ).map_err(|error| format!("Falha ao criar o esquema SQLite: {error}"))?;
        }
        Ok(())
    }

    fn import_legacy_projects(&self, directory: &Path) -> Result<(), String> {
        if !directory.is_dir() {
            return Ok(());
        }

        let entries = fs::read_dir(directory).map_err(|error| error.to_string())?;
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let file = entry.path().join("project.json");
            if !file.is_file() {
                continue;
            }

            let result = (|| {
                let raw = fs::read_to_string(&file).map_err(|error| error.to_string())?;
                let document: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
                let project: ProjectSummary = serde_json::from_value(
                    document.get("project").cloned().ok_or("Projeto legado sem metadados.")?
                ).map_err(|error| error.to_string())?;

                let connection = self.connect()?;
                connection.execute(
                    "INSERT OR IGNORE INTO projects (id, name, created_at, updated_at, width, height)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![project.id, project.name, project.created_at, project.updated_at,
                        i64::from(project.width), i64::from(project.height)],
                ).map_err(|error| error.to_string())?;

                if let Some(items) = document.get("assets").and_then(Value::as_array) {
                    let assets: Vec<MediaAsset> = items.iter().filter_map(|item|
                        serde_json::from_value(item.clone()).ok()
                    ).collect();
                    self.insert_assets(&connection, &project.id, &assets)?;
                }
                Ok::<(), String>(())
            })();

            if let Err(error) = result {
                tracing::warn!(file = %file.display(), %error, "Could not migrate legacy project file");
            }
        }
        Ok(())
    }

    fn insert_assets(&self, connection: &Connection, project_id: &str, assets: &[MediaAsset]) -> Result<(), String> {
        for asset in assets {
            let size = i64::try_from(asset.size_bytes)
                .map_err(|_| format!("O arquivo {} é grande demais para o banco de dados.", asset.name))?;
            connection.execute(
                "INSERT OR IGNORE INTO assets
                 (id, project_id, name, original_name, kind, mime_type, size_bytes, relative_path,
                  source, source_url, duration_ms, width, height, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    asset.id, project_id, asset.name, asset.original_name, asset.kind, asset.mime_type,
                    size, asset.relative_path, asset.source, asset.source_url,
                    asset.duration_ms.map(i64::try_from).transpose().map_err(|_| "Duração inválida.")?,
                    asset.width.map(i64::from), asset.height.map(i64::from), asset.created_at
                ],
            ).map_err(|error| format!("Não foi possível registrar a mídia {}: {error}", asset.name))?;
        }
        Ok(())
    }
}

impl ProjectRepository for SqliteProjectRepository {
    fn list_projects(&self) -> Result<Vec<ProjectSummary>, String> {
        let connection = self.connect()?;
        let mut statement = connection.prepare(
            "SELECT id, name, created_at, updated_at, width, height FROM projects ORDER BY updated_at DESC"
        ).map_err(|error| error.to_string())?;
        let rows = statement.query_map([], |row| Ok(ProjectSummary {
            id: row.get(0)?, name: row.get(1)?, created_at: row.get(2)?,
            updated_at: row.get(3)?,
            width: u32::try_from(row.get::<_, i64>(4)?).unwrap_or_default(),
            height: u32::try_from(row.get::<_, i64>(5)?).unwrap_or_default(),
        })).map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
    }

    fn create_project(&self, project: &ProjectSummary) -> Result<(), String> {
        let connection = self.connect()?;
        connection.execute(
            "INSERT INTO projects (id, name, created_at, updated_at, width, height)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![project.id, project.name, project.created_at, project.updated_at,
                i64::from(project.width), i64::from(project.height)],
        ).map_err(|error| format!("Não foi possível salvar o projeto: {error}"))?;
        Ok(())
    }

    fn project_exists(&self, project_id: &str) -> Result<bool, String> {
        let connection = self.connect()?;
        connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
            [project_id], |row| row.get(0)
        ).map_err(|error| error.to_string())
    }

    fn list_assets(&self, project_id: &str) -> Result<Vec<MediaAsset>, String> {
        let connection = self.connect()?;
        let mut statement = connection.prepare(
            "SELECT id, name, original_name, kind, mime_type, size_bytes, relative_path,
                    source, source_url, duration_ms, width, height, created_at
             FROM assets WHERE project_id = ?1 ORDER BY created_at DESC"
        ).map_err(|error| error.to_string())?;
        let rows = statement.query_map([project_id], |row| {
            let size: i64 = row.get(5)?;
            let duration: Option<i64> = row.get(9)?;
            Ok(MediaAsset {
                id: row.get(0)?, name: row.get(1)?, original_name: row.get(2)?,
                kind: row.get(3)?, mime_type: row.get(4)?,
                size_bytes: u64::try_from(size).unwrap_or_default(),
                relative_path: row.get(6)?, source: row.get(7)?, source_url: row.get(8)?,
                duration_ms: duration.and_then(|value| u64::try_from(value).ok()),
                width: row.get::<_, Option<i64>>(10)?.and_then(|value| u32::try_from(value).ok()),
                height: row.get::<_, Option<i64>>(11)?.and_then(|value| u32::try_from(value).ok()),
                created_at: row.get(12)?,
            })
        }).map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
    }

    fn add_assets(&self, project_id: &str, assets: &[MediaAsset]) -> Result<(), String> {
        let mut connection = self.connect()?;
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        self.insert_assets(&transaction, project_id, assets)?;
        transaction.execute(
            "UPDATE projects SET updated_at = ?1 WHERE id = ?2",
            params![crate::domain::models::timestamp_millis(), project_id],
        ).map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| format!("Não foi possível confirmar a importação: {error}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::models::timestamp_millis;

    fn sample_project(id: &str) -> ProjectSummary {
        let now = timestamp_millis();
        ProjectSummary {
            id: id.into(), name: "Projeto de teste".into(), created_at: now.clone(),
            updated_at: now, width: 1080, height: 1920,
        }
    }

    #[test]
    fn persists_projects_and_assets_transactionally() {
        let directory = tempfile::tempdir().unwrap();
        let projects_directory = directory.path().join("projects");
        fs::create_dir_all(&projects_directory).unwrap();
        let repository = SqliteProjectRepository::initialize(
            directory.path().join("app.sqlite3"), &projects_directory
        ).unwrap();

        let project = sample_project("project-1");
        repository.create_project(&project).unwrap();
        let asset = MediaAsset {
            id: "asset-1".into(), name: "aula.mp4".into(), original_name: "aula.mp4".into(),
            kind: "video".into(), mime_type: "video/mp4".into(), size_bytes: 1234,
            relative_path: "media/asset-1.mp4".into(), source: "local".into(),
            source_url: None, duration_ms: Some(1200), width: Some(1920),
            height: Some(1080), created_at: timestamp_millis(),
        };
        repository.add_assets(&project.id, &[asset.clone()]).unwrap();

        assert_eq!(repository.list_projects().unwrap().len(), 1);
        let assets = repository.list_assets(&project.id).unwrap();
        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].id, asset.id);
        assert_eq!(assets[0].size_bytes, 1234);
        assert_eq!(assets[0].height, Some(1080));
    }

    #[test]
    fn imports_existing_json_projects_without_requiring_manual_conversion() {
        let directory = tempfile::tempdir().unwrap();
        let projects_directory = directory.path().join("projects");
        let project_directory = projects_directory.join("legacy-project");
        fs::create_dir_all(project_directory.join("media")).unwrap();
        let project = sample_project("legacy-project");
        let document = serde_json::json!({
            "schemaVersion": 1,
            "project": project,
            "canvas": { "width": 1080, "height": 1920, "frameRate": 30 },
            "assets": [],
            "tracks": [],
            "captions": []
        });
        fs::write(
            project_directory.join("project.json"),
            serde_json::to_vec_pretty(&document).unwrap()
        ).unwrap();

        let repository = SqliteProjectRepository::initialize(
            directory.path().join("app.sqlite3"), &projects_directory
        ).unwrap();

        let projects = repository.list_projects().unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].id, "legacy-project");
    }
}
