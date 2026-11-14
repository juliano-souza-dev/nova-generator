use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Emitter, Manager};

const TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    pub id: String, pub name: String, pub original_name: String, pub kind: String,
    pub mime_type: String, pub size_bytes: u64, pub relative_path: String, pub source: String,
    pub source_url: Option<String>, pub source_video_id: Option<String>,
    pub source_start_ms: Option<u64>, pub source_end_ms: Option<u64>,
    pub duration_ms: Option<u64>, pub created_at: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeInspection {
    pub video_id: String, pub url: String, pub title: String, pub channel: Option<String>,
    pub duration_ms: Option<u64>, pub thumbnail: Option<String>, pub qualities: Vec<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeCacheEntry {
    pub video_id: String, pub title: String, pub duration_ms: Option<u64>,
    pub file_path: String, pub updated_at: u64, pub expires_at: u64, pub reused: bool,
}
fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
fn valid_id(v: &str) -> bool { !v.is_empty() && v.len() <= 64 && v.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') }
fn project_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) { return Err("Identificador de projeto inválido.".into()); }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("projects").join(id);
    fs::create_dir_all(dir.join("media")).map_err(|e| e.to_string())?; Ok(dir)
}
fn read_assets(dir: &Path) -> Result<Vec<MediaAsset>, String> {
    let file = dir.join("media.json"); if !file.exists() { return Ok(Vec::new()); }
    let raw = fs::read_to_string(file).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() { return Ok(Vec::new()); }
    serde_json::from_str(&raw).map_err(|e| format!("Biblioteca de mídia inválida: {e}"))
}
fn save_assets(dir: &Path, items: &[MediaAsset]) -> Result<(), String> {
    let target = dir.join("media.json"); let temp = dir.join("media.json.tmp");
    fs::write(&temp, serde_json::to_vec_pretty(items).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if target.exists() { fs::remove_file(&target).map_err(|e| e.to_string())?; }
    fs::rename(temp, target).map_err(|e| e.to_string())
}
fn append_assets(dir: &Path, added: &[MediaAsset]) -> Result<(), String> {
    let mut all = read_assets(dir)?;
    for item in added { if !all.iter().any(|old| old.id == item.id) { all.insert(0, item.clone()); } }
    save_assets(dir, &all)
}

struct Shared { media: PathBuf, ytdlp: PathBuf, ffmpeg: PathBuf }
fn shared_manifest_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(p) = std::env::var_os("NOVA_GENERATOR_SHARED_CONFIG") { candidates.push(PathBuf::from(p)); }
    for base in [std::env::current_dir().ok(), std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)), app.path().resource_dir().ok()] {
        let mut current = base;
        while let Some(path) = current { candidates.push(path.join("shared.config.json")); current = path.parent().map(Path::to_path_buf); }
    }
    let mut seen = std::collections::HashSet::new();
    for candidate in candidates {
        let path = if candidate.is_dir() { candidate.join("shared.config.json") } else { candidate };
        if seen.insert(path.clone()) && path.is_file() { return Ok(path); }
    }
    Err("O Nova Generator não está vinculado ao Shared Runtime Manager. Vincule ou sincronize o projeto para receber os caminhos compartilhados.".into())
}
fn shared_resource(config: &Value, id: &str) -> Result<PathBuf, String> {
    // Dependencies provisioned by Shared are published here. The resources
    // map remains a supported fallback for manager-owned tools registered there.
    let raw = config.pointer(&format!("/shared/resolvedDependencies/{id}"))
        .or_else(|| config.pointer(&format!("/shared/resources/{id}")))
        .and_then(Value::as_str)
        .ok_or_else(|| format!("O recurso '{id}' não está resolvido pelo Shared Runtime Manager. Atualize o vínculo desta aplicação."))?;
    let p = PathBuf::from(raw);
    if !p.is_absolute() { return Err(format!("O caminho do recurso '{id}' precisa ser absoluto.")); }
    if p.is_file() { return Ok(p); }
    let names = if cfg!(windows) { vec![format!("{id}.exe"), format!("{id}.cmd"), format!("{id}.bat")] } else { vec![id.to_string()] };
    names.into_iter().map(|n| p.join(n)).find(|candidate| candidate.is_file())
        .ok_or_else(|| format!("Executável compartilhado '{id}' não encontrado em {}.", p.display()))
}
fn shared(app: &AppHandle) -> Result<Shared, String> {
    let path = shared_manifest_path(app)?;
    let raw = fs::read(&path).map_err(|e| e.to_string())?;
    let config: Value = serde_json::from_slice(&raw).map_err(|e| format!("shared.config.json inválido: {e}"))?;
    if config.get("schemaVersion").and_then(Value::as_str) != Some("1.0") ||
       config.pointer("/shared/enabled").and_then(Value::as_bool) != Some(true) {
        return Err("O vínculo Shared Runtime está ausente, desativado ou incompatível. Sincronize o Nova Generator pelo Shared Runtime Manager.".into());
    }
    let media = config.pointer("/shared/directories/mediaShared").and_then(Value::as_str)
        .ok_or("O Shared Runtime não forneceu shared.directories.mediaShared. Sincronize o vínculo desta aplicação.")?;
    let media = PathBuf::from(media);
    if !media.is_absolute() { return Err("shared.directories.mediaShared precisa ser absoluto.".into()); }
    Ok(Shared { media, ytdlp: shared_resource(&config, "yt-dlp")?, ffmpeg: shared_resource(&config, "ffmpeg")? })
}

