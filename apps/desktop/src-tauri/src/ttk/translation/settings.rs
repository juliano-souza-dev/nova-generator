use crate::{shared_runtime, shared_runtime_manager};
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

/// Loads the authorized Groq provider from Nova's integrated Shared Runtime.
/// No separate Shared Runtime Manager process is required.
fn shared_provider_settings(
    app: &AppHandle,
) -> Result<shared_runtime_manager::api::ProviderRuntimeConfig, String> {
    shared_runtime::resolve_provider_settings(app, "groq")
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
    let provider = shared_provider_settings(app)?;
    Ok(provider.endpoint)
}

/// Returns the provider model configured centrally in Shared Runtime.
pub(crate) fn resolve_api_model(app: &AppHandle) -> Result<String, String> {
    let provider = shared_provider_settings(app)?;
    Ok(provider.model)
}

/// Returns the Groq key only to the native backend that needs to call the provider.
pub(crate) fn resolve_api_key(app: &AppHandle) -> Result<String, String> {
    shared_runtime::resolve_provider_credential(app, "groq")
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
    // This also verifies that Nova is authorized to use the Groq provider.
    let provider = shared_provider_settings(&app)?;

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
