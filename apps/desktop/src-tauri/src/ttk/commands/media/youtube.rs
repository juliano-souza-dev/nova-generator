use tauri::{AppHandle, Emitter, State};
use crate::{
    domain::models::{DownloadProgress, MediaAsset, YoutubeInspection},
    infrastructure::youtube_downloader::YoutubeDownloader,
    state::AppState,
};
use super::super::export::resolve_ffmpeg_executable;

#[tauri::command]
pub async fn inspect_youtube(url: String) -> Result<YoutubeInspection, String> {
    tauri::async_runtime::spawn_blocking(move || YoutubeDownloader::inspect(&url))
        .await
        .map_err(|error| format!("A consulta do YouTube foi interrompida: {error}"))?
}

#[tauri::command]
pub async fn download_youtube(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    url: String,
    max_height: Option<u32>,
) -> Result<MediaAsset, String> {
    let storage = state.media_storage.clone();
    let media = state.media.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let progress_app = app.clone();
        let progress_project = project_id.clone();
        let (asset, downloaded_file) = YoutubeDownloader::download(
            &url,
            &project_id,
            max_height,
            &storage,
            move |progress: DownloadProgress| {
                let _ = progress_app.emit("youtube-download-progress", progress);
            },
        )?;
        media.register_download(&project_id, &asset, &downloaded_file)?;
        let _ = app.emit("youtube-download-progress", DownloadProgress {
            project_id: progress_project,
            percent: Some(100.0),
            speed: None,
            eta: None,
            status: "completed".into(),
        });
        Ok(asset)
    })
    .await
    .map_err(|error| format!("A tarefa de download foi interrompida: {error}"))?
}


#[tauri::command]
pub async fn prepare_youtube_cache(
    state: State<'_, AppState>,
    url: String,
    max_height: Option<u32>,
) -> Result<crate::infrastructure::youtube_cache::YoutubeCacheEntry, String> {
    let cache = state.youtube_cache.clone();
    tauri::async_runtime::spawn_blocking(move || cache.prepare(&url, max_height.unwrap_or(1080)))
        .await.map_err(|e| format!("A preparação do vídeo foi interrompida: {e}"))?
}

#[tauri::command]
pub async fn trim_youtube_cache(
    state: State<'_, AppState>,
    project_id: String,
    video_id: String,
    start_ms: u64,
    end_ms: u64,
) -> Result<MediaAsset, String> {
    let cache = state.youtube_cache.clone();
    let storage = state.media_storage.clone();
    let media = state.media.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if end_ms <= start_ms || end_ms - start_ms < 300 {
            return Err("Selecione um trecho de pelo menos 0,3 segundo.".to_string());
        }
        let _cache_guard = cache.lock()?;
        let entry = cache.validate_entry(&video_id)?;
        if let Some(duration) = entry.duration_ms {
            if end_ms > duration { return Err("O fim do recorte ultrapassa a duração do vídeo.".into()); }
        }
        let media_dir = storage.project_media_directory(&project_id)?;
        let id = uuid::Uuid::new_v4().to_string();
        let output = media_dir.join(format!("{id}.mp4"));
        let (ffmpeg, _) = resolve_ffmpeg_executable()?;
        let duration = end_ms - start_ms;
        let result = crate::process::hidden_command(ffmpeg)
            .args(["-y", "-hide_banner", "-loglevel", "error", "-ss"])
            .arg(format!("{:.3}", start_ms as f64 / 1000.0))
            .arg("-i").arg(&entry.file_path)
            .arg("-t").arg(format!("{:.3}", duration as f64 / 1000.0))
            .args(["-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"])
            .arg(&output)
            .output()
            .map_err(|e| format!("Não foi possível iniciar o recorte: {e}"))?;
        if !result.status.success() {
            let _ = std::fs::remove_file(&output);
            return Err(format!("O FFmpeg não conseguiu gerar o trecho: {}", String::from_utf8_lossy(&result.stderr).trim()));
        }
        let size_bytes = std::fs::metadata(&output).map_err(|e| e.to_string())?.len();
        if size_bytes == 0 { let _ = std::fs::remove_file(&output); return Err("O trecho gerado está vazio.".into()); }
        let safe_title: String = entry.title.chars().map(|ch| if ch.is_ascii_alphanumeric() || ch=='-' || ch=='_' {ch} else {'_'}).take(42).collect();
        let asset = MediaAsset {
            id: id.clone(),
            name: format!("{} (trecho)", entry.title),
            original_name: format!("{safe_title}_clip.mp4"),
            kind: "video".into(),
            mime_type: "video/mp4".into(),
            size_bytes,
            relative_path: format!("media/{id}.mp4"),
            source: "youtube".into(),
            source_url: Some(format!("https://www.youtube.com/watch?v={video_id}")),
            duration_ms: Some(duration),
            width: None,
            height: None,
            created_at: crate::domain::models::timestamp_millis(),
        };
        media.register_download(&project_id, &asset, &output)?;
        Ok(asset)
    }).await.map_err(|e| format!("O recorte foi interrompido: {e}"))?
}