#[tauri::command]
pub fn authorize_youtube_preview(app: AppHandle, video_id: String) -> Result<String, String> {
    if video_id.len() != 11 || !video_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err("ID do vídeo inválido.".into());
    }
    let s = shared(&app)?;
    let canonical_root = s.media.canonicalize().map_err(|e| format!("Biblioteca compartilhada indisponível: {e}"))?;
    let canonical_video = s.media.join(format!("{video_id}.mp4")).canonicalize()
        .map_err(|_| "Vídeo original não encontrado na biblioteca compartilhada.".to_string())?;
    if !canonical_video.starts_with(&canonical_root) || !canonical_video.is_file() {
        return Err("Arquivo de pré-visualização inválido.".into());
    }
    app.asset_protocol_scope().allow_file(&canonical_video)
        .map_err(|e| format!("Não foi possível liberar a pré-visualização do vídeo: {e}"))?;
    Ok(canonical_video.to_string_lossy().into_owned())
}

fn run_ytdlp(s: &Shared, args: &[String]) -> Result<std::process::Output, String> {
    let mut cmd = crate::process::hidden_command(&s.ytdlp); cmd.args(args);
    if let Some(parent) = s.ffmpeg.parent() { cmd.arg("--ffmpeg-location").arg(parent); }
    cmd.output().map_err(|e| format!("Não foi possível iniciar o yt-dlp compartilhado: {e}"))
}
fn inspect(s: &Shared, raw: &str) -> Result<YoutubeInspection, String> {
    if raw.trim().is_empty() { return Err("Cole um link do YouTube.".into()); }
    let out = run_ytdlp(s, &vec!["--dump-single-json".into(), "--skip-download".into(), "--no-playlist".into(), "--no-warnings".into(), "--socket-timeout".into(), "20".into(), raw.trim().into()])?;
    if !out.status.success() { return Err(format!("Não foi possível consultar o vídeo: {}", String::from_utf8_lossy(&out.stderr).trim())); }
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| format!("Metadados do YouTube inválidos: {e}"))?;
    let id = v.get("id").and_then(Value::as_str).ok_or("O YouTube não informou o ID do vídeo.")?.to_string();
    if id.len() != 11 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') { return Err("ID de vídeo inválido.".into()); }
    let mut heights = std::collections::BTreeSet::new();
    if let Some(formats) = v.get("formats").and_then(Value::as_array) {
        for f in formats {
            if f.get("vcodec").and_then(Value::as_str).is_some_and(|c| c != "none") {
                if let Some(h) = f.get("height").and_then(Value::as_u64) { if h > 0 && h <= 2160 { heights.insert(h as u32); } }
            }
        }
    }
    let mut qualities: Vec<u32> = heights.into_iter().collect(); qualities.reverse();
    Ok(YoutubeInspection {
        video_id: id.clone(), url: format!("https://www.youtube.com/watch?v={id}"),
        title: v.get("title").and_then(Value::as_str).unwrap_or("Vídeo do YouTube").to_string(),
        channel: v.get("channel").or_else(|| v.get("uploader")).and_then(Value::as_str).map(str::to_string),
        duration_ms: v.get("duration").and_then(Value::as_f64).map(|n| (n * 1000.0) as u64),
        thumbnail: v.get("thumbnail").and_then(Value::as_str).map(str::to_string), qualities
    })
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress { project_id: String, status: String, percent: f32, message: String }

