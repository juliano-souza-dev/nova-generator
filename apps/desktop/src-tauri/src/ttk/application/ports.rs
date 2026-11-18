use crate::domain::models::{MediaAsset, ProjectSummary};

pub trait ProjectRepository: Send + Sync {
    fn list_projects(&self) -> Result<Vec<ProjectSummary>, String>;
    fn create_project(&self, project: &ProjectSummary) -> Result<(), String>;
    fn project_exists(&self, project_id: &str) -> Result<bool, String>;
    fn list_assets(&self, project_id: &str) -> Result<Vec<MediaAsset>, String>;
    fn add_assets(&self, project_id: &str, assets: &[MediaAsset]) -> Result<(), String>;
}
