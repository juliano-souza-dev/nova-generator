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

const PYTHON_INSTALLER_URL: &str = "https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe";
const FFMPEG_URL: &str = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
const API_URL: &str = "http://127.0.0.1:8000/api/health";

#[derive(Default)]
struct RuntimeProcesses(Arc<Mutex<Vec<Child>>>);

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

fn download(app: &AppHandle, url: &str, destination: &Path, phase: &str, start: u8, end: u8, label: &str) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut response = reqwest::blocking::Client::builder()
        .user_agent("NovaGenerator/0.1")
        .build().map_err(|e| e.to_string())?
        .get(url).send().and_then(|r| r.error_for_status())
        .map_err(|e| format!("Não foi possível baixar {label}: {e}"))?;
    let total = response.content_length().unwrap_or(0);
    let mut file = fs::File::create(destination).map_err(|e| e.to_string())?;
    let mut downloaded = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = std::io::Read::read(&mut response, &mut buffer).map_err(|e| e.to_string())?;
        if count == 0 { break; }
        file.write_all(&buffer[..count]).map_err(|e| e.to_string())?;
        downloaded += count as u64;
        if total > 0 {
            let fraction = (downloaded.saturating_mul(100) / total).min(100) as u8;
            let percent = start + ((end - start) as u16 * fraction as u16 / 100) as u8;
            progress(app, phase, &format!("{label}: {} de {} MB", downloaded / 1_048_576, total / 1_048_576), percent);
        }
    }
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

fn run_checked(executable: &Path, args: &[&str], cwd: Option<&Path>) -> Result<(), String> {
    let mut command = Command::new(executable);
    command.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(directory) = cwd { command.current_dir(directory); }
    let output = command.output().map_err(|e| format!("Não foi possível executar {}: {e}", executable.display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr.chars().rev().take(1800).collect::<String>().chars().rev().collect::<String>();
        return Err(format!("Falha ao executar {}: {detail}", executable.display()));
    }
    Ok(())
}

fn resource_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().resource_dir().map_err(|e| e.to_string())
}