#[tauri::command]
pub async fn inspect_youtube(app: AppHandle, url: String) -> Result<YoutubeInspection, String> {
    tauri::async_runtime::spawn_blocking(move || inspect(&shared(&app)?, &url)).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn prepare_youtube_cache(app: AppHandle, project_id: String, url: String, max_height: Option<u32>) -> Result<YoutubeCacheEntry, String> {
    let emitter = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let send = |status: &str, percent: f32, message: &str| {
            let _ = emitter.emit("media-task-progress", Progress { project_id: project_id.clone(), status: status.into(), percent, message: message.into() });
        };
        send("running", 2.0, "Consultando o vídeo e verificando a biblioteca compartilhada...");
        let s = shared(&app)?;
        let info = inspect(&s, &url)?;
        if !s.media.is_dir() { return Err("O Shared Runtime informou mediaShared, mas a pasta ainda não existe. Abra o Shared Runtime Manager e sincronize a aplicação.".into()); }
        let video = s.media.join(format!("{}.mp4", info.video_id));
        let manifest = s.media.join(format!("{}.json", info.video_id));
        let reused = video.is_file() && fs::metadata(&video).map(|m| m.len() > 0).unwrap_or(false);
        if !reused {
            send("running", 8.0, "Baixando o vídeo original...");
            let height = max_height.unwrap_or(1080);
            if height != 0 && !(144..=2160).contains(&height) { return Err("Qualidade selecionada inválida.".into()); }
            let selector = if height == 0 { "bv*+ba/b".to_string() } else { format!("bv*[height<={height}]+ba/b[height<={height}]") };
            let template = s.media.join(format!(".{}.download.%(ext)s", info.video_id));
            let out = run_ytdlp(&s, &vec!["--no-warnings".into(), "--no-playlist".into(), "--format".into(), selector,
                "--merge-output-format".into(), "mp4".into(), "--remux-video".into(), "mp4".into(),
                "--output".into(), template.to_string_lossy().into_owned(), info.url.clone()])?;
            if !out.status.success() { return Err(format!("Falha no download: {}", String::from_utf8_lossy(&out.stderr).trim())); }
            let downloaded = fs::read_dir(&s.media).map_err(|e| e.to_string())?.filter_map(Result::ok).map(|e| e.path()).find(|p| {
                p.file_name().and_then(|v| v.to_str()).is_some_and(|n| n.starts_with(&format!(".{}.download.", info.video_id))) &&
                p.extension().and_then(|v| v.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("mp4"))
            }).ok_or("O download terminou, mas o MP4 não foi encontrado em mediaShared.")?;
            fs::rename(downloaded, &video).map_err(|e| format!("Não foi possível concluir o arquivo original: {e}"))?;
        }
        // Shared owns retention and cleanup. The app only renews the seven-day lease metadata.
        let now = now_ms();
        let entry = YoutubeCacheEntry { video_id: info.video_id, title: info.title, duration_ms: info.duration_ms,
            file_path: video.to_string_lossy().into_owned(), updated_at: now, expires_at: now.saturating_add(TTL_MS), reused };
        let temp = manifest.with_extension("json.tmp");
        fs::write(&temp, serde_json::to_vec_pretty(&entry).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if manifest.exists() { fs::remove_file(&manifest).map_err(|e| e.to_string())?; }
        fs::rename(temp, manifest).map_err(|e| e.to_string())?;
        send("completed", 100.0, if reused { "Vídeo original reutilizado." } else { "Download concluído. Selecione o trecho." });
        Ok(entry)
    }).await.map_err(|e| format!("O download foi interrompido: {e}"))?
}

