mod local;

use local::run_local_python;
pub use local::{check_local_asr, install_local_asr};

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use crate::{application::services::MediaService, infrastructure::media_storage::MediaStorage};

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

fn extract_audio_range(ffmpeg_path: &Path, source: &Path, destination: &Path, start_ms: u64, end_ms: u64) -> Result<(), String> {
    let start = format!("{:.3}", start_ms as f64 / 1000.0);
    let duration = format!("{:.3}", end_ms.saturating_sub(start_ms) as f64 / 1000.0);
    let output = crate::process::hidden_command(ffmpeg_path)
        .args(["-y", "-hide_banner", "-loglevel", "error", "-ss", &start, "-i"])
        .arg(source).arg("-t").arg(&duration)
        .args(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac"])
        .arg(destination).output().map_err(|e| format!("Não foi possível iniciar o FFmpeg: {e}"))?;
    if !output.status.success() {
        return Err(format!("Falha ao preparar o trecho de áudio: {}", String::from_utf8_lossy(&output.stderr).chars().take(600).collect::<String>()));
    }
    Ok(())
}

pub fn transcribe(app: AppHandle, media: MediaService, storage: MediaStorage, project_id: String, asset_id: String, language: Option<String>, local_model: String, source_start_ms: Option<u64>, source_end_ms: Option<u64>) -> Result<TranscriptResult, String> {
    if !["tiny", "base", "small", "medium", "large-v3"].contains(&local_model.as_str()) { return Err("Modelo local não reconhecido.".into()); }
    let source = safe_asset_path(&media, &storage, &project_id, &asset_id)?;
    let ffmpeg_path = ffmpeg()?;
    let temp = std::env::temp_dir().join(format!("framelab-asr-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp).map_err(|e| e.to_string())?;
    let result = (|| {
        let audio = temp.join("source.flac");
        emit(&app,&project_id,"preparing",0.0,0,0,"Extraindo áudio sem alterar o arquivo original");
        let source_duration = duration_ms(&ffprobe(&ffmpeg_path)?, &source)?;
        let start_ms = source_start_ms.unwrap_or(0).min(source_duration);
        let end_ms = source_end_ms.unwrap_or(source_duration).min(source_duration);
        if end_ms <= start_ms { return Err("O trecho selecionado do clipe é inválido.".into()); }
        extract_audio_range(&ffmpeg_path, &source, &audio, start_ms, end_ms)?;
        let duration = duration_ms(&ffprobe(&ffmpeg_path)?,&audio)?;
        emit(&app,&project_id,"loading_model",5.0,0,0,&format!("Preparando o modelo {} para execução em CPU",local_model));
        let output = run_local_python(
            &audio,
            &local_model,
            language.as_deref(),
            &mut |stage, percent, done, total, message| {
                emit(&app,&project_id,stage,percent,done,total,message);
            },
        )?;
        let mut output = output;
        output.duration_ms = duration;
        for cue in &mut output.cues {
            cue.start_ms = cue.start_ms.saturating_add(start_ms);
            cue.end_ms = cue.end_ms.saturating_add(start_ms);
            for word in &mut cue.words {
                word.start_ms = word.start_ms.saturating_add(start_ms);
                word.end_ms = word.end_ms.saturating_add(start_ms);
            }
        }
        emit(&app,&project_id,"completed",100.0,1,1,"Transcrição do trecho concluída");
        Ok(output)
    })();
    let _ = std::fs::remove_dir_all(&temp);
    result
}
