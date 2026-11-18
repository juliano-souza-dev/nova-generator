use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use crate::{
    domain::models::YoutubeInspection,
    infrastructure::youtube_downloader::YoutubeDownloader,
};

const TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeCacheEntry {
    pub video_id: String,
    pub title: String,
    pub duration_ms: Option<u64>,
    pub file_path: String,
    pub last_attempt_at: u64,
    pub expires_at: u64,
}

#[derive(Clone)]
pub struct YoutubeCache {
    root: Option<PathBuf>,
    operation_lock: Arc<Mutex<()>>,
}

impl YoutubeCache {
    /// The directory is supplied by Shared Runtime through shared.directories.mediaShared.
    /// None means the application is not linked to a valid Shared Runtime configuration.
    pub fn new(root: Option<PathBuf>) -> Self {
        Self {
            root,
            operation_lock: Arc::new(Mutex::new(())),
        }
    }

    fn root(&self) -> Result<&Path, String> {
        self.root.as_deref().ok_or_else(|| {
            "O Shared Runtime não forneceu shared.directories.mediaShared. Registre ou sincronize esta aplicação no Shared Runtime Manager.".to_string()
        })
    }

    pub fn lock(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.operation_lock
            .lock()
            .map_err(|_| "O cache compartilhado do YouTube está indisponível.".to_string())
    }

    pub fn cleanup_expired(&self) -> Result<(), String> {
        if self.root.is_none() {
            return Ok(());
        }
        let _guard = self.lock()?;
        self.cleanup_expired_locked()
    }

    fn cleanup_expired_locked(&self) -> Result<(), String> {
        let root = self.root()?;
        fs::create_dir_all(root).map_err(|e| {
            format!("Não foi possível acessar mediaShared ({}): {e}", root.display())
        })?;

        let now = now_ms();
        for item in fs::read_dir(root).map_err(|e| e.to_string())? {
            let item = item.map_err(|e| e.to_string())?;
            let path = item.path();
            if !item.file_type().map_err(|e| e.to_string())?.is_file()
                || path.extension().and_then(|value| value.to_str()) != Some("json")
            {
                continue;
            }

            let Ok(raw) = fs::read_to_string(&path) else { continue };
            let Ok(entry) = serde_json::from_str::<YoutubeCacheEntry>(&raw) else { continue };
            let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else { continue };
            if stem != entry.video_id || !is_valid_video_id(stem) || entry.expires_at > now {
                continue;
            }

            // Each video is a flat <videoId>.mp4 file with a <videoId>.json lease.
            let video = root.join(format!("{stem}.mp4"));
            if video.is_file() {
                fs::remove_file(&video).map_err(|e| {
                    format!("Não foi possível remover o vídeo expirado {}: {e}", video.display())
                })?;
            }
            fs::remove_file(&path).map_err(|e| {
                format!("Não foi possível remover o registro expirado {}: {e}", path.display())
            })?;
        }
        Ok(())
    }

    pub fn prepare(&self, url: &str, max_height: u32) -> Result<YoutubeCacheEntry, String> {
        let _guard = self.lock()?;
        self.cleanup_expired_locked()?;

        let root = self.root()?;
        let video_id = extract_video_id(url)?;
        fs::create_dir_all(root).map_err(|e| {
            format!("Não foi possível criar/acessar o diretório mediaShared ({}): {e}", root.display())
        })?;

        let video = root.join(format!("{video_id}.mp4"));
        let metadata = root.join(format!("{video_id}.json"));
        let now = now_ms();

        if video.is_file() && fs::metadata(&video).map(|m| m.len() > 0).unwrap_or(false) {
            if let Ok(raw) = fs::read_to_string(&metadata) {
                if let Ok(mut cached) = serde_json::from_str::<YoutubeCacheEntry>(&raw) {
                    if cached.video_id == video_id && cached.expires_at > now {
                        cached.file_path = video.to_string_lossy().into_owned();
                        cached.last_attempt_at = now;
                        cached.expires_at = now.saturating_add(TTL_MS);
                        write_manifest(&metadata, &cached)?;
                        return Ok(cached);
                    }
                }
            }
        }

        let info = YoutubeDownloader::inspect(url)?;
        if info.video_id != video_id {
            return Err("O YouTube retornou um identificador diferente do link informado.".into());
        }

        // Write the lease before downloading so interrupted downloads can be cleaned
        // by the same seven-day expiration policy on a later cache access.
        let pending = entry_from(&info, &video, now);
        write_manifest(&metadata, &pending)?;

        let (program, prefix) = ytdlp_command()?;
        let selector = if max_height == 0 {
            "bv*+ba/b".to_string()
        } else {
            format!("bv*[height<={max_height}]+ba/b[height<={max_height}]")
        };
        let output_template = root.join(format!(".{video_id}.download.%(ext)s"));
        let output = crate::process::hidden_command(program)
            .args(prefix)
            .args([
                "--no-warnings",
                "--no-playlist",
                "--format",
                &selector,
                "--merge-output-format",
                "mp4",
                "--remux-video",
                "mp4",
                "--output",
            ])
            .arg(output_template.to_string_lossy().to_string())
            .arg(&info.url)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .map_err(|e| format!("Não foi possível iniciar o yt-dlp: {e}"))?;

        if !output.status.success() {
            return Err(format!(
                "Falha no download do YouTube: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }

        let downloaded = fs::read_dir(root)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|name| name.starts_with(&format!(".{video_id}.download.")))
                    && path.extension().and_then(|value| value.to_str())
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("mp4"))
            })
            .ok_or("O download terminou, mas o MP4 não foi encontrado em mediaShared.")?;

