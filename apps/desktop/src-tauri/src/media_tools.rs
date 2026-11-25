use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

const RELEASE_VERSION_URL: &str = "https://www.gyan.dev/ffmpeg/builds/release-version";
const ARCHIVE_URL: &str = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
const CHECKSUM_URL: &str = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256";
const USER_AGENT: &str = "JulianoDev-NovaGenerator/1.0";
const LOCK_WAIT: Duration = Duration::from_secs(1800);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceManifest {
    schema_version: u32,
    id: String,
    version: String,
    source: String,
    sha256: String,
    install_path: String,
    ffmpeg_path: String,
    ffprobe_path: String,
    installed_at: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct MediaTools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub version: String,
}

struct InstallLock(PathBuf);
impl Drop for InstallLock {
    fn drop(&mut self) { let _ = fs::remove_file(&self.0); }
}

fn resource_root() -> Result<PathBuf, String> {
    #[cfg(windows)]
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or("O Windows não informou LOCALAPPDATA.")?;
    #[cfg(not(windows))]
    let base = dirs::data_local_dir().ok_or("Não foi possível localizar o diretório de dados do usuário.")?;
    Ok(base.join("JulianoDev").join("NovaGenerator").join("Resources"))
}

fn hidden_command(path: &Path) -> Command {
    let mut command = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

fn valid_executable(path: &Path) -> Option<String> {
    if !path.is_file() { return None; }
    let output = hidden_command(path).arg("-version").output().ok()?;
    if !output.status.success() { return None; }
    let version = String::from_utf8_lossy(&output.stdout).lines().next()?.trim().to_owned();
    if version.is_empty() { None } else { Some(version) }
}

fn read_manifest(root: &Path) -> Option<ResourceManifest> {
    let path = root.join("registry").join("ffmpeg.json");
    let manifest: ResourceManifest = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let ffmpeg = PathBuf::from(&manifest.ffmpeg_path);
    let ffprobe = PathBuf::from(&manifest.ffprobe_path);
    let managed_root = root.join("tools").join("ffmpeg");
    let install_path = PathBuf::from(&manifest.install_path);
    if manifest.schema_version != 1 || manifest.id != "ffmpeg" ||
        !install_path.starts_with(&managed_root) ||
        !ffmpeg.starts_with(&install_path) || !ffprobe.starts_with(&install_path) ||
        ffmpeg.parent() != ffprobe.parent() ||
        valid_executable(&ffmpeg).is_none() || valid_executable(&ffprobe).is_none() {
        return None;
    }
    Some(manifest)
}

fn acquire_lock(root: &Path) -> Result<InstallLock, String> {
    let lock_path = root.join("registry").join("ffmpeg-install.lock");
    let started = Instant::now();
    loop {
        match OpenOptions::new().write(true).create_new(true).open(&lock_path) {
            Ok(mut file) => {
                let _ = writeln!(file, "pid={}", std::process::id());
                return Ok(InstallLock(lock_path));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let stale = fs::metadata(&lock_path).and_then(|metadata| metadata.modified())
                    .ok().and_then(|modified| modified.elapsed().ok())
                    .is_some_and(|age| age >= LOCK_WAIT);
                if stale {
                    let _ = fs::remove_file(&lock_path);
                    continue;
                }
                if started.elapsed() >= LOCK_WAIT {
                    return Err("A instalação do FFmpeg continua ocupada. Feche outra tarefa que esteja preparando recursos e tente novamente.".into());
                }
                thread::sleep(Duration::from_millis(500));
            }
            Err(error) => return Err(format!("Não foi possível reservar a instalação do FFmpeg: {error}")),
        }
    }
}

fn emit_progress(app: &AppHandle, percent: f64, message: &str) {
    let _ = app.emit("resource-install-progress", serde_json::json!({
        "resourceId": "ffmpeg",
        "percent": percent.clamp(0.0, 100.0),
        "message": message
    }));
}

fn download_to(url: &str, destination: &Path) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let client = reqwest::blocking::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(900))
        .build().map_err(|e| format!("Não foi possível preparar o download: {e}"))?;
    let mut response = client.get(url).send()
        .map_err(|e| format!("Falha ao baixar {url}: {e}"))?
        .error_for_status().map_err(|e| format!("Download recusado por {url}: {e}"))?;
    let temporary = destination.with_extension("part");
    let mut output = File::create(&temporary).map_err(|e| e.to_string())?;
    std::io::copy(&mut response, &mut output).map_err(|e| format!("Download incompleto: {e}"))?;
    output.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&temporary, destination).map_err(|e| format!("Não foi possível concluir o arquivo baixado: {e}"))?;
    Ok(())
}