#[tauri::command]
pub fn list_project_media(app: AppHandle, project_id: String) -> Result<Vec<MediaAsset>, String> { read_assets(&project_dir(&app, &project_id)?) }

#[tauri::command]
pub fn import_media_files(app: AppHandle, project_id: String, paths: Vec<String>) -> Result<Vec<MediaAsset>, String> {
    if paths.len() > 100 { return Err("Importe até 100 arquivos por vez.".into()); }
    let root = project_dir(&app, &project_id)?; let mut created = Vec::new(); let mut assets = Vec::new();
    for raw in paths {
        let src = PathBuf::from(&raw).canonicalize().map_err(|e| format!("Não foi possível acessar {raw}: {e}"))?;
        if !src.is_file() { return Err("Um item selecionado não é arquivo.".into()); }
        let name = src.file_name().and_then(|v| v.to_str()).unwrap_or("media").to_string();
        let ext = src.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
        let (kind, mime) = match ext.as_str() {
            "mp4"=>("video","video/mp4"), "mov"=>("video","video/quicktime"), "mkv"=>("video","video/x-matroska"), "webm"=>("video","video/webm"),
            "mp3"=>("audio","audio/mpeg"), "wav"=>("audio","audio/wav"), "m4a"=>("audio","audio/mp4"), "aac"=>("audio","audio/aac"), "ogg"=>("audio","audio/ogg"), "flac"=>("audio","audio/flac"),
            "jpg"|"jpeg"=>("image","image/jpeg"), "png"=>("image","image/png"), "webp"=>("image","image/webp"), "gif"=>("image","image/gif"),
            _=>return Err(format!("Formato não suportado: {name}"))
        };
        let id = uuid::Uuid::new_v4().to_string(); let dest = root.join("media").join(format!("{id}.{ext}"));
        fs::copy(&src, &dest).map_err(|e| format!("Falha ao importar {name}: {e}"))?; created.push(dest.clone());
        assets.push(MediaAsset { id: id.clone(), name: name.clone(), original_name: name, kind: kind.into(), mime_type: mime.into(),
            size_bytes: fs::metadata(&dest).map_err(|e| e.to_string())?.len(), relative_path: format!("media/{id}.{ext}"),
            source: "local".into(), source_url: None, source_video_id: None, source_start_ms: None, source_end_ms: None,
            duration_ms: None, created_at: now_ms() });
    }
    if let Err(e) = append_assets(&root, &assets) { for p in created { let _ = fs::remove_file(p); } return Err(e); }
    Ok(assets)
}

