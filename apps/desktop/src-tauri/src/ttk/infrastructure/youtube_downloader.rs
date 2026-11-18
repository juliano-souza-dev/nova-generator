use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::Stdio,
    sync::Arc,
    thread,
};

use serde_json::Value;

use crate::{
    domain::models::{timestamp_millis, DownloadProgress, MediaAsset, YoutubeInspection, YoutubeQuality},
    infrastructure::media_storage::MediaStorage,
};

pub struct YoutubeDownloader;

impl YoutubeDownloader {
    pub fn inspect(raw_url: &str) -> Result<YoutubeInspection, String> {
        inspect_source(raw_url)
    }

    pub fn download<F>(
        raw_url: &str,
        project_id: &str,
        max_height: Option<u32>,
        storage: &MediaStorage,
        on_progress: F,
    ) -> Result<(MediaAsset, PathBuf), String>
    where
        F: Fn(DownloadProgress) + Send + Sync + 'static,
    {
        let info = inspect_source(raw_url)?;
        let selected_height = max_height.unwrap_or(1080);
        if selected_height != 0 && !(144..=2160).contains(&selected_height) {
            return Err("Qualidade selecionada inválida.".into());
        }

        let (program, prefix) = ytdlp_command()?;
        let (id, template, final_path) = storage.create_youtube_target(project_id)?;
        let selector = if selected_height == 0 {
            "bv*+ba/b".to_string()
        } else {
            format!("bv*[height<={selected_height}]+ba/b[height<={selected_height}]")
        };

        let mut child = crate::process::hidden_command(program)
            .args(prefix)
            .args([
                "--no-warnings", "--newline", "--progress", "--progress-template",
                "download:PROGRESS:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
                "--no-playlist", "--format", &selector, "--merge-output-format", "mp4",
                "--remux-video", "mp4", "--output",
            ])
            .arg(template.to_string_lossy().to_string())
            .arg(&info.url)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Não foi possível iniciar o yt-dlp: {error}"))?;

        let progress: Arc<dyn Fn(DownloadProgress) + Send + Sync> = Arc::new(on_progress);
        let stdout = child.stdout.take().ok_or("Não foi possível ler a saída do yt-dlp.")?;
        let stdout_progress = Arc::clone(&progress);
        let stdout_project = project_id.to_string();
        let stdout_reader = thread::spawn(move || {
            for line in BufReader::new(stdout).lines().flatten() {
                emit_progress(&stdout_progress, &stdout_project, &line);
            }
        });

        let stderr = child.stderr.take().ok_or("Não foi possível ler os erros do yt-dlp.")?;
        let stderr_progress = Arc::clone(&progress);
        let stderr_project = project_id.to_string();
        let stderr_reader = thread::spawn(move || {
            let mut details = String::new();
            for line in BufReader::new(stderr).lines().flatten() {
                emit_progress(&stderr_progress, &stderr_project, &line);
                details.push_str(&line);
                details.push('\n');
            }
            details
        });

        let status = child.wait().map_err(|error| error.to_string())?;
        let _ = stdout_reader.join();
        let details = stderr_reader.join().unwrap_or_default();

        if !status.success() {
            let _ = std::fs::remove_file(&final_path);
            if details.to_ascii_lowercase().contains("ffmpeg") {
                return Err("FFmpeg não foi encontrado. Instale-o e deixe ffmpeg.exe disponível no PATH.".into());
            }
            return Err(youtube_error(&details));
        }

        let size_bytes = std::fs::metadata(&final_path)
            .map_err(|_| "O download terminou, mas o MP4 não foi encontrado. Verifique se o FFmpeg está instalado.".to_string())?
            .len();
        if size_bytes == 0 {
            let _ = std::fs::remove_file(&final_path);
            return Err("O arquivo baixado está vazio.".into());
        }

        let safe_title: String = info.title.chars()
            .map(|character| if character.is_ascii_alphanumeric() || character == '-' || character == '_' { character } else { '_' })
            .take(48)
            .collect();
        let actual_height = if selected_height == 0 {
            info.qualities.first().map(|quality| quality.height)
        } else {
            Some(selected_height)
        };

        let asset = MediaAsset {
            id: id.clone(),
            name: info.title.clone(),
            original_name: format!("{safe_title}.mp4"),
            kind: "video".into(),
            mime_type: "video/mp4".into(),
            size_bytes,
            relative_path: format!("media/{id}.mp4"),
            source: "youtube".into(),
            source_url: Some(info.url.clone()),
            duration_ms: info.duration_ms,
            width: None,
            height: actual_height,
            created_at: timestamp_millis(),
        };

        Ok((asset, final_path))
    }
}

fn emit_progress(
    callback: &Arc<dyn Fn(DownloadProgress) + Send + Sync>,
    project_id: &str,
    line: &str,
) {
    let Some(index) = line.find("PROGRESS:") else { return; };
    let fields: Vec<&str> = line[index + "PROGRESS:".len()..].split('|').collect();
    let percent = fields.first().and_then(|value|
        value.trim().trim_end_matches('%').trim().parse::<f32>().ok()
    );
    let speed = fields.get(1).map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && *value != "NA");
    let eta = fields.get(2).map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && *value != "NA");

    callback(DownloadProgress {
        project_id: project_id.to_string(),
        percent,
        speed,
        eta,
        status: "downloading".into(),
    });
}