fn prepare_python(app: &AppHandle, root: &Path) -> Result<PathBuf, String> {
    let python_dir = root.join("runtime/python");
    let python = python_dir.join("python.exe");
    let marker = python_dir.join(".nova-python-ready");
    let resources = resource_dir(app)?;
    let wheel_dir = resources.join("python");
    let wheel = fs::read_dir(&wheel_dir)
        .map_err(|e| format!("Pacote do backend não encontrado em {}: {e}", wheel_dir.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| path.extension().is_some_and(|extension| extension == "whl"))
        .ok_or_else(|| "O instalador não contém o pacote do backend Nova Generator.".to_string())?;
    let wheel_name = wheel.file_name().and_then(|name| name.to_str()).unwrap_or("backend.whl");
    let expected_marker = format!("python-3.12.10;{wheel_name};asr-v1");

    if !python.exists() {
        progress(app, "python", "Baixando o instalador do Python...", 5);
        let installer = root.join("downloads/python-3.12.10-amd64.exe");
        download(app, PYTHON_INSTALLER_URL, &installer, "python", 5, 14, "Python 3.12")?;
        progress(app, "python", "Instalando o Python em uma pasta privada do Nova Generator...", 15);
        fs::create_dir_all(&python_dir).map_err(|e| e.to_string())?;
        run_checked(&installer, &[
            "/quiet", "InstallAllUsers=0", "Include_launcher=0", "Include_pip=1",
            "Include_test=0", "Include_doc=0", "Include_tcltk=0", "PrependPath=0",
            "Shortcuts=0", "AssociateFiles=0",
            &format!("TargetDir={}", python_dir.display()),
        ], None)?;
    }

    let installed = fs::read_to_string(&marker).unwrap_or_default();
    if installed.trim() != expected_marker {
        progress(app, "python", "Instalando as bibliotecas do backend e reconhecimento de voz...", 28);
        run_checked(&python, &["-m", "pip", "install", "--upgrade", "pip"], None)?;
        run_checked(&python, &[
            "-m", "pip", "install", "--disable-pip-version-check",
            wheel.to_string_lossy().as_ref()
        ], None)?;
        run_checked(&python, &[
            "-m", "pip", "install", "--disable-pip-version-check",
            "faster-whisper>=1.1,<2", "av>=11,<19"
        ], None)?;
        fs::write(marker, expected_marker).map_err(|e| e.to_string())?;
    }
    Ok(python)
}

fn prepare_chatterbox(app: &AppHandle, root: &Path, python: &Path) -> Result<PathBuf, String> {
    let venv = root.join("environments/chatterbox");
    let executable = venv.join("Scripts/python.exe");
    let marker = venv.join(".nova-chatterbox-ready");
    let expected = "chatterbox-tts=0.1.7;torch=2.6.0;cpu";
    if !executable.exists() {
        progress(app, "voice", "Criando o ambiente isolado para síntese de voz...", 43);
        run_checked(python, &["-m", "venv", venv.to_string_lossy().as_ref()], None)?;
    }
    if fs::read_to_string(&marker).is_ok_and(|value| value.trim() == expected) {
        return Ok(executable);
    }

    progress(app, "voice", "Instalando PyTorch e Chatterbox Turbo...", 46);
    run_checked(&executable, &["-m", "pip", "install", "--upgrade", "pip"], None)?;
    run_checked(&executable, &[
        "-m", "pip", "install", "torch==2.6.0", "torchaudio==2.6.0",
        "--index-url", "https://download.pytorch.org/whl/cpu"
    ], None)?;
    run_checked(&executable, &[
        "-m", "pip", "install", "chatterbox-tts==0.1.7"
    ], None)?;
    run_checked(&executable, &[
        "-c", "import chatterbox.tts_turbo, torch, torchaudio"
    ], None)?;

    progress(app, "voice", "Baixando os pesos do Chatterbox Turbo...", 70);
    let hf_home = root.join("cache/huggingface");
    fs::create_dir_all(&hf_home).map_err(|e| e.to_string())?;
    let code = "from huggingface_hub import snapshot_download; from pathlib import Path; p=Path(snapshot_download(repo_id='ResembleAI/chatterbox-turbo')); assert (p/'t3_turbo_v1.safetensors').is_file(), 'checkpoint Chatterbox ausente'";
    let output = Command::new(&executable)
        .args(["-c", code])
        .env("HF_HOME", &hf_home)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Não foi possível preparar os pesos Chatterbox: {e}"))?;
    if !output.status.success() {
        return Err(format!("Falha ao baixar os pesos Chatterbox: {}", String::from_utf8_lossy(&output.stderr)));
    }
    fs::write(marker, expected).map_err(|e| e.to_string())?;
    Ok(executable)
}

fn prepare_ffmpeg(app: &AppHandle, root: &Path) -> Result<PathBuf, String> {
    let bin = root.join("tools/ffmpeg/bin");
    let ffmpeg = bin.join("ffmpeg.exe");
    let ffprobe = bin.join("ffprobe.exe");
    if ffmpeg.exists() && ffprobe.exists() { return Ok(bin); }

    progress(app, "ffmpeg", "Baixando FFmpeg e FFprobe...", 78);
    let archive = root.join("downloads/ffmpeg-release-essentials.zip");
    download(app, FFMPEG_URL, &archive, "ffmpeg", 78, 88, "FFmpeg")?;
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

fn runtime_environment(root: &Path, python: &Path, chatterbox: &Path, ffmpeg_bin: &Path) -> Vec<(String, String)> {
    let data = root.join("data");
    let database = format!("sqlite:///{}", data.join("nova-generator.db").to_string_lossy().replace('\\', "/"));
    let python_scripts = python.parent().unwrap_or(root).join("Scripts");
    let path = format!("{};{};{};{}", ffmpeg_bin.display(), python_scripts.display(), chatterbox.parent().unwrap_or(root).join("Scripts").display(), std::env::var("PATH").unwrap_or_default());
    vec![
        ("NOVA_GENERATOR_HOME".into(), root.display().to_string()),
        ("NOVA_GENERATOR_DATABASE_URL".into(), database),
        ("NOVA_GENERATOR_PROJECT_ROOT".into(), root.join("projects").display().to_string()),
        ("NOVA_GENERATOR_MEDIA_CACHE_ROOT".into(), root.join("media-cache").display().to_string()),
        ("NOVA_GENERATOR_WHISPER_MODEL_ROOT".into(), root.join("models/whisper").display().to_string()),
        ("NOVA_GENERATOR_CHATTERBOX_MODEL_ROOT".into(), root.join("models/chatterbox").display().to_string()),
        ("NOVA_GENERATOR_QWEN_MODEL_ROOT".into(), root.join("models/qwen3-tts").display().to_string()),
        ("NOVA_GENERATOR_QWEN_VENV_ROOT".into(), root.join("environments/qwen").display().to_string()),
        ("NOVA_GENERATOR_TTS_PYTHON".into(), chatterbox.display().to_string()),
        ("HF_HOME".into(), root.join("cache/huggingface").display().to_string()),
        ("TORCH_HOME".into(), root.join("cache/torch").display().to_string()),
        ("PATH".into(), path),
    ]
}

fn migrate_database(python: &Path, root: &Path, resources: &Path) -> Result<PathBuf, String> {
    let backend = root.join("backend");
    let marker = backend.join(".nova-migrations-ready");
    if !marker.exists() {
        let archive = resources.join("backend-assets.zip");
        if !archive.exists() {
            return Err("O instalador não contém as migrações do banco de dados.".into());
        }
        if backend.exists() { fs::remove_dir_all(&backend).map_err(|e| e.to_string())?; }
        extract_zip(&archive, &backend)?;
        fs::write(&marker, "bundled-migrations-v1").map_err(|e| e.to_string())?;
    }
    Ok(backend)
}

fn spawn_logged(
    executable: &Path,
    args: &[&str],
    cwd: &Path,
    envs: &[(String, String)],
    log_path: &Path,
) -> Result<Child, String> {
    if let Some(parent) = log_path.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    let log = fs::OpenOptions::new().create(true).append(true).open(log_path).map_err(|e| e.to_string())?;
    let error_log = log.try_clone().map_err(|e| e.to_string())?;
    let mut command = Command::new(executable);
    command.args(args).current_dir(cwd).stdout(Stdio::from(log)).stderr(Stdio::from(error_log));
    for (key, value) in envs { command.env(key, value); }
    command.spawn().map_err(|e| format!("Não foi possível iniciar {}: {e}", executable.display()))
}

fn backend_healthy() -> bool {
    reqwest::blocking::get(API_URL)
        .and_then(|response| response.error_for_status())
        .is_ok()
}

fn start_services(
    python: &Path,
    chatterbox: &Path,
    root: &Path,
    ffmpeg_bin: &Path,
    backend_dir: &Path,
    processes: &Arc<Mutex<Vec<Child>>>,
) -> Result<(), String> {
    let data = root.join("data");
    let logs = root.join("logs");
    fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    let envs = runtime_environment(root, python, chatterbox, ffmpeg_bin);
    let database = envs.iter().find(|(key, _)| key == "NOVA_GENERATOR_DATABASE_URL").unwrap().1.clone();
    let mut migration = Command::new(python);
    migration.args(["-m", "alembic", "-c"])
        .arg(backend_dir.join("alembic.ini"))
        .arg("upgrade").arg("head")
        .current_dir(backend_dir)
        .envs(envs.iter().cloned())
        .env("NOVA_GENERATOR_DATABASE_URL", database);
    let result = migration.output().map_err(|e| format!("Não foi possível atualizar o banco: {e}"))?;
    if !result.status.success() {
        return Err(format!("Falha ao atualizar o banco de dados: {}", String::from_utf8_lossy(&result.stderr)));
    }

    let mut children = processes.lock().map_err(|_| "Estado dos serviços indisponível.".to_string())?;
    if !backend_healthy() {
        let api = spawn_logged(
            python,
            &["-m", "uvicorn", "nova_generator.main:app", "--host", "127.0.0.1", "--port", "8000"],
            root, &envs, &logs.join("api.log")
        )?;
        children.push(api);
    }
    let worker = spawn_logged(
        python,
        &["-m", "nova_generator.worker"],
        root, &envs, &logs.join("worker.log")
    )?;
    children.push(worker);
    Ok(())
}

fn stop_processes(processes: &Arc<Mutex<Vec<Child>>>) {
    if let Ok(mut children) = processes.lock() {
        for child in children.iter_mut() { let _ = child.kill(); let _ = child.wait(); }
        children.clear();
    }
}

#[tauri::command]
async fn prepare_runtime(app: AppHandle, state: State<'_, RuntimeProcesses>) -> Result<(), String> {
    let processes = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        progress(&app, "checking", "Verificando os componentes do Nova Generator...", 2);
        let root = global_root()?;
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let resources = resource_dir(&app)?;
        let python = prepare_python(&app, &root)?;
        let chatterbox = prepare_chatterbox(&app, &root, &python)?;
        let ffmpeg = prepare_ffmpeg(&app, &root)?;
        let backend = migrate_database(&python, &root, &resources)?;
        progress(&app, "starting", "Atualizando o banco e iniciando API e worker...", 91);
        start_services(&python, &chatterbox, &root, &ffmpeg, &backend, &processes)?;
        for attempt in 0..60 {
            if backend_healthy() {
                progress(&app, "ready", "Nova Generator está pronto. A preparação do Qwen continuará em segundo plano.", 100);
                return Ok(());
            }
            if attempt == 59 { break; }
            thread::sleep(Duration::from_millis(500));
        }
        Err(format!("A API não respondeu. Consulte os registros em {}.", root.join("logs").display()))
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn stop_backend(state: State<'_, RuntimeProcesses>) {
    stop_processes(&state.0);
}

pub fn run() {
    tauri::Builder::default()
        .manage(RuntimeProcesses::default())
        .invoke_handler(tauri::generate_handler![prepare_runtime, stop_backend])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Some(state) = window.app_handle().try_state::<RuntimeProcesses>() {
                    stop_processes(&state.0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to start Nova Generator");
}
