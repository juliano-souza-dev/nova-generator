use tauri::{AppHandle, State};
use crate::{state::AppState, ttk_transcription::TranscriptResult};

#[tauri::command]
pub async fn transcribe_media(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    asset_id: String,
    mode: String,
    language: Option<String>,
    local_model: Option<String>,
    source_start_ms: Option<u64>,
    source_end_ms: Option<u64>,
) -> Result<TranscriptResult, String> {
    let media = state.media.clone();
    let storage = state.media_storage.clone();
    tauri::async_runtime::spawn_blocking(move || crate::ttk_transcription::transcribe(
        app, media, storage, project_id, asset_id, mode, language,
        local_model.unwrap_or_else(|| "small".into()), source_start_ms, source_end_ms,
    )).await.map_err(|e| format!("A transcrição foi interrompida: {e}"))?
}

#[tauri::command]
pub fn check_local_asr() -> Result<bool, String> { crate::ttk_transcription::check_local_asr() }

#[tauri::command]
pub async fn install_local_asr() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(crate::ttk_transcription::install_local_asr)
        .await.map_err(|e| format!("A instalação foi interrompida: {e}"))?
}
