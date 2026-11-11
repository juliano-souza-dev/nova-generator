use serde::Serialize;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use zip::ZipArchive;

const PYTHON_URL: &str = "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip";
const GET_PIP_URL: &str = "https://bootstrap.pypa.io/get-pip.py";
const FFMPEG_URL: &str = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
const API_URL: &str = "http://127.0.0.1:8000/api/health";

#[derive(Default)]
struct BackendProcess(Arc<Mutex<Option<Child>>>);

#[derive(Clone, Serialize)]
struct SetupProgress {
    phase: String,
    message: String,
    percent: u8,
}

fn progress(app: &AppHandle, phase: &str, message: &str, percent: u8) {
    let _ = app.emit("nova-setup-progress", SetupProgress {
        phase: phase.into(),
        message: message.into(),
        percent,
    });
}

fn global_root() -> Result<PathBuf, String> {
    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(|p| PathBuf::from(p).join("AppData/Local")))
        .ok_or_else(|| "O Windows não informou a pasta de dados do usuário.".to_string())?;
    Ok(local.join("NovaGenerator"))
}

fn download(url: &str, destination: &Path) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut response = reqwest::blocking::Client::builder()
        .user_agent("NovaGenerator/0.1")
        .build().map_err(|e| e.to_string())?
        .get(url).send().and_then(|r| r.error_for_status())
        .map_err(|e| format!("Não foi possível baixar {url}: {e}"))?;
    let mut file = fs::File::create(destination).map_err(|e| e.to_string())?;
    std::io::copy(&mut response, &mut file).map_err(|e| e.to_string())?;
    file.flush().map_err(|e| e.to_string())
}

