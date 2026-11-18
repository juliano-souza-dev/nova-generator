use std::sync::Arc;
use uuid::Uuid;

use crate::{
    application::ports::ProjectRepository,
    domain::models::{timestamp_millis, ProjectSummary},
    infrastructure::media_storage::MediaStorage,
};

#[derive(Clone)]
pub struct ProjectService {
    repository: Arc<dyn ProjectRepository>,
    storage: MediaStorage,
}

impl ProjectService {
    pub fn new(repository: Arc<dyn ProjectRepository>, storage: MediaStorage) -> Self {
        Self { repository, storage }
    }

    pub fn list(&self) -> Result<Vec<ProjectSummary>, String> {
        self.repository.list_projects()
    }

    pub fn open(&self, project_id: &str) -> Result<ProjectSummary, String> {
        self.repository.list_projects()?.into_iter()
            .find(|project| project.id == project_id)
            .ok_or_else(|| "Projeto não encontrado neste dispositivo.".to_string())
    }

    pub fn create(&self, name: &str) -> Result<ProjectSummary, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("Informe um nome para o projeto.".into());
        }
        if name.chars().count() > 80 {
            return Err("O nome do projeto deve ter no máximo 80 caracteres.".into());
        }

        let now = timestamp_millis();
        let project = ProjectSummary {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            created_at: now.clone(),
            updated_at: now,
            width: 1080,
            height: 1920,
        };

        self.storage.create_project_directory(&project.id)?;
        if let Err(error) = self.repository.create_project(&project) {
            self.storage.remove_project_directory(&project.id);
            return Err(error);
        }
        tracing::info!(project_id = %project.id, project_name = %project.name, "Project created");
        Ok(project)
    }
}
