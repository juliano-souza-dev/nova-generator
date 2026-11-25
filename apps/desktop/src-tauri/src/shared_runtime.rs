use crate::shared_runtime_manager;
use serde::Serialize;
use serde_json::Value;
use std::{fs, path::{Path, PathBuf}, sync::atomic::{AtomicBool, Ordering}};
use tauri::{AppHandle, Manager};

const APPLICATION_ID: &str = "nova-generator";

static DEPENDENCY_SYNC_RUNNING: AtomicBool = AtomicBool::new(false);

fn ensure_nova_registration(app: &AppHandle) -> Result<PathBuf, String> {
    let app_root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&app_root).map_err(|e| e.to_string())?;
    let example = app_root.join("libs-example.json");
    if !example.is_file() {
        fs::write(&example, include_str!("../../../../libs-example.json"))
            .map_err(|e| format!("Não foi possível preparar libs-example.json: {e}"))?;
    }
    shared_runtime_manager::manager::register_app_at_path(
        APPLICATION_ID,
        "Nova Generator",
        &app_root.to_string_lossy(),
    ).map_err(|e| format!("Não foi possível preparar o ambiente do Nova Generator: {e:#}"))?;
    Ok(app_root)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedDependencySummary {
    pub id: String,
    pub required: bool,
    pub version: Option<String>,
    pub installed: bool,
    pub path: Option<String>,
}

#[tauri::command]
pub fn get_shared_settings(app: AppHandle) -> Result<Value, String> {
    ensure_nova_registration(&app)?;
    let example: Value = serde_json::from_str(include_str!("../../../../libs-example.json"))
        .map_err(|e| format!("libs-example.json inválido: {e}"))?;
    let installed = shared_runtime_manager::manager::resources()
        .map_err(|e| format!("Não foi possível listar dependências instaladas: {e:#}"))?;
    let dependencies: Vec<SharedDependencySummary> = example.pointer("/shared/dependencies")
        .and_then(Value::as_array).into_iter().flatten().filter_map(|entry| {
            let id = entry.get("id")?.as_str()?.to_owned();
            let resource = installed.iter().find(|item| item.id == id);
            Some(SharedDependencySummary {
                id,
                required: entry.get("required").and_then(Value::as_bool).unwrap_or(true),
                version: entry.get("version").and_then(Value::as_str).map(str::to_owned),
                installed: resource.is_some(),
                path: resource.map(|item| item.install_path.clone()),
            })
        }).collect();
    let providers = shared_runtime_manager::api::providers()
        .map_err(|e| format!("Não foi possível listar provedores de API: {e:#}"))?;
    let catalog = shared_runtime_manager::api::provider_catalog()
        .map_err(|e| format!("Não foi possível carregar o catálogo de provedores: {e:#}"))?;
    let voices = shared_runtime_manager::voices::list()
        .map_err(|e| format!("Não foi possível carregar a biblioteca de vozes: {e:#}"))?;
    let queue = shared_runtime_manager::dependency_queue::status()
        .map_err(|e| format!("Não foi possível consultar a fila de dependências: {e:#}"))?;
    let root = shared_runtime_manager::manager::root().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "root": root.to_string_lossy(),
        "dependencies": dependencies,
        "providers": providers,
        "providerCatalog": catalog,
        "voices": voices,
        "queue": queue
    }))
}