#[tauri::command]
pub async fn trim_youtube_cache(app: AppHandle, project_id: String, video_id: String, start_ms: u64, end_ms: u64) -> Result<MediaAsset, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if end_ms <= start_ms || end_ms - start_ms < 300 { return Err("Selecione um trecho de pelo menos 0,3 segundo.".into()); }
        let s = shared(&app)?;
        if video_id.len() != 11 || !video_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') { return Err("ID do vídeo inválido.".into()); }
        let source = s.media.join(format!("{video_id}.mp4"));
        let canonical_root = s.media.canonicalize().map_err(|e| e.to_string())?;
        let canonical_source = source.canonicalize().map_err(|_| "Vídeo original ausente em mediaShared. Prepare-o novamente.".to_string())?;
        if !canonical_source.starts_with(&canonical_root) || !canonical_source.is_file() { return Err("Arquivo original inválido.".into()); }
        let root = project_dir(&app, &project_id)?;
        let meta = s.media.join(format!("{video_id}.json"));
        if meta.is_file() {
            let data: YoutubeCacheEntry = serde_json::from_slice(&fs::read(meta).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            if data.duration_ms.is_some_and(|duration| end_ms > duration) { return Err("O fim do trecho ultrapassa a duração do vídeo.".into()); }
        }
        let id = uuid::Uuid::new_v4().to_string(); let output = root.join("media").join(format!("{id}.mp4"));
        let result = crate::process::hidden_command(&s.ffmpeg).args(["-y","-hide_banner","-loglevel","error","-ss"])
            .arg(format!("{:.3}", start_ms as f64 / 1000.0)).arg("-i").arg(&canonical_source)
            .arg("-t").arg(format!("{:.3}", (end_ms-start_ms) as f64 / 1000.0))
            .args(["-map","0:v:0","-map","0:a?","-c:v","libx264","-preset","veryfast","-crf","20","-c:a","aac","-b:a","192k","-movflags","+faststart"])
            .arg(&output).output().map_err(|e| format!("Não foi possível iniciar FFmpeg: {e}"))?;
        if !result.status.success() { let _ = fs::remove_file(&output); return Err(format!("Falha ao criar trecho: {}", String::from_utf8_lossy(&result.stderr).trim())); }
        let size = fs::metadata(&output).map_err(|e| e.to_string())?.len();
        if size == 0 { let _ = fs::remove_file(&output); return Err("O trecho gerado está vazio.".into()); }
        let asset = MediaAsset { id: id.clone(), name: "Trecho do YouTube".into(), original_name: format!("{id}.mp4"), kind: "video".into(), mime_type: "video/mp4".into(),
            size_bytes: size, relative_path: format!("media/{id}.mp4"), source: "youtube".into(),
            source_url: Some(format!("https://www.youtube.com/watch?v={video_id}")), source_video_id: Some(video_id),
            source_start_ms: Some(start_ms), source_end_ms: Some(end_ms), duration_ms: Some(end_ms-start_ms), created_at: now_ms() };
        if let Err(e) = append_assets(&root, std::slice::from_ref(&asset)) { let _ = fs::remove_file(output); return Err(e); }
        Ok(asset)
    }).await.map_err(|e| format!("O recorte foi interrompido: {e}"))?
}


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleCue {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub words: Option<Vec<crate::transcription::TranscriptWord>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub word_alignment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub word_alignment_hash: Option<String>,
}

#[tauri::command]
pub fn open_project_media(app: AppHandle, project_id: String, asset_id: String) -> Result<String, String> {
    let root = project_dir(&app, &project_id)?;
    let assets = read_assets(&root)?;
    let asset = assets.iter().find(|item| item.id == asset_id).ok_or("Mídia não encontrada neste projeto.")?;
    if asset.kind != "video" { return Err("O editor visual está disponível para vídeos.".into()); }
    let relative = Path::new(&asset.relative_path);
    if relative.is_absolute() || relative.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
        return Err("Caminho da mídia inválido.".into());
    }
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let canonical_file = root.join(relative).canonicalize().map_err(|_| "O arquivo de vídeo não foi encontrado no projeto.".to_string())?;
    if !canonical_file.starts_with(&canonical_root) || !canonical_file.is_file() {
        return Err("O arquivo selecionado não pertence à pasta deste projeto.".into());
    }
    app.asset_protocol_scope().allow_file(&canonical_file)
        .map_err(|e| format!("Não foi possível liberar a reprodução do vídeo: {e}"))?;
    Ok(canonical_file.to_string_lossy().into_owned())
}