        if video.exists() {
            fs::remove_file(&video).map_err(|e| e.to_string())?;
        }
        fs::rename(&downloaded, &video).map_err(|e| e.to_string())?;

        let entry = entry_from(&info, &video, now);
        write_manifest(&metadata, &entry)?;
        Ok(entry)
    }

    pub fn validate_entry(&self, video_id: &str) -> Result<YoutubeCacheEntry, String> {
        if !is_valid_video_id(video_id) {
            return Err("Identificador de vídeo inválido.".into());
        }

        let root = self.root()?;
        let canonical_root = root
            .canonicalize()
            .map_err(|e| format!("O diretório mediaShared não está disponível: {e}"))?;
        let video = root.join(format!("{video_id}.mp4"));
        let canonical_video = video
            .canonicalize()
            .map_err(|_| "O vídeo não está mais no cache compartilhado. Prepare-o novamente.".to_string())?;

        if !canonical_video.starts_with(&canonical_root) || !canonical_video.is_file() {
            return Err("Caminho do vídeo no cache compartilhado é inválido.".into());
        }

        let metadata = root.join(format!("{video_id}.json"));
        let raw = fs::read_to_string(&metadata)
            .map_err(|_| "Dados de retenção do cache compartilhado não encontrados.".to_string())?;
        let mut entry: YoutubeCacheEntry =
            serde_json::from_str(&raw).map_err(|e| format!("Registro do cache inválido: {e}"))?;

        if entry.video_id != video_id {
            return Err("O registro do cache não corresponde ao ID do vídeo.".into());
        }
        if entry.expires_at <= now_ms() {
            return Err("O cache deste vídeo expirou. Prepare-o novamente.".into());
        }

        // Renew the seven-day lease whenever a cached video is consumed.
        let now = now_ms();
        entry.file_path = canonical_video.to_string_lossy().into_owned();
        entry.last_attempt_at = now;
        entry.expires_at = now.saturating_add(TTL_MS);
        write_manifest(&metadata, &entry)?;

        Ok(entry)
    }
}

fn is_valid_video_id(value: &str) -> bool {
    value.len() == 11
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '-')
}

fn extract_video_id(raw: &str) -> Result<String, String> {
    let candidate = raw.trim();
    let value = if candidate.contains("://") {
        candidate.to_string()
    } else {
        format!("https://{candidate}")
    };
    let parsed = url::Url::parse(&value).map_err(|_| "Link do YouTube inválido.".to_string())?;
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    let segments: Vec<&str> = parsed.path_segments().map(|parts| parts.collect()).unwrap_or_default();

    let id = if host == "youtu.be" {
        segments.first().map(|value| (*value).to_string())
    } else if [
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "music.youtube.com",
        "youtube-nocookie.com",
        "www.youtube-nocookie.com",
    ]
    .contains(&host.as_str())
    {
        if parsed.path() == "/watch" {
            parsed.query_pairs()
                .find(|(key, _)| key == "v")
                .map(|(_, value)| value.into_owned())
        } else if segments.len() >= 2 && ["embed", "shorts", "live", "v"].contains(&segments[0]) {
            segments.get(1).map(|value| (*value).to_string())
        } else {
            None
        }
    } else {
        return Err("O link precisa ser de um vídeo do YouTube.".into());
    }
    .ok_or("Não foi possível identificar o vídeo neste link.")?;

    if !is_valid_video_id(&id) {
        return Err("O identificador do vídeo do YouTube é inválido.".into());
    }
    Ok(id)
}

fn entry_from(info: &YoutubeInspection, path: &Path, now: u64) -> YoutubeCacheEntry {
    YoutubeCacheEntry {
        video_id: info.video_id.clone(),
        title: info.title.clone(),
        duration_ms: info.duration_ms,
        file_path: path.to_string_lossy().into_owned(),
        last_attempt_at: now,
        expires_at: now.saturating_add(TTL_MS),
    }
}

fn write_manifest(path: &Path, entry: &YoutubeCacheEntry) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(entry).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    fs::rename(temporary, path).map_err(|e| e.to_string())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn ytdlp_command() -> Result<(String, Vec<String>), String> {
    for (program, prefix) in [
        ("yt-dlp", vec![]),
        ("yt-dlp.exe", vec![]),
        ("py", vec!["-m", "yt_dlp"]),
        ("python", vec!["-m", "yt_dlp"]),
        ("python3", vec!["-m", "yt_dlp"]),
    ] {
        if crate::process::hidden_command(program)
            .args(&prefix)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
        {
            return Ok((program.into(), prefix.into_iter().map(str::to_string).collect()));
        }
    }
    Err("yt-dlp não foi encontrado. Instale com: py -m pip install --upgrade yt-dlp".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_ttl_is_seven_days() {
        assert_eq!(TTL_MS, 604_800_000);
        let now = 1000;
        let entry = YoutubeCacheEntry {
            video_id: "abcdefghijk".into(),
            title: "x".into(),
            duration_ms: None,
            file_path: "x".into(),
            last_attempt_at: now,
            expires_at: now + TTL_MS,
        };
        assert_eq!(entry.expires_at - entry.last_attempt_at, 7 * 24 * 60 * 60 * 1000);
    }

    #[test]
    fn video_ids_are_safe_for_shared_file_names() {
        assert!(is_valid_video_id("dQw4w9WgXcQ"));
        assert!(!is_valid_video_id("../secret"));
        assert!(!is_valid_video_id("short"));
    }
}
