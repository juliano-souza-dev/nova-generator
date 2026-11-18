use std::sync::Arc;

use crate::{
    application::ports::ProjectRepository,
    domain::models::MediaAsset,
    infrastructure::media_storage::MediaStorage,
};

#[derive(Clone)]
pub struct MediaService {
    repository: Arc<dyn ProjectRepository>,
    storage: MediaStorage,
}

impl MediaService {
    pub fn new(repository: Arc<dyn ProjectRepository>, storage: MediaStorage) -> Self {
        Self { repository, storage }
    }

    pub fn list(&self, project_id: &str) -> Result<Vec<MediaAsset>, String> {
        self.ensure_project(project_id)?;
        self.repository.list_assets(project_id)
    }

    pub fn import_local(&self, project_id: &str, paths: &[String]) -> Result<Vec<MediaAsset>, String> {
        self.ensure_project(project_id)?;
        if paths.is_empty() {
            return Ok(Vec::new());
        }

        let (assets, copied_files) = self.storage.copy_local_files(project_id, paths)?;
        if let Err(error) = self.repository.add_assets(project_id, &assets) {
            self.storage.remove_files(&copied_files);
            tracing::error!(project_id, %error, "Could not persist imported media metadata");
            return Err(error);
        }

        tracing::info!(project_id, imported_count = assets.len(), "Local media imported");
        Ok(assets)
    }

    pub fn register_download(&self, project_id: &str, asset: &MediaAsset, downloaded_file: &std::path::Path) -> Result<(), String> {
        self.ensure_project(project_id)?;
        if let Err(error) = self.repository.add_assets(project_id, std::slice::from_ref(asset)) {
            self.storage.remove_files(&[downloaded_file.to_path_buf()]);
            tracing::error!(project_id, asset_id = %asset.id, %error, "Could not persist downloaded media metadata");
            return Err(error);
        }
        tracing::info!(project_id, asset_id = %asset.id, "Downloaded media registered");
        Ok(())
    }

    fn ensure_project(&self, project_id: &str) -> Result<(), String> {
        if self.repository.project_exists(project_id)? {
            Ok(())
        } else {
            Err("Projeto não encontrado neste dispositivo.".into())
        }
    }
}
