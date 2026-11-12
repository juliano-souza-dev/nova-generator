use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, path::{Path, PathBuf}, process::Command, time::{SystemTime, UNIX_EPOCH}};
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
fn run_ytdlp(s: &Shared, args: &[String]) -> Result<std::process::Output, String> {
    let mut cmd = Command::new(&s.ytdlp); cmd.args(args);
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
#[derive(Serialize)]
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
        let result = Command::new(&s.ffmpeg).args(["-y","-hide_banner","-loglevel","error","-ss"])
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