#[tauri::command]
pub fn synchronize_shared_dependencies(app: AppHandle) -> Result<(), String> {
    let app_root = ensure_nova_registration(&app)?;
    if DEPENDENCY_SYNC_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("A sincronização de dependências já está em andamento.".into());
    }
    if let Err(error) = shared_runtime_manager::dependency_queue::enqueue_application(
        APPLICATION_ID,
        &app_root.to_string_lossy(),
    ) {
        DEPENDENCY_SYNC_RUNNING.store(false, Ordering::SeqCst);
        return Err(format!("Não foi possível preparar a sincronização: {error:#}"));
    }
    shared_runtime_manager::dependency_queue::begin_operation();
    std::thread::spawn(|| {
        if let Err(error) = shared_runtime_manager::dependency_queue::process_queue() {
            if shared_runtime_manager::dependency_queue::cancel_requested() {
                let _ = shared_runtime_manager::dependency_queue::mark_cancelled();
            } else {
                let _ = shared_runtime_manager::dependency_queue::set_failure(&format!("{error:#}"));
            }
        }
        DEPENDENCY_SYNC_RUNNING.store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[tauri::command]
pub fn shared_dependency_queue_status() -> Result<Value, String> {
    shared_runtime_manager::dependency_queue::status().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn list_shared_voices() -> Result<Value, String> {
    shared_runtime_manager::voices::list().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn set_shared_default_voice(voice_id: String) -> Result<(), String> {
    shared_runtime_manager::voices::set_default(&voice_id).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn create_shared_voice_profile(name: String, filename: String, audio_base64: String, reference_text: String) -> Result<(), String> {
    if DEPENDENCY_SYNC_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("Já existe uma operação do ambiente em andamento.".into());
    }
    shared_runtime_manager::dependency_queue::begin_operation();
    std::thread::spawn(move || {
        let result = shared_runtime_manager::voices::create_profile(&name, &filename, &audio_base64, &reference_text);
        if let Err(error) = result {
            let _ = shared_runtime_manager::dependency_queue::set_failure(&format!("{error:#}"));
        }
        DEPENDENCY_SYNC_RUNNING.store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[tauri::command]
pub fn create_shared_voice_design_profile(name: String, instruct: String) -> Result<(), String> {
    if DEPENDENCY_SYNC_RUNNING.swap(true, Ordering::SeqCst) {
        return Err("Já existe uma operação do ambiente em andamento.".into());
    }
    shared_runtime_manager::dependency_queue::begin_operation();
    std::thread::spawn(move || {
        let result = shared_runtime_manager::voices::create_voice_design_profile(&name, &instruct);
        if let Err(error) = result {
            let _ = shared_runtime_manager::dependency_queue::set_failure(&format!("{error:#}"));
        }
        DEPENDENCY_SYNC_RUNNING.store(false, Ordering::SeqCst);
    });
    Ok(())
}

#[tauri::command]
pub fn shared_provider_catalog() -> Result<Value, String> {
    shared_runtime_manager::api::provider_catalog().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn shared_api_providers() -> Result<Vec<shared_runtime_manager::api::ProviderInfo>, String> {
    shared_runtime_manager::api::providers().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn save_shared_api_provider(provider: String, name: String, endpoint: String, model: String) -> Result<(), String> {
    shared_runtime_manager::api::add(&provider, &name, &endpoint, &model).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn save_shared_api_key(provider: String, secret: String) -> Result<(), String> {
    shared_runtime_manager::api::set_key(&provider, &secret).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn authorize_shared_api_provider(provider: String) -> Result<(), String> {
    shared_runtime_manager::api::authorize(&provider, APPLICATION_ID).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn revoke_shared_api_provider(provider: String) -> Result<(), String> {
    shared_runtime_manager::api::revoke(&provider, APPLICATION_ID).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn shared_available_api_models(provider: String) -> Result<Vec<String>, String> {
    shared_runtime_manager::api::available_models(&provider).map_err(|e| format!("{e:#}"))
}


#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedVoiceSummary {
    pub id: String,
    pub name: String,
    pub mode: String,
}

#[derive(Debug, Clone)]
pub(crate) struct VoiceProfileRuntime {
    pub name: String,
    pub python: PathBuf,
    pub runner: PathBuf,
    pub model: PathBuf,
    pub profile: PathBuf,
    pub mode: String,
    pub instruct: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedProviderSummary {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedRuntimeStatus {
    pub configured: bool,
    pub application_id: String,
    pub media_shared_path: String,
    pub media_shared_ready: bool,
    pub forced_alignment_path: Option<String>,
    pub forced_alignment_python_path: Option<String>,
    pub forced_alignment_runner_path: Option<String>,
    pub forced_alignment_ready: bool,
    pub qwen3_tts_path: Option<String>,
    pub qwen3_tts_ready: bool,
    pub default_voice_id: Option<String>,
    pub voices: Vec<SharedVoiceSummary>,
    pub voice_cloning_ready: bool,
    pub providers: Vec<SharedProviderSummary>,
}

fn config_path(_app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::<PathBuf>::new();

    if let Some(path) = std::env::var_os("SHARED_RUNTIME_CONFIG")
        .or_else(|| std::env::var_os("NOVA_GENERATOR_SHARED_CONFIG"))
    {
        candidates.push(PathBuf::from(path));
    }

    // Every registered application reads its generated configuration from the
    // same per-user Shared Runtime environment. The project source folder and
    // executable location are deliberately not used as configuration stores.
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("JulianoDev")
                .join("SharedRuntime")
                .join("applications")
                .join(APPLICATION_ID)
                .join("libs.json"),
        );
    }

    let mut seen = std::collections::HashSet::new();
    for candidate in candidates {
        let path = if candidate.is_dir() { candidate.join("libs.json") } else { candidate };
        if seen.insert(path.clone()) && path.is_file() {
            return Ok(path);
        }
    }
    Err("O libs.json não foi encontrado. Registre ou sincronize o Nova Generator pelo Nova Generator.".into())
}

fn load_config(app: &AppHandle) -> Result<(PathBuf, Value), String> {
    let path = config_path(app)?;
    let bytes = std::fs::read(&path).map_err(|error| {
        format!("Não foi possível ler o vínculo Shared Runtime em {}: {error}", path.display())
    })?;
    let config: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("libs.json inválido: {error}"))?;

    if config.get("schemaVersion").and_then(Value::as_str) != Some("1.0") {
        return Err("A versão do libs.json não é compatível. Atualize o vínculo pelo Nova Generator.".into());
    }
    if config.pointer("/shared/enabled").and_then(Value::as_bool) != Some(true) {
        return Err("O Shared Runtime está desativado para esta aplicação.".into());
    }
    // application.id is project-owned metadata, not the Shared registry key.
    // Shared resources are resolved from this config and API authorization continues
    // to use APPLICATION_ID (the ID used when registering this app in Shared).
    Ok((path, config))
}

/// Resolves the media cache directory from the Nova application's integrated Shared Runtime config.
pub(crate) fn resolve_media_shared_directory(app: &AppHandle) -> Result<PathBuf, String> {
    ensure_nova_registration(app)?;
    let (_, config) = load_config(app)?;
    let raw = config.pointer("/shared/directories/mediaShared")
        .and_then(Value::as_str)
        .ok_or("A biblioteca compartilhada de mídia não foi configurada. Abra Configurações > Biblioteca de dependências e sincronize o ambiente.")?;
    let directory = PathBuf::from(raw);
    if !directory.is_absolute() {
        return Err("O caminho da biblioteca compartilhada de mídia precisa ser absoluto.".into());
    }
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Não foi possível preparar a biblioteca compartilhada de mídia: {error}"))?;
    Ok(directory)
}

/// Resolves the shared media directory and executables from Nova's own libs.json.
/// Registration is performed lazily so media features work even before Settings is opened.
pub(crate) fn resolve_media_runtime(
    app: &AppHandle,
) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let media = resolve_media_shared_directory(app)?;
    let (_, config) = load_config(app)?;

    Ok((media, resolve_media_tool_from_config(&config, "yt-dlp")?, resolve_media_tool_from_config(&config, "ffmpeg")?))
}

/// Resolve um executável pelo caminho registrado no libs.json do Shared Runtime.
pub(crate) fn resolve_media_tool(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    ensure_nova_registration(app)?;
    let (_, config) = load_config(app)?;
    resolve_media_tool_from_config(&config, id)
}

fn resolve_media_tool_from_config(config: &Value, id: &str) -> Result<PathBuf, String> {
    let raw = config.pointer(&format!("/shared/resolvedDependencies/{id}"))
        .or_else(|| config.pointer(&format!("/shared/resources/{id}")))
        .and_then(Value::as_str)
        .ok_or_else(|| format!("A dependência '{id}' ainda não foi instalada. Acesse Configurações > Biblioteca de dependências e sincronize o ambiente."))?;
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(format!("O caminho da dependência '{id}' precisa ser absoluto."));
    }
    if path.is_file() {
        return Ok(path);
    }
    let names = if cfg!(windows) {
        vec![format!("{id}.exe"), format!("{id}.cmd"), format!("{id}.bat")]
    } else {
        vec![id.to_owned()]
    };
    names.into_iter().map(|name| path.join(name))
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| format!("Executável '{id}' não encontrado em {}. Sincronize novamente as dependências.", path.display()))
}
}

fn provider_settings(
    path: &Path,
    provider_id: &str,
) -> Result<shared_runtime_manager::api::ProviderRuntimeConfig, String> {
    shared_runtime_manager::api::get_provider_settings_from_config(path, APPLICATION_ID, provider_id)
        .map_err(|error| format!("Não foi possível carregar o provedor '{provider_id}' pelo Shared Runtime: {error}"))
}

/// Resolve the centrally authorized provider endpoint and model for native consumers.
pub(crate) fn resolve_provider_settings(
    app: &AppHandle,
    provider_id: &str,
) -> Result<shared_runtime_manager::api::ProviderRuntimeConfig, String> {
    let (path, _) = load_config(app)?;
    provider_settings(&path, provider_id)
}

/// Decrypts a provider credential only inside the native backend. Never expose this value to React.
pub(crate) fn resolve_provider_credential(app: &AppHandle, provider_id: &str) -> Result<String, String> {
    let (path, _) = load_config(app)?;
    shared_runtime_manager::api::get_provider_credential_from_config(&path, APPLICATION_ID, provider_id)
        .map_err(|error| format!("Não foi possível descriptografar a credencial de '{provider_id}' pelo Shared Runtime: {error}"))
}

#[tauri::command]
pub fn get_shared_runtime_status(app: AppHandle) -> Result<SharedRuntimeStatus, String> {
    ensure_nova_registration(&app)?;
    let (path, config) = load_config(&app)?;
    let media_shared = config.pointer("/shared/directories/mediaShared")
        .and_then(Value::as_str)
        .ok_or("O Shared Runtime não forneceu shared.directories.mediaShared. Sincronize o vínculo desta aplicação.")?;
    let media_path = PathBuf::from(media_shared);
    if !media_path.is_absolute() {
        return Err("shared.directories.mediaShared precisa conter um caminho absoluto.".into());
    }

    let alignment_runtime = config.pointer("/shared/resources/forced-alignment")
        .or_else(|| config.pointer("/shared/resolvedDependencies/forced-alignment"))
        .and_then(Value::as_str).map(PathBuf::from);
    if let Some(runtime) = alignment_runtime.as_ref() {
        if !runtime.is_absolute() {
            return Err("shared.resources.forced-alignment precisa conter um caminho absoluto.".into());
        }
    }
    let alignment_python = alignment_runtime.as_ref().map(|runtime| {
        if cfg!(windows) { runtime.join("venv").join("Scripts").join("python.exe") }
        else { runtime.join("venv").join("bin").join("python") }
    });
    let alignment_runner = alignment_runtime.as_ref().map(|runtime| runtime.join("runner.py"));
    let alignment_ready = alignment_python.as_ref().is_some_and(|python| python.is_file())
        && alignment_runner.as_ref().is_some_and(|runner| runner.is_file());

    let qwen_runtime = config.pointer("/shared/resources/qwen3-tts")
        .or_else(|| config.pointer("/shared/resolvedDependencies/qwen3-tts"))
        .and_then(Value::as_str).map(PathBuf::from);
    let qwen3_tts_ready = qwen_runtime.as_ref().is_some_and(|runtime| {
        let python = if cfg!(windows) { runtime.join("venv").join("Scripts").join("python.exe") } else { runtime.join("venv").join("bin").join("python") };
        let runner = runtime.join("runner.py");
        let manifest = fs::read(runtime.join("runtime.json")).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        let model = manifest.as_ref().and_then(|value| value.get("model")).and_then(Value::as_str).map(PathBuf::from);
        python.is_file() && runner.is_file() && model.as_ref().is_some_and(|path| path.join("config.json").is_file())
    });

    let (configured_default_voice_id, configured_voices) = voice_profiles_from_config(&config)?;
    // Only expose profiles whose executor, model and prepared prompt are present.
    let voices: Vec<SharedVoiceSummary> = configured_voices.into_iter()
        .filter_map(|voice| {
            let runtime = voice_profile_runtime(&config, &voice.id).ok()?;
            Some(SharedVoiceSummary { mode: runtime.mode, ..voice })
        })
        .collect();
    let default_voice_id = configured_default_voice_id
        .filter(|id| voices.iter().any(|voice| &voice.id == id));
    let voice_cloning_ready = !voices.is_empty();

    let providers = shared_runtime_manager::api::get_authorized_providers_from_config(&path, APPLICATION_ID)
        .map_err(|error| format!("Não foi possível ler os provedores autorizados pelo Shared Runtime: {error}"))?
        .into_iter()
        .map(|provider| SharedProviderSummary {
            id: provider.id,
            name: provider.name,
            endpoint: provider.endpoint,
            model: provider.model,
        })
        .collect();

    Ok(SharedRuntimeStatus {
        configured: true,
        application_id: APPLICATION_ID.into(),
        media_shared_ready: media_path.is_dir(),
        media_shared_path: media_path.to_string_lossy().into_owned(),
        forced_alignment_path: alignment_runtime.map(|value| value.to_string_lossy().into_owned()),
        forced_alignment_python_path: alignment_python.map(|value| value.to_string_lossy().into_owned()),
        forced_alignment_runner_path: alignment_runner.map(|value| value.to_string_lossy().into_owned()),
        forced_alignment_ready: alignment_ready,
        qwen3_tts_path: qwen_runtime.map(|value| value.to_string_lossy().into_owned()),
        qwen3_tts_ready,
        default_voice_id,
        voices,
        voice_cloning_ready,
        providers,
    })
}



/// Read voice names and the default selection from the Shared-owned voice catalog.
fn voice_profiles_from_config(config: &Value) -> Result<(Option<String>, Vec<SharedVoiceSummary>), String> {
    let Some(voices) = config.pointer("/shared/voices") else {
        // Older Shared installations may not have published the voice catalog yet.
        // Keep existing media/alignment features available and expose an empty list.
        return Ok((None, Vec::new()));
    };
    let default_voice_id = voices.get("default").and_then(Value::as_str).map(str::to_owned);
    let entries = voices.get("available").and_then(Value::as_array)
        .ok_or("O catálogo shared.voices.available está ausente ou inválido.")?;
    let mut available = Vec::with_capacity(entries.len());
    let mut seen = std::collections::HashSet::new();
    for entry in entries {
        let id = entry.get("id").and_then(Value::as_str).ok_or("Um perfil de voz não possui identificador.")?;
        let name = entry.get("name").and_then(Value::as_str).ok_or("Um perfil de voz não possui nome.")?;
        if id.trim().is_empty() || name.trim().is_empty() || !seen.insert(id.to_owned()) {
            return Err("O catálogo de vozes contém identificadores ou nomes inválidos/duplicados.".into());
        }
        let mode = if entry.get("model_id").and_then(Value::as_str) == Some("Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign") {
            "voice_design"
        } else {
            "voice_clone"
        };
        available.push(SharedVoiceSummary { id: id.to_owned(), name: name.to_owned(), mode: mode.into() });
    }
    if default_voice_id.as_ref().is_some_and(|id| !seen.contains(id)) {
        return Err("A voz padrão informada pelo Shared não existe no catálogo disponível.".into());
    }
    Ok((default_voice_id, available))
}

fn voice_profile_runtime(config: &Value, voice_id: &str) -> Result<VoiceProfileRuntime, String> {
    if voice_id.trim().is_empty() {
        return Err("Selecione uma voz da Biblioteca do Shared Runtime.".into());
    }
    let (_, available) = voice_profiles_from_config(config)?;
    let entries = config.pointer("/shared/voices/available").and_then(Value::as_array)
        .ok_or("O catálogo de vozes do Shared está indisponível.")?;
    let entry = entries.iter().find(|entry| entry.get("id").and_then(Value::as_str) == Some(voice_id))
        .ok_or_else(|| format!("A voz '{voice_id}' não está disponível neste computador. Atualize a Biblioteca de vozes no Nova Generator."))?;
    let name = available.iter().find(|voice| voice.id == voice_id).map(|voice| voice.name.clone())
        .ok_or("Não foi possível identificar o nome da voz selecionada.")?;
    let required_path = |field: &str| -> Result<PathBuf, String> {
        let raw = entry.get(field).and_then(Value::as_str)
            .ok_or_else(|| format!("O perfil '{name}' não informa o caminho '{field}'."))?;
        let path = PathBuf::from(raw);
        if !path.is_absolute() {
            return Err(format!("O caminho '{field}' do perfil '{name}' precisa ser absoluto."));
        }
        Ok(path)
    };
    let python = required_path("python")?;
    let runner = required_path("runner")?;
    let model = required_path("model_path")?;
    let profile = required_path("profile_path")?;
    let model_id = entry.get("model_id").and_then(Value::as_str).unwrap_or("Qwen/Qwen3-TTS-12Hz-1.7B-Base");
    let (mode, instruct) = if model_id == "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign" {
        let instruction = entry.get("instruct").and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
            .or_else(|| fs::read_to_string(profile.join("voice_design_instruct.txt")).ok())
            .ok_or_else(|| format!("O perfil VoiceDesign '{name}' não contém a descrição da voz. Abra o Nova Generator e prepare novamente esse perfil."))?;
        if !profile.join("voice_design_instruct.txt").is_file() {
            return Err(format!("O perfil VoiceDesign '{name}' está incompleto. Abra o Nova Generator e prepare novamente essa voz."));
        }
        ("voice_design".to_owned(), Some(instruction))
    } else {
        if !profile.join("voice_clone_prompt.pt").is_file() {
            return Err(format!("O perfil Base '{name}' está incompleto. Abra o Nova Generator e prepare novamente essa voz."));
        }
        ("voice_clone".to_owned(), None)
    };
    if !python.is_file() || !runner.is_file() || !model.join("config.json").is_file() {
        return Err(format!("O perfil '{name}' está incompleto. Abra o Nova Generator e prepare novamente essa voz."));
    }
    Ok(VoiceProfileRuntime { name, python, runner, model, profile, mode, instruct })
}

/// Resolve the executable and model information for either Qwen3-TTS Base cloning or VoiceDesign. 
pub(crate) fn voice_profile_runtime_for_app(app: &AppHandle, voice_id: &str) -> Result<VoiceProfileRuntime, String> {
    let (_, config) = load_config(app)?;
    voice_profile_runtime(&config, voice_id)
}

/// Backward-compatible path resolver for Base voice-cloning integrations.
pub(crate) fn voice_profile_paths(app: &AppHandle, voice_id: &str) -> Result<(PathBuf, PathBuf, PathBuf, PathBuf, String), String> {
    let voice = voice_profile_runtime_for_app(app, voice_id)?;
    if voice.mode != "voice_clone" {
        return Err("Este perfil usa VoiceDesign. Atualize a integração de síntese do Nova Generator.".into());
    }
    Ok((voice.python, voice.runner, voice.model, voice.profile, voice.name))
}

/// Resolve the isolated Qwen3-TTS runtime provisioned and owned by Nova Generator.
pub(crate) fn qwen3_tts_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let (_, config) = load_config(app)?;
    let raw = config.pointer("/shared/resources/qwen3-tts")
        .or_else(|| config.pointer("/shared/resolvedDependencies/qwen3-tts"))
        .and_then(Value::as_str)
        .ok_or("O Qwen3-TTS não está instalado ou vinculado no Nova Generator. Sincronize o Nova Generator e instale a dependência 'qwen3-tts'.")?;
    let runtime = PathBuf::from(raw);
    if !runtime.is_absolute() { return Err("O caminho do Qwen3-TTS no Shared Runtime precisa ser absoluto.".into()); }
    let python = if cfg!(windows) { runtime.join("venv").join("Scripts").join("python.exe") } else { runtime.join("venv").join("bin").join("python") };
    let runner = runtime.join("runner.py");
    let manifest_path = runtime.join("runtime.json");
    let manifest: Value = serde_json::from_slice(&fs::read(&manifest_path).map_err(|e| format!("Manifesto Qwen3-TTS indisponível: {e}"))?)
        .map_err(|e| format!("Manifesto Qwen3-TTS inválido: {e}"))?;
    let model = manifest.get("model").and_then(Value::as_str).map(PathBuf::from)
        .ok_or("O manifesto Qwen3-TTS não informa o caminho do modelo.")?;
    if !python.is_file() || !runner.is_file() || !model.join("config.json").is_file() {
        return Err(format!("O runtime Qwen3-TTS está incompleto em {}. Reinstale ou sincronize a dependência pelo Nova Generator.", runtime.display()));
    }
    Ok((python, runner, model))
}

/// Resolve the isolated WhisperX runtime provisioned and owned by Nova Generator.
pub(crate) fn forced_alignment_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let (_, config) = load_config(app)?;
    let runtime = config.pointer("/shared/resources/forced-alignment")
        .or_else(|| config.pointer("/shared/resolvedDependencies/forced-alignment"))
        .and_then(Value::as_str)
        .ok_or("O WhisperX não está instalado ou vinculado no Nova Generator. Instale o recurso 'forced-alignment' e sincronize o Nova Generator.")?;
    let runtime = PathBuf::from(runtime);
    if !runtime.is_absolute() {
        return Err("O caminho do WhisperX no Shared Runtime precisa ser absoluto.".into());
    }
    let python = if cfg!(windows) {
        runtime.join("venv").join("Scripts").join("python.exe")
    } else {
        runtime.join("venv").join("bin").join("python")
    };
    let runner = runtime.join("runner.py");
    if !python.is_file() || !runner.is_file() {
        return Err(format!(
            "O runtime do WhisperX está incompleto em {}. Reinstale ou sincronize o recurso forced-alignment pelo Nova Generator.",
            runtime.display()
        ));
    }
    Ok((python, runner))
}
