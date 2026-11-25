pub(crate) fn resolve_ffmpeg_executable(app: &tauri::AppHandle) -> Result<(std::path::PathBuf, String), String> {
    let tools = crate::media_tools::ensure_media_tools(app)?;
    Ok((tools.ffmpeg, tools.version))
}

pub(super) fn media_has_audio_stream(
    app: &tauri::AppHandle,
    _ffmpeg_path: &std::path::Path,
    media_path: &std::path::Path,
) -> Result<bool, String> {
    let tools = crate::media_tools::ensure_media_tools(app)?;
    let output = crate::process::hidden_command(&tools.ffprobe)
        .args(["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0"])
        .arg(media_path)
        .output()
        .map_err(|error| format!("Não foi possível analisar o áudio do vídeo: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "O FFprobe não conseguiu analisar {}: {}",
            media_path.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(!String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

pub(super) fn ensure_ffmpeg_capabilities(
    ffmpeg_path: &std::path::Path,
    required_filters: &[&str],
) -> Result<(), String> {
    let output = crate::process::hidden_command(ffmpeg_path)
        .args(["-hide_banner", "-filters"])
        .output()
        .map_err(|error| format!("Não foi possível consultar os filtros do FFmpeg: {error}"))?;
    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Não foi possível listar os filtros do FFmpeg: {}", details.trim()));
    }

    let listing = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let missing: Vec<&str> = required_filters.iter().copied().filter(|required| {
        !listing.lines().any(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            fields.get(1).copied() == Some(*required)
        })
    }).collect();

    if !missing.is_empty() {
        let missing_list = missing.join(", ");
        let hint = if missing.contains(&"drawtext") {
            " O filtro drawtext exige uma compilação do FFmpeg com suporte a FreeType."
        } else {
            ""
        };
        return Err(format!(
            "A instalação do FFmpeg encontrada não oferece os filtros necessários: {missing_list}.{hint}"
        ));
    }

    let encoders = crate::process::hidden_command(ffmpeg_path)
        .args(["-hide_banner", "-encoders"])
        .output()
        .map_err(|error| format!("Não foi possível consultar os encoders do FFmpeg: {error}"))?;
    let encoder_listing = format!(
        "{}\n{}",
        String::from_utf8_lossy(&encoders.stdout),
        String::from_utf8_lossy(&encoders.stderr)
    );
    let has_h264 = encoder_listing.lines().any(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        fields.get(1).copied() == Some("libx264")
    });
    if !has_h264 {
        return Err(
            "A instalação do FFmpeg não inclui o encoder libx264, necessário para exportar MP4.".into()
        );
    }

    Ok(())
}

#[tauri::command]

pub async fn check_ffmpeg(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, version) = resolve_ffmpeg_executable(&app)?;
        Ok(version)
    }).await.map_err(|error| format!("A verificação do FFmpeg foi interrompida: {error}"))?
}