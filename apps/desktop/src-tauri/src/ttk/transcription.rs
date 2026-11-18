mod cloud;
mod local;

use cloud::transcribe_cloud;
use local::run_local_python;
pub use local::{check_local_asr, install_local_asr};

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use crate::{application::services::MediaService, infrastructure::media_storage::MediaStorage};

const CHUNK_SECONDS: u64 = 58;
const OVERLAP_SECONDS: u64 = 2;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptWord {
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptCue {
    pub id: String,
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub words: Vec<TranscriptWord>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptResult {
    pub engine: String,
    pub model: String,
    pub language: Option<String>,
    pub duration_ms: u64,
    pub cues: Vec<TranscriptCue>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptProgress {
    project_id: String,
    stage: String,
    percent: f32,
    completed_chunks: usize,
    total_chunks: usize,
    message: String,
}

fn emit(app: &AppHandle, project_id: &str, stage: &str, percent: f32, done: usize, total: usize, message: &str) {
    let _ = app.emit("transcription-progress", TranscriptProgress {
        project_id: project_id.to_string(), stage: stage.to_string(),
        percent: percent.clamp(0.0, 100.0), completed_chunks: done, total_chunks: total,
        message: message.to_string(),
    });
}
fn ffmpeg() -> Result<PathBuf, String> {
    let name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|dir| dir.join(name)));
    }
    // O alias do WinGet pode não estar no PATH herdado pelo aplicativo desktop.
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(PathBuf::from(local).join("Microsoft").join("WinGet").join("Links").join(name));
        }
        if let Some(profile) = std::env::var_os("USERPROFILE") {
            candidates.push(PathBuf::from(profile).join("AppData").join("Local").join("Microsoft").join("WinGet").join("Links").join(name));
        }
    }
    for candidate in candidates {
        if candidate.is_file() && crate::process::hidden_command(&candidate).arg("-version").output().map(|o| o.status.success()).unwrap_or(false) {
            return Ok(candidate);
        }
    }
    Err("FFmpeg não foi encontrado. Configure o FFmpeg antes de transcrever.".into())
}
fn ffprobe(ffmpeg_path: &Path) -> Result<PathBuf, String> {
    let name = if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" };
    let sibling = ffmpeg_path.parent().map(|p| p.join(name));
    if let Some(path) = sibling { if path.is_file() { return Ok(path); } }
    if let Some(value) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&value) {
            let path = dir.join(name);
            if path.is_file() { return Ok(path); }
        }
    }
    Err("ffprobe não foi encontrado. Instale a distribuição completa do FFmpeg.".into())
}
fn duration_ms(probe: &Path, input: &Path) -> Result<u64, String> {
    let output = crate::process::hidden_command(probe).args(["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1"])
        .arg(input).output().map_err(|e| format!("Falha ao consultar duração do áudio: {e}"))?;
    if !output.status.success() { return Err(String::from_utf8_lossy(&output.stderr).to_string()); }
    let seconds = String::from_utf8_lossy(&output.stdout).trim().parse::<f64>().map_err(|_| "Não foi possível identificar a duração do áudio.")?;
    Ok((seconds.max(0.0) * 1000.0).round() as u64)
}
fn safe_asset_path(media: &MediaService, storage: &MediaStorage, project_id: &str, asset_id: &str) -> Result<PathBuf, String> {
    use std::path::Component;
    let asset = media.list(project_id)?.into_iter().find(|a| a.id == asset_id)
        .ok_or("Mídia não encontrada neste projeto.")?;
    if asset.kind != "video" && asset.kind != "audio" { return Err("Selecione um vídeo ou arquivo de áudio para transcrever.".into()); }
    let relative = PathBuf::from(&asset.relative_path);
    if relative.components().any(|part| !matches!(part, Component::Normal(_))) { return Err("Caminho de mídia inválido.".into()); }
    let media_dir = storage.project_media_directory(project_id)?;
    let root = media_dir.parent().ok_or("Diretório do projeto inválido.")?.canonicalize().map_err(|e| e.to_string())?;
    let path = root.join(relative).canonicalize().map_err(|e| format!("Arquivo de mídia não encontrado: {e}"))?;
    if !path.starts_with(&root) || !path.is_file() { return Err("O arquivo não pertence a este projeto.".into()); }
    Ok(path)
}
fn extract_audio(ffmpeg_path: &Path, source: &Path, destination: &Path) -> Result<(), String> {
    let output = crate::process::hidden_command(ffmpeg_path).args(["-y","-hide_banner","-loglevel","error","-i"])
        .arg(source).args(["-vn","-ac","1","-ar","16000","-c:a","flac"]).arg(destination)
        .output().map_err(|e| format!("Não foi possível iniciar o FFmpeg: {e}"))?;
    if !output.status.success() { return Err(format!("Falha ao preparar o áudio: {}", String::from_utf8_lossy(&output.stderr).chars().take(600).collect::<String>())); }
    Ok(())
}
fn chunk_audio(ffmpeg_path: &Path, audio: &Path, directory: &Path, duration_ms: u64) -> Result<Vec<(PathBuf,u64)>, String> {
    let mut chunks = Vec::new();
    let step_ms = CHUNK_SECONDS * 1000;
    let mut start = 0u64;
    let mut index = 0usize;
    while start < duration_ms {
        let actual_start = if index == 0 { 0 } else { start.saturating_sub(OVERLAP_SECONDS * 1000) };
        let end = (start + step_ms).min(duration_ms);
        let path = directory.join(format!("chunk-{index:05}.flac"));
        let seconds = (end.saturating_sub(actual_start)) as f64 / 1000.0;
        let output = crate::process::hidden_command(ffmpeg_path).args(["-y","-hide_banner","-loglevel","error","-ss"])
            .arg(format!("{:.3}", actual_start as f64 / 1000.0)).arg("-i").arg(audio)
            .arg("-t").arg(format!("{seconds:.3}")).args(["-ac","1","-ar","16000","-c:a","flac"])
            .arg(&path).output().map_err(|e| format!("Falha ao dividir o áudio: {e}"))?;
        if !output.status.success() { return Err(format!("Falha ao criar bloco de áudio: {}", String::from_utf8_lossy(&output.stderr))); }
        chunks.push((path, actual_start));
        if end == duration_ms { break; }
        start = end;
        index += 1;
    }
    Ok(chunks)
}