fn sha256(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 { break; }
        hasher.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn expected_sha256(text: &str) -> Result<String, String> {
    let hash = text.split_whitespace().find(|part| part.len() == 64 && part.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or("O servidor não forneceu um SHA-256 válido para o pacote FFmpeg.")?;
    Ok(hash.to_ascii_lowercase())
}

fn download_verified_archive(root: &Path, app: &AppHandle) -> Result<(PathBuf, String), String> {
    let cache = root.join("cache").join("ffmpeg-release-essentials.zip");
    let checksum_file = root.join("cache").join("ffmpeg-release-essentials.zip.sha256");
    emit_progress(app, 5.0, "Consultando a versão e a integridade do pacote FFmpeg");
    let client = reqwest::blocking::Client::builder().user_agent(USER_AGENT)
        .timeout(Duration::from_secs(60)).build().map_err(|e| e.to_string())?;
    let version = client.get(RELEASE_VERSION_URL).send().map_err(|e| format!("Não foi possível consultar a versão do FFmpeg: {e}"))?
        .error_for_status().map_err(|e| e.to_string())?.text().map_err(|e| e.to_string())?.trim().to_owned();
    if version.is_empty() || version.len() > 40 || !version.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
        return Err("O servidor retornou uma versão inválida do FFmpeg.".into());
    }
    let checksum_text = client.get(CHECKSUM_URL).send().map_err(|e| format!("Não foi possível obter o SHA-256 do FFmpeg: {e}"))?
        .error_for_status().map_err(|e| e.to_string())?.text().map_err(|e| e.to_string())?;
    let expected = expected_sha256(&checksum_text)?;
    let cached_valid = cache.is_file() && sha256(&cache).map(|value| value == expected).unwrap_or(false);
    if !cached_valid {
        if cache.exists() { fs::remove_file(&cache).map_err(|e| e.to_string())?; }
        emit_progress(app, 10.0, "Baixando o pacote completo do FFmpeg");
        download_to(ARCHIVE_URL, &cache)?;
    }
    let actual = sha256(&cache)?;
    if actual != expected {
        let _ = fs::remove_file(&cache);
        return Err("A verificação SHA-256 do FFmpeg falhou. O pacote foi descartado e a instalação foi interrompida.".into());
    }
    fs::write(&checksum_file, format!("{expected}  ffmpeg-release-essentials.zip\n")).map_err(|e| e.to_string())?;
    Ok((cache, version))
}

fn extract_archive(archive: &Path, staging: &Path) -> Result<(PathBuf, PathBuf), String> {
    let file = File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("O pacote FFmpeg não é um ZIP válido: {e}"))?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|e| e.to_string())?;
        let relative = entry.enclosed_name()
            .ok_or("O pacote FFmpeg contém um caminho de arquivo inseguro.")?;
        let target = staging.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = target.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
            let mut output = File::create(&target).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut output).map_err(|e| e.to_string())?;
        }
    }
    fn find(root: &Path, name: &str) -> Result<Option<PathBuf>, String> {
        if !root.is_dir() { return Ok(None); }
        for item in fs::read_dir(root).map_err(|e| e.to_string())? {
            let path = item.map_err(|e| e.to_string())?.path();
            if path.is_dir() {
                if let Some(found) = find(&path, name)? { return Ok(Some(found)); }
            } else if path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.eq_ignore_ascii_case(name)) {
                return Ok(Some(path));
            }
        }
        Ok(None)
    }
    let ffmpeg = find(staging, if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" })?
        .ok_or("O pacote baixado não contém o executável FFmpeg.")?;
    let ffprobe = find(staging, if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" })?
        .ok_or("O pacote baixado não contém o executável FFprobe.")?;
    if ffmpeg.parent() != ffprobe.parent() {
        return Err("FFmpeg e FFprobe não vieram da mesma distribuição. A instalação foi rejeitada.".into());
    }
    Ok((ffmpeg, ffprobe))
}

fn write_manifest(root: &Path, manifest: &ResourceManifest) -> Result<(), String> {
    let directory = root.join("registry");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let target = directory.join("ffmpeg.json");
    let temporary = directory.join("ffmpeg.json.tmp");
    let bytes = serde_json::to_vec_pretty(manifest).map_err(|e| e.to_string())?;
    let mut file = File::create(&temporary).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    let backup = directory.join("ffmpeg.json.previous");
    if backup.exists() { fs::remove_file(&backup).map_err(|e| e.to_string())?; }
    if target.exists() {
        fs::rename(&target, &backup).map_err(|e| format!("Não foi possível preservar o registro anterior do FFmpeg: {e}"))?;
    }
    if let Err(error) = fs::rename(&temporary, &target) {
        if backup.exists() { let _ = fs::rename(&backup, &target); }
        return Err(format!("Não foi possível registrar o FFmpeg: {error}"));
    }
    if backup.exists() { let _ = fs::remove_file(backup); }
    Ok(())
}

pub(crate) fn ensure_media_tools(app: &AppHandle) -> Result<MediaTools, String> {
    let root = resource_root()?;
    for directory in ["registry", "cache", "tools"] {
        fs::create_dir_all(root.join(directory)).map_err(|e| format!("Não foi possível preparar o armazenamento de recursos do Nova: {e}"))?;
    }
    if let Some(manifest) = read_manifest(&root) {
        return Ok(MediaTools {
            ffmpeg: PathBuf::from(manifest.ffmpeg_path),
            ffprobe: PathBuf::from(manifest.ffprobe_path),
            version: manifest.version,
        });
    }

    let _lock = acquire_lock(&root)?;
    if let Some(manifest) = read_manifest(&root) {
        return Ok(MediaTools {
            ffmpeg: PathBuf::from(manifest.ffmpeg_path),
            ffprobe: PathBuf::from(manifest.ffprobe_path),
            version: manifest.version,
        });
    }

    #[cfg(not(windows))]
    {
        let _ = app;
        return Err("O provisionamento automático do FFmpeg está disponível para Windows nesta versão. Instale FFmpeg e FFprobe pelo gerenciador do sistema.".into());
    }

    #[cfg(windows)]
    {
        emit_progress(app, 2.0, "Preparando o armazenamento de recursos do Nova");
        let (archive, version) = download_verified_archive(&root, app)?;
        let destination = root.join("tools").join("ffmpeg").join(&version);
        let parent = destination.parent().ok_or("Diretório de instalação inválido.")?;
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let staging = parent.join(format!(".staging-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
        emit_progress(app, 75.0, "Extraindo a distribuição completa do FFmpeg e FFprobe");
        let extracted = extract_archive(&archive, &staging);
        let (staged_ffmpeg, staged_ffprobe) = match extracted {
            Ok(paths) => paths,
            Err(error) => { let _ = fs::remove_dir_all(&staging); return Err(error); }
        };
        let Some(staged_version) = valid_executable(&staged_ffmpeg) else {
            let _ = fs::remove_dir_all(&staging);
            return Err("O FFmpeg extraído não passou na validação de inicialização.".into());
        };
        if valid_executable(&staged_ffprobe).is_none() {
            let _ = fs::remove_dir_all(&staging);
            return Err("O FFprobe extraído não passou na validação de inicialização.".into());
        }
        let relative_ffmpeg = staged_ffmpeg.strip_prefix(&staging).map_err(|e| e.to_string())?;
        let relative_ffprobe = staged_ffprobe.strip_prefix(&staging).map_err(|e| e.to_string())?;
        let final_ffmpeg = destination.join(relative_ffmpeg);
        let final_ffprobe = destination.join(relative_ffprobe);

        let backup = parent.join(format!(".backup-{}", uuid::Uuid::new_v4()));
        if destination.exists() {
            fs::rename(&destination, &backup).map_err(|e| format!("Não foi possível preservar a instalação anterior do FFmpeg: {e}"))?;
        }
        if let Err(error) = fs::rename(&staging, &destination) {
            if backup.exists() { let _ = fs::rename(&backup, &destination); }
            let _ = fs::remove_dir_all(&staging);
            return Err(format!("Não foi possível ativar a nova instalação do FFmpeg: {error}"));
        }
        if backup.exists() { let _ = fs::remove_dir_all(&backup); }

        if valid_executable(&final_ffmpeg).is_none() || valid_executable(&final_ffprobe).is_none() {
            return Err("A instalação ativada do FFmpeg não passou na validação final. A próxima execução tentará reparar o pacote.".into());
        }
        let checksum = sha256(&archive)?;
        let installed_at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        let manifest = ResourceManifest {
            schema_version: 1,
            id: "ffmpeg".into(),
            version: format!("{version} ({staged_version})"),
            source: ARCHIVE_URL.into(),
            sha256: checksum,
            install_path: destination.display().to_string(),
            ffmpeg_path: final_ffmpeg.display().to_string(),
            ffprobe_path: final_ffprobe.display().to_string(),
            installed_at,
        };
        write_manifest(&root, &manifest)?;
        emit_progress(app, 100.0, "FFmpeg e FFprobe instalados e validados");
        Ok(MediaTools { ffmpeg: final_ffmpeg, ffprobe: final_ffprobe, version: manifest.version })
    }
}