fn subtitle_file(app: &AppHandle, project_id: &str, asset_id: &str) -> Result<PathBuf, String> {
    if !valid_id(asset_id) { return Err("Identificador de mídia inválido.".into()); }
    let root = project_dir(app, project_id)?;
    let assets = read_assets(&root)?;
    if !assets.iter().any(|item| item.id == asset_id) { return Err("Mídia não encontrada neste projeto.".into()); }
    let dir = root.join("captions");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{asset_id}.json")))
}

#[tauri::command]
pub fn load_project_subtitles(app: AppHandle, project_id: String, asset_id: String) -> Result<Vec<SubtitleCue>, String> {
    let path = subtitle_file(&app, &project_id, &asset_id)?;
    if !path.exists() { return Ok(Vec::new()); }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() { return Ok(Vec::new()); }
    serde_json::from_str(&raw).map_err(|e| format!("Não foi possível ler as legendas salvas: {e}"))
}

#[tauri::command]
pub fn save_project_subtitles(app: AppHandle, project_id: String, asset_id: String, cues: Vec<SubtitleCue>) -> Result<(), String> {
    if cues.len() > 5000 { return Err("O projeto excede o limite de 5.000 legendas.".into()); }
    let path = subtitle_file(&app, &project_id, &asset_id)?;
    let mut previous_start = 0;
    for cue in &cues {
        if cue.id.is_empty() || cue.id.len() > 80 || cue.text.len() > 2000 || cue.end_ms <= cue.start_ms {
            return Err("Uma legenda contém dados inválidos.".into());
        }
        if cue.start_ms < previous_start { return Err("As legendas precisam estar ordenadas pelo início.".into()); }
        previous_start = cue.start_ms;
    }
    let temp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(&cues).map_err(|e| e.to_string())?;
    fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    if path.exists() { fs::remove_file(&path).map_err(|e| e.to_string())?; }
    fs::rename(temp, path).map_err(|e| e.to_string())
}


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowingBlock {
    pub cue_ids: Vec<String>,
    pub pause_duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowingSelection {
    pub selected_cue_ids: Vec<String>,
    #[serde(default)]
    pub blocks: Vec<ShadowingBlock>,
    pub source_snapshot: Vec<SubtitleCue>,
    #[serde(default)]
    pub source_signature: String,
    pub updated_at: u64,
}

fn shadowing_selection_file(app: &AppHandle, project_id: &str, asset_id: &str) -> Result<PathBuf, String> {
    if !valid_id(asset_id) { return Err("Identificador de mídia inválido.".into()); }
    let root = project_dir(app, project_id)?;
    let assets = read_assets(&root)?;
    if !assets.iter().any(|item| item.id == asset_id) { return Err("Mídia não encontrada neste projeto.".into()); }
    let dir = root.join("shadowing");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{asset_id}.json")))
}

#[tauri::command]
pub fn load_shadowing_selection(app: AppHandle, project_id: String, asset_id: String, cues: Vec<SubtitleCue>, source_signature: String) -> Result<Option<ShadowingSelection>, String> {
    let path = shadowing_selection_file(&app, &project_id, &asset_id)?;
    if !path.exists() { return Ok(None); }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() { return Ok(None); }
    let mut plan: ShadowingSelection = serde_json::from_str(&raw).map_err(|e| format!("Seleção de Shadowing inválida: {e}"))?;
    let available: std::collections::HashSet<&str> = cues.iter().map(|cue| cue.id.as_str()).collect();
    plan.selected_cue_ids.retain(|id| available.contains(id.as_str()));
    if !source_signature.is_empty() && !plan.source_signature.is_empty() && plan.source_signature != source_signature { return Ok(Some(plan)); }
    Ok(Some(plan))
}

#[tauri::command]
pub fn save_shadowing_selection(app: AppHandle, project_id: String, asset_id: String, cues: Vec<SubtitleCue>, selected_cue_ids: Vec<String>, blocks: Vec<ShadowingBlock>, source_signature: String) -> Result<(), String> {
    if cues.len() > 5000 || selected_cue_ids.is_empty() {
        return Err("Selecione ao menos um bloco e respeite o limite de 5.000 blocos.".into());
    }
    let mut seen = std::collections::HashSet::new();
    for cue in &cues {
        if !valid_id(&cue.id) || cue.text.len() > 2000 || cue.end_ms <= cue.start_ms || !seen.insert(cue.id.as_str()) {
            return Err("A transcrição contém blocos inválidos ou identificadores repetidos.".into());
        }
    }
    let available: std::collections::HashSet<&str> = cues.iter().map(|cue| cue.id.as_str()).collect();
    let mut selected_seen = std::collections::HashSet::new();
    if selected_cue_ids.iter().any(|id| !available.contains(id.as_str()) || !selected_seen.insert(id.as_str())) {
        return Err("A seleção contém um bloco inexistente ou duplicado.".into());
    }
    if blocks.is_empty() {
        return Err("Monte ao menos um bloco de prática antes de salvar.".into());
    }
    let positions: std::collections::HashMap<&str, usize> = cues.iter().enumerate().map(|(index, cue)| (cue.id.as_str(), index)).collect();
    let mut block_seen = std::collections::HashSet::new();
    let mut flattened = Vec::new();
    let mut previous_last_position: Option<usize> = None;
    for block in &blocks {
        if block.cue_ids.is_empty() || !(1_000..=30_000).contains(&block.pause_duration_ms) {
            return Err("Cada bloco precisa conter falas e uma pausa entre 1 e 30 segundos.".into());
        }
        let mut previous_position: Option<usize> = None;
        for id in &block.cue_ids {
            let position = *positions.get(id.as_str()).ok_or("Um bloco contém uma fala inexistente.")?;
            if !block_seen.insert(id.as_str()) {
                return Err("Uma fala não pode aparecer em mais de um bloco.".into());
            }
            if previous_position.is_some_and(|previous| position != previous + 1) {
                return Err("As falas mescladas precisam ser consecutivas na transcrição.".into());
            }
            previous_position = Some(position);
            flattened.push(id.clone());
        }
        if previous_last_position.is_some_and(|previous| previous >= previous_position.unwrap_or(0)) {
            return Err("Os blocos precisam respeitar a ordem da transcrição.".into());
        }
        previous_last_position = previous_position;
    }
    if flattened != selected_cue_ids {
        return Err("A seleção de falas não corresponde aos blocos de prática.".into());
    }
    let path = shadowing_selection_file(&app, &project_id, &asset_id)?;
    let plan = ShadowingSelection { selected_cue_ids, blocks, source_snapshot: cues, source_signature, updated_at: now_ms() };
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, serde_json::to_vec_pretty(&plan).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    if path.exists() { fs::remove_file(&path).map_err(|e| e.to_string())?; }
    fs::rename(temp, path).map_err(|e| e.to_string())
}

pub(crate) fn project_media_root(app: &AppHandle, project_id: &str) -> Result<PathBuf, String> {
    project_dir(app, project_id)
}

pub(crate) fn shared_ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
    let path = shared_manifest_path(app)?;
    let raw = fs::read(&path).map_err(|e| e.to_string())?;
    let config: Value = serde_json::from_slice(&raw)
        .map_err(|e| format!("shared.config.json inválido: {e}"))?;
    if config.get("schemaVersion").and_then(Value::as_str) != Some("1.0")
        || config.pointer("/shared/enabled").and_then(Value::as_bool) != Some(true) {
        return Err("O vínculo Shared Runtime está ausente, desativado ou incompatível. Sincronize o Nova Generator pelo Shared Runtime Manager.".into());
    }
    shared_resource(&config, "ffmpeg")
}
