use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, time::Duration};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationCue {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
struct TranslationItem { id: String, text: String }
#[derive(Debug, Deserialize)]
struct TranslationPayload { translations: Vec<TranslationItem> }
#[derive(Debug, Deserialize)]
struct ChatResponse { choices: Vec<ChatChoice> }
#[derive(Debug, Deserialize)]
struct ChatChoice { message: ChatMessage }
#[derive(Debug, Deserialize)]
struct ChatMessage { content: String }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress { project_id: String, stage: String, percent: f32, completed_chunks: usize, total_chunks: usize, message: String }

fn emit(app: &AppHandle, project_id: &str, stage: &str, percent: f32, done: usize, total: usize, message: &str) {
    let _ = app.emit("translation-progress", Progress {
        project_id: project_id.into(), stage: stage.into(), percent: percent.clamp(0.0, 100.0),
        completed_chunks: done, total_chunks: total, message: message.into(),
    });
}

fn translation_file(app: &AppHandle, project_id: &str, asset_id: &str) -> Result<PathBuf, String> {
    if asset_id.is_empty() || asset_id.len() > 64 || !asset_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Identificador de mídia inválido.".into());
    }
    let assets = crate::media::list_project_media(app.clone(), project_id.to_string())?;
    if !assets.iter().any(|asset| asset.id == asset_id) {
        return Err("Mídia não encontrada neste projeto.".into());
    }
    let dir = crate::media::project_media_root(app, project_id)?.join("translations");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{asset_id}.json")))
}

