// Tauri command facade. Each feature owns its command handlers and implementation.
pub mod export;
pub mod media;
pub mod sounds;
pub mod transcription;

pub use export::{check_ffmpeg, export_timeline};
pub use media::{
    create_project, download_youtube, get_project_asset_path, import_media_files,
    inspect_youtube, list_project_assets, list_projects, open_project,
    prepare_youtube_cache, trim_youtube_cache,
};
pub use sounds::{
    delete_global_sound, get_global_sound_path, import_global_sound, list_global_sounds,
};
pub use transcription::{check_local_asr, install_local_asr, transcribe_media};
pub use sounds::GlobalSound;
