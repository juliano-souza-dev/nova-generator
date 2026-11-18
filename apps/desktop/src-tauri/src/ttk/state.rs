use std::sync::Mutex;
use tracing_appender::non_blocking::WorkerGuard;

use crate::{
    application::services::{MediaService, ProjectService},
    infrastructure::{media_storage::MediaStorage, youtube_cache::YoutubeCache},
};

pub struct AppState {
    pub projects: ProjectService,
    pub media: MediaService,
    pub media_storage: MediaStorage,
    pub youtube_cache: YoutubeCache,
    pub sound_library_directory: std::path::PathBuf,
    // The worker must remain alive so buffered log records are flushed.
    pub(crate) _log_guard: Mutex<Option<WorkerGuard>>,
}