pub fn transcribe(app: AppHandle, media: MediaService, storage: MediaStorage, project_id: String, asset_id: String, mode: String, language: Option<String>, local_model: String) -> Result<TranscriptResult, String> {
    if !["auto", "cloud", "local"].contains(&mode.as_str()) { return Err("Modo de transcrição inválido.".into()); }
    if !["tiny", "base", "small", "medium", "large-v3"].contains(&local_model.as_str()) { return Err("Modelo local não reconhecido.".into()); }
    let source = safe_asset_path(&media, &storage, &project_id, &asset_id)?;
    let ffmpeg_path = ffmpeg()?;
    let temp = std::env::temp_dir().join(format!("framelab-asr-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp).map_err(|e| e.to_string())?;
    let result = (|| {
        let audio = temp.join("source.flac");
        emit(&app,&project_id,"preparing",0.0,0,0,"Extraindo áudio sem alterar o arquivo original");
        extract_audio(&ffmpeg_path,&source,&audio)?;
        let duration = duration_ms(&ffprobe(&ffmpeg_path)?,&audio)?;
        let selected = mode.as_str();
        let output = if selected == "local" {
            run_local_python(&audio,&local_model,language.as_deref())?
        } else if selected == "cloud" {
            transcribe_cloud(&app,&project_id,&audio,&temp,duration,language.as_deref())?
        } else {
            match transcribe_cloud(&app,&project_id,&audio,&temp,duration,language.as_deref()) {
                Ok(result) => result,
                Err(cloud_error) => {
                    emit(&app,&project_id,"fallback",0.0,0,0,&format!("Groq indisponível. Tentando processamento local. {cloud_error}"));
                    run_local_python(&audio,&local_model,language.as_deref()).map_err(|local_error| format!("A transcrição na nuvem falhou: {cloud_error}. O processamento local também não pôde ser concluído: {local_error}"))?
                }
            }
        };
        emit(&app,&project_id,"completed",100.0,1,1,"Transcrição concluída");
        Ok(output)
    })();
    let _ = std::fs::remove_dir_all(&temp);
    result
}