fn extract_zip(archive_path: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    let file = fs::File::open(archive_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        let Some(relative) = entry.enclosed_name().map(PathBuf::from) else { continue };
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = output.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut target = fs::File::create(&output).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn run_checked(executable: &Path, args: &[&str]) -> Result<(), String> {
    let output = Command::new(executable)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Não foi possível executar {}: {e}", executable.display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.chars().rev().take(1800).collect::<String>().chars().rev().collect::<String>();
        return Err(format!("Falha ao executar {}: {detail}", executable.display()));
    }
    Ok(())
}

fn prepare_python(app: &AppHandle, root: &Path) -> Result<PathBuf, String> {
    let python_dir = root.join("runtime/python");
    let python = python_dir.join("python.exe");
    let marker = python_dir.join(".nova-python-ready");
    let wheel_name = wheel.file_name().and_then(|name| name.to_str()).unwrap_or("backend.whl");
    let expected_marker = format!("python-3.12.10;{wheel_name};asr-v1");
    if python.exists()
        && fs::read_to_string(&marker).is_ok_and(|value| value.trim() == expected_marker)
    {
        return Ok(python);
    }

    if !python.exists() {
        progress(app, "python", "Baixando o Python portátil...", 8);
        let archive = root.join("downloads/python-3.12.10-embed-amd64.zip");
        download(PYTHON_URL, &archive)?;
        extract_zip(&archive, &python_dir)?;
    }

    let pth = python_dir.join("python312._pth");
    let mut pth_text = fs::read_to_string(&pth).map_err(|e| e.to_string())?;
    if !pth_text.lines().any(|line| line.trim() == "import site") {
        pth_text.push_str("\nLib\\site-packages\nimport site\n");
        fs::write(&pth, pth_text).map_err(|e| e.to_string())?;
    }

    progress(app, "python", "Preparando o instalador de bibliotecas Python...", 18);
    let get_pip = root.join("downloads/get-pip.py");
    download(GET_PIP_URL, &get_pip)?;
    run_checked(&python, &[get_pip.to_string_lossy().as_ref(), "--disable-pip-version-check"])?;
    run_checked(&python, &["-m", "pip", "install", "--upgrade", "pip"])?;

    progress(app, "python", "Instalando o backend e o reconhecimento de voz...", 35);
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let wheel_dir = resource_dir.join("python");
    let wheel = fs::read_dir(&wheel_dir)
        .map_err(|e| format!("Pacote do backend não encontrado em {}: {e}", wheel_dir.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| path.extension().is_some_and(|extension| extension == "whl"))
        .ok_or_else(|| "O instalador não contém o pacote do backend Nova Generator.".to_string())?;
    run_checked(&python, &[
        "-m", "pip", "install", "--disable-pip-version-check",
        wheel.to_string_lossy().as_ref()
    ])?;
    run_checked(&python, &[
        "-m", "pip", "install", "--disable-pip-version-check",
        "faster-whisper>=1.1,<2", "av>=11,<19"
    ])?;

    fs::write(marker, expected_marker).map_err(|e| e.to_string())?;
    Ok(python)
}

fn prepare_ffmpeg(app: &AppHandle, root: &Path) -> Result<PathBuf, String> {
    let bin = root.join("tools/ffmpeg/bin");
    let ffmpeg = bin.join("ffmpeg.exe");
    let ffprobe = bin.join("ffprobe.exe");
    if ffmpeg.exists() && ffprobe.exists() { return Ok(bin); }

    progress(app, "ffmpeg", "Baixando FFmpeg e FFprobe...", 58);
    let archive = root.join("downloads/ffmpeg-release-essentials.zip");
    download(FFMPEG_URL, &archive)?;
    let extracted = root.join("tools/ffmpeg/extracted");
    if extracted.exists() { fs::remove_dir_all(&extracted).map_err(|e| e.to_string())?; }
    extract_zip(&archive, &extracted)?;
    let mut found = None;
    for entry in walkdir::WalkDir::new(&extracted).into_iter().filter_map(Result::ok) {
        if entry.file_name() == "ffmpeg.exe" {
            let candidate = entry.path().parent().ok_or("Pasta bin do FFmpeg inválida")?.to_path_buf();
            if candidate.join("ffprobe.exe").exists() { found = Some(candidate); break; }
        }
    }
    let source = found.ok_or("O pacote baixado não contém ffmpeg.exe e ffprobe.exe.")?;
    fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    fs::copy(source.join("ffmpeg.exe"), &ffmpeg).map_err(|e| e.to_string())?;
    fs::copy(source.join("ffprobe.exe"), &ffprobe).map_err(|e| e.to_string())?;
    let _ = fs::remove_dir_all(extracted);
    Ok(bin)
}

fn backend_healthy() -> bool {
    reqwest::blocking::get(API_URL)
        .and_then(|response| response.error_for_status())
        .is_ok()
}

fn start_backend(
    python: &Path,
    root: &Path,
    ffmpeg_bin: &Path,
    process: &Arc<Mutex<Option<Child>>>,
) -> Result<(), String> {
    if backend_healthy() { return Ok(()); }
    let mut guard = process.lock().map_err(|_| "Estado do backend indisponível.".to_string())?;
    if let Some(child) = guard.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() { return Ok(()); }
    }

    let data = root.join("data");
    let logs = root.join("logs");
    fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    let log = fs::OpenOptions::new().create(true).append(true)
        .open(logs.join("backend.log")).map_err(|e| e.to_string())?;
    let error_log = log.try_clone().map_err(|e| e.to_string())?;
    let python_dir = python.parent().ok_or("Pasta do Python inválida")?;
    let scripts = python_dir.join("Scripts");
    let path = format!("{};{};{}", ffmpeg_bin.display(), scripts.display(), std::env::var("PATH").unwrap_or_default());
    let database = format!("sqlite:///{}", data.join("nova-generator.db").to_string_lossy().replace('\\', "/"));

    let child = Command::new(python)
        .args(["-m", "uvicorn", "nova_generator.main:app", "--host", "127.0.0.1", "--port", "8000"])
        .current_dir(root)
        .env("NOVA_GENERATOR_HOME", root)
        .env("NOVA_GENERATOR_DATABASE_URL", database)
        .env("NOVA_GENERATOR_PROJECT_ROOT", root.join("projects"))
        .env("NOVA_GENERATOR_MEDIA_CACHE_ROOT", root.join("media-cache"))
        .env("NOVA_GENERATOR_WHISPER_MODEL_ROOT", root.join("models/whisper"))
        .env("NOVA_GENERATOR_CHATTERBOX_MODEL_ROOT", root.join("models/chatterbox"))
        .env("NOVA_GENERATOR_QWEN_MODEL_ROOT", root.join("models/qwen3-tts"))
        .env("NOVA_GENERATOR_QWEN_VENV_ROOT", root.join("environments/qwen"))
        .env("HF_HOME", root.join("cache/huggingface"))
        .env("TORCH_HOME", root.join("cache/torch"))
        .env("PATH", path)
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(error_log))
        .spawn().map_err(|e| format!("Não foi possível iniciar o backend: {e}"))?;
    *guard = Some(child);
    Ok(())
}

#[tauri::command]
async fn prepare_runtime(app: AppHandle, state: State<'_, BackendProcess>) -> Result<(), String> {
    let process = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        progress(&app, "checking", "Verificando os componentes do Nova Generator...", 3);
        let root = global_root()?;
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let python = prepare_python(&app, &root)?;
        let ffmpeg = prepare_ffmpeg(&app, &root)?;
        progress(&app, "starting", "Iniciando os serviços do aplicativo...", 88);
        start_backend(&python, &root, &ffmpeg, &process)?;
        for attempt in 0..60 {
            if backend_healthy() {
                progress(&app, "ready", "Nova Generator está pronto.", 100);
                return Ok(());
            }
            if attempt == 59 { break; }
            thread::sleep(Duration::from_millis(500));
        }
        Err(format!("O backend não respondeu. Consulte o log em {}.", root.join("logs/backend.log").display()))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn stop_backend(state: State<'_, BackendProcess>) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut child) = guard.take() { let _ = child.kill(); let _ = child.wait(); }
    }
}

pub fn run() {
    tauri::Builder::default()
        .manage(BackendProcess::default())
        .invoke_handler(tauri::generate_handler![prepare_runtime, stop_backend])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(state) = window.app_handle().try_state::<BackendProcess>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(mut child) = guard.take() { let _ = child.kill(); let _ = child.wait(); }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to start Nova Generator");
}
