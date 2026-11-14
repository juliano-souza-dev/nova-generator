use serde::Serialize;
use serde_json::Value;
use std::{fs, path::{Path, PathBuf}};
use tauri::{AppHandle, Manager};

const APPLICATION_ID: &str = "nova-generator";

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
    pub providers: Vec<SharedProviderSummary>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::<PathBuf>::new();

    if let Some(path) = std::env::var_os("NOVA_GENERATOR_SHARED_CONFIG") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(cwd) = std::env::current_dir() {
        let mut current = Some(cwd.as_path());
        while let Some(path) = current {
            candidates.push(path.join("shared.config.json"));
            current = path.parent();
        }
    }
    if let Ok(executable) = std::env::current_exe() {
        let mut current = executable.parent();
        while let Some(path) = current {
            candidates.push(path.join("shared.config.json"));
            current = path.parent();
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let mut current = Some(resource_dir.as_path());
        while let Some(path) = current {
            candidates.push(path.join("shared.config.json"));
            current = path.parent();
        }
    }

    let mut seen = std::collections::HashSet::new();
    for candidate in candidates {
        let path = if candidate.is_dir() { candidate.join("shared.config.json") } else { candidate };
        if seen.insert(path.clone()) && path.is_file() {
            return Ok(path);
        }
    }
    Err("O shared.config.json não foi encontrado. Registre ou sincronize o Nova Generator pelo Shared Runtime Manager.".into())
}

fn load_config(app: &AppHandle) -> Result<(PathBuf, Value), String> {
    let path = config_path(app)?;
    let bytes = std::fs::read(&path).map_err(|error| {
        format!("Não foi possível ler o vínculo Shared Runtime em {}: {error}", path.display())
    })?;
    let config: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("shared.config.json inválido: {error}"))?;

    if config.get("schemaVersion").and_then(Value::as_str) != Some("1.0") {
        return Err("A versão do shared.config.json não é compatível. Atualize o vínculo pelo Shared Runtime Manager.".into());
    }
    if config.pointer("/shared/enabled").and_then(Value::as_bool) != Some(true) {
        return Err("O Shared Runtime está desativado para esta aplicação.".into());
    }
    // application.id is project-owned metadata, not the Shared registry key.
    // Shared resources are resolved from this config and API authorization continues
    // to use APPLICATION_ID (the ID used when registering this app in Shared).
    Ok((path, config))
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
        providers,
    })
}


/// Resolve the isolated Qwen3-TTS runtime provisioned and owned by Shared Runtime Manager.
pub(crate) fn qwen3_tts_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let (_, config) = load_config(app)?;
    let raw = config.pointer("/shared/resources/qwen3-tts")
        .or_else(|| config.pointer("/shared/resolvedDependencies/qwen3-tts"))
        .and_then(Value::as_str)
        .ok_or("O Qwen3-TTS não está instalado ou vinculado no Shared Runtime Manager. Sincronize o Nova Generator e instale a dependência 'qwen3-tts'.")?;
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
        return Err(format!("O runtime Qwen3-TTS está incompleto em {}. Reinstale ou sincronize a dependência pelo Shared Runtime Manager.", runtime.display()));
    }
    Ok((python, runner, model))
}

/// Resolve the isolated WhisperX runtime provisioned and owned by Shared Runtime Manager.
pub(crate) fn forced_alignment_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let (_, config) = load_config(app)?;
    let runtime = config.pointer("/shared/resources/forced-alignment")
        .or_else(|| config.pointer("/shared/resolvedDependencies/forced-alignment"))
        .and_then(Value::as_str)
        .ok_or("O WhisperX não está instalado ou vinculado no Shared Runtime Manager. Instale o recurso 'forced-alignment' e sincronize o Nova Generator.")?;
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
            "O runtime do WhisperX está incompleto em {}. Reinstale ou sincronize o recurso forced-alignment pelo Shared Runtime Manager.",
            runtime.display()
        ));
    }
    Ok((python, runner))
}
