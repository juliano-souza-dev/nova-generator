use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const DEFAULT_MODEL: &str = "llama-3.3-70b-versatile";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroqSettings {
    pub configured: bool,
    /// The model is owned by Shared Runtime and is read-only in this application.
    pub model: String,
    pub max_chunk_chars: usize,
    pub max_cues_per_chunk: usize,
    pub delay_ms: u64,
    pub target_language: String,
}

impl Default for GroqSettings {
    fn default() -> Self {
        Self {
            configured: false,
            model: DEFAULT_MODEL.into(),
            max_chunk_chars: 7000,
            max_cues_per_chunk: 25,
            delay_ms: 1800,
            target_language: "Português brasileiro".into(),
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("groq-settings.json"))
}

/// Finds the local Shared Runtime config without requiring the manager process to be running.
fn shared_manifest(app: &AppHandle) -> Result<Option<(PathBuf, serde_json::Value)>, String> {
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
        let path = if candidate.is_dir() {
            candidate.join("shared.config.json")
        } else {
            candidate
        };
        if !seen.insert(path.clone()) || !path.is_file() {
            continue;
        }

        let raw = std::fs::read(&path).map_err(|error| {
            format!(
                "Não foi possível ler o vínculo Shared Runtime em {}: {error}",
                path.display()
            )
        })?;
        let manifest: serde_json::Value = serde_json::from_slice(&raw).map_err(|error| {
            format!(
                "Manifesto Shared Runtime inválido em {}: {error}",
                path.display()
            )
        })?;

        if manifest.get("schemaVersion").and_then(|value| value.as_str()) != Some("1.0") {
            return Err(
                "A versão do shared.config.json não é compatível. Atualize o vínculo pelo Shared Runtime Manager."
                    .into(),
            );
        }
        if manifest
            .pointer("/shared/enabled")
            .and_then(|value| value.as_bool())
            != Some(true)
        {
            return Err("O Shared Runtime está desativado para esta aplicação.".into());
        }

        return Ok(Some((path, manifest)));
    }

    Ok(None)
}

/// Loads the authorized Groq provider from this application's own Shared config.
/// The Shared Runtime Manager does not need to be open.
fn shared_provider_settings(
    app: &AppHandle,
) -> Result<(PathBuf, String, shared_runtime_manager::api::ProviderRuntimeConfig), String> {
    let (config_path, manifest) = shared_manifest(app)?.ok_or_else(|| {
        "O shared.config.json não foi encontrado. Registre o TTK Creator no Shared Runtime Manager."
            .to_string()
    })?;

    let app_id = manifest
        .pointer("/application/id")
        .and_then(|value| value.as_str())
        .ok_or("O manifesto Shared Runtime não identifica esta aplicação.")?
        .to_owned();

    let provider = shared_runtime_manager::api::get_provider_settings_from_config(
        &config_path,
        &app_id,
        "groq",
    )
    .map_err(|error| {
        format!(
            "Não foi possível carregar a configuração autorizada da Groq pelo Shared Runtime: {error}"
        )
    })?;

    Ok((config_path, app_id, provider))
}

fn read_settings(app: &AppHandle) -> Result<GroqSettings, String> {
    let path = settings_path(app)?;
    let mut settings = if path.exists() {
        serde_json::from_slice::<GroqSettings>(&std::fs::read(path).map_err(|e| e.to_string())?)
            .unwrap_or_default()
    } else {
        GroqSettings::default()
    };

    settings.configured = true;
    settings.model = resolve_api_model(app)?;
    Ok(settings)
}

/// Returns the provider's configured base endpoint to the native backend.
pub(crate) fn resolve_api_endpoint(app: &AppHandle) -> Result<String, String> {
    let (_, _, provider) = shared_provider_settings(app)?;
    Ok(provider.endpoint)
}

/// Returns the provider model configured centrally in Shared Runtime.
pub(crate) fn resolve_api_model(app: &AppHandle) -> Result<String, String> {
    let (_, _, provider) = shared_provider_settings(app)?;
    Ok(provider.model)
}

/// Returns the Groq key only to the native backend that needs to call the provider.
pub(crate) fn resolve_api_key(app: &AppHandle) -> Result<String, String> {
    let (config_path, app_id, _) = shared_provider_settings(app)?;
    shared_runtime_manager::api::get_provider_credential_from_config(
        &config_path,
        &app_id,
        "groq",
    )
    .map_err(|error| {
        format!(
            "Não foi possível descriptografar a credencial da Groq provisionada pelo Shared Runtime: {error}"
        )
    })
}

#[tauri::command]
pub fn get_groq_settings(app: AppHandle) -> Result<GroqSettings, String> {
    read_settings(&app)
}

#[tauri::command]
pub fn save_groq_settings(
    app: AppHandle,
    max_chunk_chars: usize,
    max_cues_per_chunk: usize,
    delay_ms: u64,
    target_language: String,
) -> Result<GroqSettings, String> {
    // This also verifies that the application is authorized and that a Groq
    // provider entry is present in its own shared.config.json.
    let (_, _, provider) = shared_provider_settings(&app)?;

    let settings = GroqSettings {
        configured: true,
        model: provider.model,
        max_chunk_chars: max_chunk_chars.clamp(1000, 18000),
        max_cues_per_chunk: max_cues_per_chunk.clamp(1, 60),
        delay_ms: delay_ms.clamp(0, 15000),
        target_language: if target_language.trim().is_empty() {
            "Português brasileiro".into()
        } else {
            target_language.trim().chars().take(80).collect()
        },
    };

    let path = settings_path(&app)?;
    std::fs::write(
        path,
        serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    Ok(settings)
}
