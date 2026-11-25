pub mod application;
pub mod commands;
pub mod domain;
pub mod infrastructure;
pub mod logging;
pub mod state;
pub mod transcription;

use std::{fs, path::{Path, PathBuf}, sync::{Arc, Mutex}};
use tauri::Manager;

use application::services::{MediaService, ProjectService};
use infrastructure::{media_storage::MediaStorage, sqlite_project_repository::SqliteProjectRepository, youtube_cache::YoutubeCache};
use state::AppState;

fn copy_missing_tree(source: &Path, destination: &Path) -> std::io::Result<()> {
    if !source.is_dir() { return Ok(()); }
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let from = entry.path();
        let to = destination.join(entry.file_name());
        if from.is_dir() {
            copy_missing_tree(&from, &to)?;
        } else if from.is_file() && !to.exists() {
            if let Some(parent) = to.parent() { fs::create_dir_all(parent)?; }
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

fn migrate_legacy_data(destination: &Path) -> std::io::Result<()> {
    let mut candidates = Vec::<PathBuf>::new();
    if let Some(path) = std::env::var_os("APPDATA") {
        candidates.push(PathBuf::from(path).join("com.julianosouza.ttkcreator"));
    }
    if let Some(path) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(path).join("com.julianosouza.ttkcreator"));
    }
    if let Some(path) = std::env::var_os("XDG_DATA_HOME") {
        candidates.push(PathBuf::from(path).join("com.julianosouza.ttkcreator"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(&home).join("Library/Application Support/com.julianosouza.ttkcreator"));
        candidates.push(PathBuf::from(&home).join(".local/share/com.julianosouza.ttkcreator"));
    }
    for source in candidates {
        if source.is_dir() && source != destination {
            copy_missing_tree(&source, destination)?;
        }
    }
    Ok(())
}

fn migrate_legacy_webview_data(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let legacy_profile = PathBuf::from(local_app_data)
            .join("com.julianosouza.ttkcreator")
            .join("EBWebView");
        let current_profile = app.path().app_local_data_dir()?.join("EBWebView");
        if legacy_profile.is_dir() && legacy_profile != current_profile {
            copy_missing_tree(&legacy_profile, &current_profile)?;
        }
    }
    Ok(())
}


pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let app_data_directory = app.path().app_data_dir()?.join("ttk");
    fs::create_dir_all(&app_data_directory)?;
    migrate_legacy_data(&app_data_directory)?;
    migrate_legacy_webview_data(app)?;
    let log_guard = logging::initialize(&app_data_directory.join("logs")).map_err(std::io::Error::other)?;
    let projects_directory = app_data_directory.join("projects");
    fs::create_dir_all(&projects_directory)?;
    let media_shared_directory = match crate::shared_runtime::resolve_media_shared_directory(app.handle()) {
        Ok(directory) => Some(directory),
        Err(error) => { tracing::error!("Não foi possível resolver mediaShared pelo Shared Runtime integrado do Nova: {error}"); None }
    };
    let youtube_cache = YoutubeCache::new(media_shared_directory);
    let sound_library_directory = app_data_directory.join("sound-library");
    fs::create_dir_all(&sound_library_directory)?;
    let database_path = app_data_directory.join("tiktok-media-creator.sqlite3");
    let repository = Arc::new(SqliteProjectRepository::initialize(database_path, &projects_directory).map_err(std::io::Error::other)?);
    let repository_port: Arc<dyn application::ports::ProjectRepository> = repository.clone();
    let media_storage = MediaStorage::new(app_data_directory.clone());
    let projects = ProjectService::new(repository_port.clone(), media_storage.clone());
    let media = MediaService::new(repository_port, media_storage.clone());
    let cleanup_cache = youtube_cache.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
        if let Err(error) = cleanup_cache.cleanup_expired() { tracing::warn!(%error, "Could not clean expired YouTube cache entries"); }
    });
    app.manage(AppState { projects, media, media_storage, youtube_cache, sound_library_directory, _log_guard: Mutex::new(Some(log_guard)) });
    Ok(())
}