fn atomic_write(path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    if path.exists() { fs::remove_file(path).map_err(|e| e.to_string())?; }
    fs::rename(temp, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_project_translations(app: AppHandle, project_id: String, asset_id: String) -> Result<Vec<TranslationCue>, String> {
    let path = translation_file(&app, &project_id, &asset_id)?;
    if !path.exists() { return Ok(Vec::new()); }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() { return Ok(Vec::new()); }
    serde_json::from_str(&raw).map_err(|e| format!("Não foi possível ler as traduções salvas: {e}"))
}

#[tauri::command]
pub fn save_project_translations(app: AppHandle, project_id: String, asset_id: String, translations: Vec<TranslationCue>) -> Result<(), String> {
    if translations.len() > 5000 { return Err("O projeto excede o limite de 5.000 traduções.".into()); }
    let path = translation_file(&app, &project_id, &asset_id)?;
    let mut previous_start = 0;
    for cue in &translations {
        if cue.id.is_empty() || cue.id.len() > 80 || cue.text.len() > 4000 || cue.end_ms <= cue.start_ms {
            return Err("Uma tradução contém dados inválidos.".into());
        }
        if cue.start_ms < previous_start { return Err("As traduções precisam estar ordenadas pelo início.".into()); }
        previous_start = cue.start_ms;
    }
    let bytes = serde_json::to_vec_pretty(&translations).map_err(|e| e.to_string())?;
    atomic_write(&path, &bytes)
}

fn translate_batch(app: &AppHandle, model: &str, key: &str, endpoint: &str, context: &str, batch: &[crate::media::SubtitleCue]) -> Result<Vec<TranslationItem>, String> {
    let targets = batch.iter().map(|cue| serde_json::json!({"id":cue.id,"text":cue.text})).collect::<Vec<_>>();
    let system = "Você é um tradutor profissional de inglês para português brasileiro (PT-BR). Traduza de forma natural, fluida e fiel ao sentido. Use o contexto integral para resolver pronomes, referências, expressões idiomáticas, phrasal verbs, humor e continuidade entre falas. Não traduza palavra por palavra quando isso produzir português artificial. Preserve nomes próprios, intenção, registro e tom. Não acrescente explicações. Responda exclusivamente em JSON válido no formato {\"translations\":[{\"id\":\"mesmo-id\",\"text\":\"tradução\"}]}. Cada ID solicitado deve aparecer exatamente uma vez.";
    let user = format!("CONTEXTO COMPLETO DA TRANSCRIÇÃO (para compreensão; não precisa reescrever):\n{context}\n\nTRECHOS QUE DEVEM SER TRADUZIDOS:\n{}",
        serde_json::to_string(&targets).map_err(|e| e.to_string())?);
    let body = serde_json::json!({
        "model": model,
        "temperature": 0.2,
        "response_format": {"type":"json_object"},
        "messages": [{"role":"system","content":system},{"role":"user","content":user}]
    });
    let client = Client::builder().timeout(Duration::from_secs(180)).build().map_err(|e| e.to_string())?;
    let response = client.post(endpoint).bearer_auth(key).json(&body).send()
        .map_err(|e| format!("Falha de conexão com a Groq: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let details = response.text().unwrap_or_default().chars().take(500).collect::<String>();
        return Err(format!("Groq HTTP {status}: {details}"));
    }
    let data: ChatResponse = response.json().map_err(|e| format!("Resposta da Groq inválida: {e}"))?;
    let raw = data.choices.first().ok_or("A Groq não retornou nenhuma escolha de tradução.")?.message.content.trim().to_string();
    let parsed = serde_json::from_str::<TranslationPayload>(&raw)
        .or_else(|_| {
            let start = raw.find('{').ok_or_else(|| serde_json::Error::io(std::io::Error::new(std::io::ErrorKind::InvalidData, "JSON não encontrado")))?;
            let end = raw.rfind('}').ok_or_else(|| serde_json::Error::io(std::io::Error::new(std::io::ErrorKind::InvalidData, "JSON incompleto")))?;
            serde_json::from_str::<TranslationPayload>(&raw[start..=end])
        }).map_err(|e| format!("Não foi possível interpretar a tradução retornada pela Groq: {e}"))?;
    let expected = batch.iter().map(|cue| cue.id.as_str()).collect::<std::collections::HashSet<_>>();
    let mut seen = std::collections::HashSet::new();
    for item in &parsed.translations {
        if !expected.contains(item.id.as_str()) || !seen.insert(item.id.as_str()) || item.text.trim().is_empty() {
            return Err("A Groq retornou IDs ausentes, duplicados ou traduções vazias. Nenhuma tradução foi aplicada.".into());
        }
    }
    if seen.len() != expected.len() {
        return Err("A Groq não traduziu todos os trechos solicitados. Nenhuma tradução foi aplicada.".into());
    }
    let _ = app;
    Ok(parsed.translations)
}

#[tauri::command]
pub async fn translate_project_subtitles(app: AppHandle, project_id: String, asset_id: String, cues: Vec<crate::media::SubtitleCue>) -> Result<Vec<TranslationCue>, String> {
    if cues.is_empty() { return Err("Não há trechos de transcrição para traduzir.".into()); }
    if cues.len() > 5000 { return Err("O projeto excede o limite de 5.000 trechos por tradução.".into()); }
    if cues.iter().any(|cue| cue.id.trim().is_empty() || cue.text.trim().is_empty() || cue.text.len() > 2000) {
        return Err("A transcrição contém trechos vazios ou inválidos. Revise-a antes de traduzir.".into());
    }
    let mut ordered = cues;
    ordered.sort_by_key(|cue| cue.start_ms);
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = translation_file(&app2, &project_id, &asset_id)?;
        let cfg = crate::shared_runtime::resolve_provider_settings(&app2, "groq")?;
        let key = crate::shared_runtime::resolve_provider_credential(&app2, "groq")?;
        let endpoint = format!("{}/chat/completions", cfg.endpoint.trim_end_matches('/'));
        let model = cfg.model.clone();
        let context = ordered.iter().map(|cue| format!("[{}-{} ms] {}: {}", cue.start_ms, cue.end_ms, cue.id, cue.text)).collect::<Vec<_>>().join("\n");
        const BATCH_SIZE: usize = 35;
        let batches = ordered.chunks(BATCH_SIZE).collect::<Vec<_>>();
        let total = batches.len();
        let mut by_id = std::collections::HashMap::<String, String>::new();
        for (index, batch) in batches.iter().enumerate() {
            emit(&app2, &project_id, "translating", index as f32 / total as f32 * 100.0, index, total, &format!("Traduzindo bloco {} de {} com contexto integral", index + 1, total));
            let items = translate_batch(&app2, &model, &key, &endpoint, &context, batch)?;
            for item in items { by_id.insert(item.id, item.text.trim().to_string()); }
            emit(&app2, &project_id, "translating", (index + 1) as f32 / total as f32 * 100.0, index + 1, total, &format!("Bloco {} de {} concluído", index + 1, total));
        }
        let result = ordered.iter().map(|cue| TranslationCue {
            id: cue.id.clone(), start_ms: cue.start_ms, end_ms: cue.end_ms,
            text: by_id.remove(&cue.id).unwrap_or_default(),
        }).collect::<Vec<_>>();
        if result.iter().any(|cue| cue.text.is_empty()) { return Err("A tradução retornou trechos incompletos. Nenhuma alteração foi salva.".into()); }
        emit(&app2, &project_id, "completed", 100.0, total, total, "Tradução concluída");
        Ok(result)
    }).await.map_err(|e| format!("A tradução foi interrompida: {e}"))?
}