fn normalize_youtube_url(raw: &str) -> Result<(String, String), String> {
    let candidate = raw.trim();
    if candidate.is_empty() {
        return Err("Cole um link do YouTube.".into());
    }
    let value = if candidate.contains("://") { candidate.to_string() } else { format!("https://{candidate}") };
    let parsed = url::Url::parse(&value).map_err(|_| "Link do YouTube inválido.".to_string())?;
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    let segments: Vec<&str> = parsed.path_segments().map(|segments| segments.collect()).unwrap_or_default();

    let id = if host == "youtu.be" {
        segments.first().map(|segment| (*segment).to_string())
    } else if [
        "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
        "youtube-nocookie.com", "www.youtube-nocookie.com",
    ].contains(&host.as_str()) {
        if parsed.path() == "/watch" {
            parsed.query_pairs().find(|(key, _)| key == "v").map(|(_, value)| value.into_owned())
        } else if segments.len() >= 2 && ["embed", "shorts", "live", "v"].contains(&segments[0]) {
            segments.get(1).map(|segment| (*segment).to_string())
        } else {
            None
        }
    } else {
        return Err("O link precisa ser de um vídeo do YouTube.".into());
    }.ok_or("Não foi possível identificar o vídeo neste link.")?;

    if id.len() != 11 || !id.chars().all(|character|
        character.is_ascii_alphanumeric() || character == '_' || character == '-'
    ) {
        return Err("O identificador do vídeo do YouTube é inválido.".into());
    }
    Ok((id.clone(), format!("https://www.youtube.com/watch?v={id}")))
}

fn ytdlp_command() -> Result<(String, Vec<String>), String> {
    let candidates = [
        ("yt-dlp", vec![]),
        ("yt-dlp.exe", vec![]),
        ("py", vec!["-m", "yt_dlp"]),
        ("python", vec!["-m", "yt_dlp"]),
        ("python3", vec!["-m", "yt_dlp"]),
    ];
    for (program, prefix) in candidates {
        let found = crate::process::hidden_command(program)
            .args(&prefix)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if found {
            return Ok((program.into(), prefix.into_iter().map(str::to_string).collect()));
        }
    }
    Err("yt-dlp não foi encontrado. Instale com: py -m pip install --upgrade yt-dlp".into())
}

fn youtube_error(detail: &str) -> String {
    let text = detail.to_ascii_lowercase();
    if text.contains("private") {
        "Este vídeo é privado e não pode ser importado.".into()
    } else if text.contains("members-only") || text.contains("subscriber") {
        "Este vídeo exige uma assinatura ou associação.".into()
    } else if text.contains("unavailable") || text.contains("not available") {
        "Este vídeo não está disponível ou está bloqueado nesta região.".into()
    } else if text.contains("sign in") || text.contains("login required") {
        "O YouTube exige autenticação para acessar este vídeo.".into()
    } else {
        "Não foi possível acessar o vídeo. Confira o link e tente novamente.".into()
    }
}

fn inspect_source(raw_url: &str) -> Result<YoutubeInspection, String> {
    let (video_id, canonical_url) = normalize_youtube_url(raw_url)?;
    let (program, prefix) = ytdlp_command()?;
    let output = crate::process::hidden_command(program)
        .args(prefix)
        .args([
            "--dump-single-json", "--skip-download", "--no-playlist",
            "--no-warnings", "--socket-timeout", "20",
        ])
        .arg(&canonical_url)
        .output()
        .map_err(|error| format!("Não foi possível consultar o YouTube: {error}"))?;

    if !output.status.success() {
        return Err(youtube_error(&String::from_utf8_lossy(&output.stderr)));
    }
    let data: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Metadados retornados pelo yt-dlp são inválidos.".to_string())?;
    if data.get("id").and_then(Value::as_str) != Some(video_id.as_str()) {
        return Err("O YouTube retornou um vídeo diferente do link informado.".into());
    }

    let title = data.get("title").and_then(Value::as_str).unwrap_or("").trim();
    if title.is_empty() {
        return Err("Não foi possível identificar o título do vídeo.".into());
    }
    let channel = data.get("channel").or_else(|| data.get("uploader"))
        .and_then(Value::as_str).map(str::to_string);
    let duration_ms = data.get("duration").and_then(Value::as_f64)
        .map(|seconds| (seconds * 1000.0) as u64);
    let thumbnail = data.get("thumbnail").and_then(Value::as_str).map(str::to_string);

    let mut heights = std::collections::BTreeSet::new();
    if let Some(formats) = data.get("formats").and_then(Value::as_array) {
        for format in formats {
            let has_video = format.get("vcodec").and_then(Value::as_str)
                .map(|codec| codec != "none").unwrap_or(false);
            if has_video {
                if let Some(height) = format.get("height").and_then(Value::as_u64) {
                    if height > 0 && height <= 2160 {
                        heights.insert(height as u32);
                    }
                }
            }
        }
    }
    let qualities = heights.into_iter().rev().map(|height| YoutubeQuality {
        height,
        label: format!("{height}p"),
    }).collect();

    Ok(YoutubeInspection {
        video_id,
        url: canonical_url,
        title: title.chars().take(255).collect(),
        channel,
        duration_ms,
        thumbnail,
        qualities,
    })
}

#[cfg(test)]
mod tests {
    use super::normalize_youtube_url;

    #[test]
    fn accepts_watch_short_and_shorts_urls() {
        let id = "abcdefghijk";
        for url in [
            format!("https://youtube.com/watch?v={id}"),
            format!("https://youtu.be/{id}"),
            format!("https://youtube.com/shorts/{id}"),
        ] {
            assert_eq!(normalize_youtube_url(&url).unwrap().0, id);
        }
    }

    #[test]
    fn rejects_untrusted_hosts() {
        assert!(normalize_youtube_url("https://example.com/watch?v=abcdefghijk").is_err());
    }

    #[test]
    fn rejects_invalid_video_ids() {
        assert!(normalize_youtube_url("https://youtu.be/short").is_err());
    }
}
