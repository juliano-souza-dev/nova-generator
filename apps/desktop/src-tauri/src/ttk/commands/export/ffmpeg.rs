pub(crate) fn resolve_ffmpeg_executable() -> Result<(std::path::PathBuf, String), String> {
    use std::{collections::HashSet, path::PathBuf};

    let executable_name = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    let mut candidates: Vec<PathBuf> = Vec::new();

    // Primeiro, respeita o PATH recebido pelo processo do FrameLab.
    if let Some(path_value) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path_value).map(|directory| directory.join(executable_name)));
    }

    // O WinGet disponibiliza aliases nesta pasta. Ela pode não estar no PATH
    // herdado quando o aplicativo é iniciado pelo menu Iniciar/atalho.
    if cfg!(windows) {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            candidates.push(PathBuf::from(local_app_data)
                .join("Microsoft").join("WinGet").join("Links").join(executable_name));
        }
        if let Some(user_profile) = std::env::var_os("USERPROFILE") {
            candidates.push(PathBuf::from(user_profile)
                .join("AppData").join("Local").join("Microsoft")
                .join("WinGet").join("Links").join(executable_name));
        }
    }

    let mut checked = HashSet::new();
    let mut failures: Vec<String> = Vec::new();

    for candidate in candidates {
        if !checked.insert(candidate.clone()) || !candidate.is_file() {
            continue;
        }

        match crate::process::hidden_command(&candidate).arg("-version").output() {
            Ok(output) if output.status.success() => {
                let version = String::from_utf8_lossy(&output.stdout)
                    .lines().next().unwrap_or("FFmpeg disponível").to_string();
                return Ok((candidate, version));
            }
            Ok(output) => {
                failures.push(format!("{} (código de saída: {})",
                    candidate.display(), output.status));
            }
            Err(error) => {
                failures.push(format!("{} ({error})", candidate.display()));
            }
        }
    }

    let details = if failures.is_empty() {
        "Nenhum ffmpeg.exe válido foi encontrado nos diretórios do PATH ou no alias conhecido do WinGet.".to_string()
    } else {
        format!("Executáveis encontrados, mas que não iniciaram corretamente: {}", failures.join("; "))
    };
    Err(format!(
        "Não foi possível localizar e iniciar o FFmpeg. Verifique a instalação ou o PATH do Windows. {details}"
    ))
}

pub(super) fn media_has_audio_stream(ffmpeg_path: &std::path::Path, media_path: &std::path::Path) -> Result<bool, String> {
    let probe_name = if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" };
    let sibling = ffmpeg_path.parent().map(|directory| directory.join(probe_name));
    let mut candidates = Vec::new();
    if let Some(path) = sibling { candidates.push(path); }
    if let Some(path_value) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path_value).map(|directory| directory.join(probe_name)));
    }
    let probe = candidates.into_iter().find(|candidate| candidate.is_file())
        .ok_or_else(|| "Não foi possível localizar o ffprobe ao lado do FFmpeg. Instale a distribuição completa do FFmpeg para incluir o áudio original dos vídeos.".to_string())?;
    let output = crate::process::hidden_command(probe)
        .args(["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0"])
        .arg(media_path)
        .output()
        .map_err(|error| format!("Não foi possível analisar o áudio do vídeo: {error}"))?;
    if !output.status.success() {
        return Err(format!("O ffprobe não conseguiu analisar {}: {}", media_path.display(), String::from_utf8_lossy(&output.stderr).trim()));
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

pub async fn check_ffmpeg() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let (_, version) = resolve_ffmpeg_executable()?;
        Ok(version)
    }).await.map_err(|error| format!("A verificação do FFmpeg foi interrompida: {error}"))?
}