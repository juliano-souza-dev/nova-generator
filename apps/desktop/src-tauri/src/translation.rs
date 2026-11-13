use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::{HashMap, HashSet}, fs, path::PathBuf, time::Duration};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationCue { pub id: String, pub start_ms: u64, pub end_ms: u64, pub text: String }

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

fn project_asset_file(app: &AppHandle, project_id: &str, asset_id: &str, folder: &str) -> Result<PathBuf, String> {
    if asset_id.is_empty() || asset_id.len() > 64 || !asset_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Identificador de mídia inválido.".into());
    }
    let assets = crate::media::list_project_media(app.clone(), project_id.to_string())?;
    if !assets.iter().any(|asset| asset.id == asset_id) { return Err("Mídia não encontrada neste projeto.".into()); }
    let dir = crate::media::project_media_root(app, project_id)?.join(folder);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{asset_id}.json")))
}
fn translation_file(app: &AppHandle, project_id: &str, asset_id: &str) -> Result<PathBuf, String> {
    project_asset_file(app, project_id, asset_id, "translations")
}
fn editorial_file(app: &AppHandle, project_id: &str, asset_id: &str) -> Result<PathBuf, String> {
    project_asset_file(app, project_id, asset_id, "editorial")
}
fn atomic_write(path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    if path.exists() { fs::remove_file(path).map_err(|e| e.to_string())?; }
    fs::rename(temp, path).map_err(|e| e.to_string())
}
fn source_hash(input: &Value) -> Result<String, String> {
    let bytes = serde_json::to_vec(input).map_err(|e| e.to_string())?;
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in bytes { hash ^= byte as u64; hash = hash.wrapping_mul(0x100000001b3); }
    Ok(format!("fnv1a64:{hash:016x}"))
}

fn validate_editorial_result(result: &Value, cues: &[crate::media::SubtitleCue], include_words: bool, include_units: bool) -> Result<Vec<Value>, String> {
    if result.get("contract").and_then(Value::as_str) != Some(crate::translation_contract::OUTPUT_CONTRACT) {
        return Err("O JSON não corresponde ao contrato editorial 1.3.".into());
    }
    if result.get("approval").and_then(Value::as_str) != Some("draft") {
        return Err("O resultado precisa permanecer como rascunho para revisão humana.".into());
    }
    if result.pointer("/predictions/word_translations").and_then(Value::as_bool) != Some(include_words)
        || result.pointer("/predictions/semantic_units").and_then(Value::as_bool) != Some(include_units) {
        return Err("As predições do JSON não correspondem às opções selecionadas para este contrato.".into());
    }
    let suggestions = result.get("suggestions").and_then(Value::as_array).ok_or("O JSON não contém a lista suggestions.")?;
    if suggestions.len() != cues.len() { return Err(format!("O resultado contém {} sugestões para {} trechos.", suggestions.len(), cues.len())); }

    let input = crate::translation_contract::build_editorial_input("", "", cues, include_words, include_units);
    let input_cues = input["cues"].as_array().ok_or("Não foi possível montar a entrada editorial.")?;
    let source_by_id = input_cues.iter().filter_map(|c| Some((c["cue_id"].as_str()?.to_string(), c))).collect::<HashMap<_, _>>();
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();

    for suggestion in suggestions {
        let cue_id = suggestion.get("cue_id").and_then(Value::as_str).ok_or("Uma sugestão não contém cue_id.")?;
        if !seen.insert(cue_id.to_string()) { return Err(format!("O cue_id '{cue_id}' está duplicado.")); }
        let source = source_by_id.get(cue_id).ok_or_else(|| format!("O cue_id '{cue_id}' não pertence à transcrição atual."))?;
        for field in ["approved_en", "approved_pt", "trailing", "notes"] {
            if suggestion.get(field).and_then(Value::as_str).is_none() { return Err(format!("A sugestão '{cue_id}' não contém '{field}'.")); }
        }
        if suggestion["approved_pt"].as_str().unwrap_or("").trim().is_empty() { return Err(format!("A tradução de '{cue_id}' está vazia.")); }

        let expected_words = source["words"].as_array().cloned().unwrap_or_default();
        if include_words {
            let words = suggestion.get("word_translations").and_then(Value::as_array).ok_or_else(|| format!("A sugestão '{cue_id}' não contém word_translations."))?;
            if words.len() != expected_words.len() { return Err(format!("A quantidade de palavras traduzidas em '{cue_id}' não corresponde à transcrição.")); }
            let mut word_ids = HashSet::new();
            for (word, expected) in words.iter().zip(expected_words.iter()) {
                for field in ["word_id", "order", "leading", "surface", "start_ms", "end_ms"] {
                    if word.get(field) != expected.get(field) { return Err(format!("A palavra do trecho '{cue_id}' alterou '{field}'. IDs, ordem e tempos são imutáveis.")); }
                }
                let id = word["word_id"].as_str().unwrap_or("");
                if id.is_empty() || !word_ids.insert(id.to_string()) || word["pt"].as_str().unwrap_or("").trim().is_empty() {
                    return Err(format!("Há tradução vazia ou ID duplicado em word_translations de '{cue_id}'."));
                }
            }
        }

        if include_units {
            let units = suggestion.get("semantic_units").and_then(Value::as_array).ok_or_else(|| format!("A sugestão '{cue_id}' não contém semantic_units."))?;
            let positions = expected_words.iter().enumerate().filter_map(|(i,w)| Some((w["word_id"].as_str()?.to_string(), i))).collect::<HashMap<_,_>>();
            let mut used = HashSet::new();
            let mut groups = HashSet::new();
            for unit in units {
                let group_id = unit["semantic_group_id"].as_str().unwrap_or("");
                let ids = unit["word_ids"].as_array().ok_or("Uma unidade semântica não contém word_ids.")?;
                if group_id.is_empty() || !groups.insert(group_id.to_string()) || ids.len() < 2 || unit["pt"].as_str().unwrap_or("").trim().is_empty() {
                    return Err(format!("Unidade semântica incompleta em '{cue_id}'."));
                }
                let mut previous: Option<usize> = None;
                for id in ids {
                    let id = id.as_str().ok_or("word_id inválido em unidade semântica.")?;
                    let pos = *positions.get(id).ok_or_else(|| format!("Unidade '{group_id}' referencia palavra inexistente."))?;
                    if !used.insert(id.to_string()) || previous.map(|p| pos != p + 1).unwrap_or(false) {
                        return Err(format!("Unidade '{group_id}' não é contígua ou sobrepõe outro grupo."));
                    }
                    previous = Some(pos);
                }
            }
        }
        normalized.push(suggestion.clone());
    }
    if seen.len() != cues.len() { return Err("Há trechos sem sugestão editorial.".into()); }
    normalized.sort_by_key(|s| cues.iter().position(|c| s["cue_id"].as_str() == Some(c.id.as_str())).unwrap_or(usize::MAX));
    Ok(normalized)
}

fn persist_editorial_result(app: &AppHandle, project_id: &str, asset_id: &str, result: &Value, cues: &[crate::media::SubtitleCue], include_words: bool, include_units: bool) -> Result<(), String> {
    let suggestions = validate_editorial_result(result, cues, include_words, include_units)?;
    let input = crate::translation_contract::build_editorial_input(project_id, asset_id, cues, include_words, include_units);
    let hash = source_hash(&input)?;
    let path = editorial_file(app, project_id, asset_id)?;
    let revision = if path.exists() {
        fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.get("revision").and_then(Value::as_u64)).unwrap_or(0) + 1
    } else { 1 };
    let stored = json!({
        "contract": crate::translation_contract::OUTPUT_CONTRACT,
        "approval": "draft",
        "revision": revision,
        "source_hash": hash,
        "suggestions": suggestions
    });
    atomic_write(&path, &serde_json::to_vec_pretty(&stored).map_err(|e| e.to_string())?)
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
pub fn load_project_editorial_result(app: AppHandle, project_id: String, asset_id: String) -> Result<Option<Value>, String> {
    let path = editorial_file(&app, &project_id, &asset_id)?;
    if !path.exists() { return Ok(None); }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map(Some).map_err(|e| format!("Resultado editorial salvo inválido: {e}"))
}

#[tauri::command]
pub fn save_project_editorial_result(app: AppHandle, project_id: String, asset_id: String, result: Value, cues: Vec<crate::media::SubtitleCue>, include_word_translations: bool, include_semantic_units: bool) -> Result<(), String> {
    persist_editorial_result(&app, &project_id, &asset_id, &result, &cues, include_word_translations, include_semantic_units)
}

#[tauri::command]
pub fn save_project_translations(app: AppHandle, project_id: String, asset_id: String, translations: Vec<TranslationCue>) -> Result<(), String> {
    if translations.len() > 5000 { return Err("O projeto excede o limite de 5.000 traduções.".into()); }
    let path = translation_file(&app, &project_id, &asset_id)?;
    let mut previous_start = 0;
    for cue in &translations {
        if cue.id.is_empty() || cue.id.len() > 80 || cue.text.len() > 4000 || cue.end_ms <= cue.start_ms { return Err("Uma tradução contém dados inválidos.".into()); }
        if cue.start_ms < previous_start { return Err("As traduções precisam estar ordenadas pelo início.".into()); }
        previous_start = cue.start_ms;
    }
    atomic_write(&path, &serde_json::to_vec_pretty(&translations).map_err(|e| e.to_string())?)
}

fn translate_batch(model: &str, key: &str, endpoint: &str, full_input: &Value, batch: &[crate::media::SubtitleCue], include_words: bool, include_units: bool) -> Result<Value, String> {
    let batch_input = crate::translation_contract::build_editorial_input(
        full_input["project_id"].as_str().unwrap_or(""), full_input["asset_id"].as_str().unwrap_or(""),
        batch, include_words, include_units
    );
    let schema = crate::translation_contract::output_schema(include_words, include_units);
    let user = format!(
        "ENTRADA E CONTEXTO COMPLETO:\n{}\n\nCUES DESTE LOTE:\n{}\n\nESQUEMA DE SAÍDA OBRIGATÓRIO:\n{}",
        serde_json::to_string(full_input).map_err(|e| e.to_string())?,
        serde_json::to_string(&batch_input).map_err(|e| e.to_string())?,
        serde_json::to_string(&schema).map_err(|e| e.to_string())?
    );
    let body = json!({
        "model": model, "temperature": 0.2, "response_format": {"type":"json_object"},
        "messages": [
            {"role":"system","content":crate::translation_contract::EDITORIAL_RULES},
            {"role":"user","content":user}
        ]
    });
    let client = Client::builder().timeout(Duration::from_secs(240)).build().map_err(|e| e.to_string())?;
    let response = client.post(endpoint).bearer_auth(key).json(&body).send().map_err(|e| format!("Falha de conexão com a Groq: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let details = response.text().unwrap_or_default().chars().take(500).collect::<String>();
        return Err(format!("Groq HTTP {status}: {details}"));
    }
    let data: ChatResponse = response.json().map_err(|e| format!("Resposta da Groq inválida: {e}"))?;
    let raw = data.choices.first().ok_or("A Groq não retornou nenhuma resposta editorial.")?.message.content.trim().to_string();
    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(_) => {
            let start = raw.find('{').ok_or("A Groq não retornou JSON válido.")?;
            let end = raw.rfind('}').ok_or("A resposta JSON da Groq está incompleta.")?;
            serde_json::from_str(&raw[start..=end]).map_err(|e| format!("JSON editorial inválido: {e}"))?
        }
    };
    if parsed["contract"].as_str() != Some(crate::translation_contract::OUTPUT_CONTRACT) || parsed["approval"].as_str() != Some("draft") {
        return Err("A Groq retornou uma resposta fora do contrato editorial 1.3.".into());
    }
    Ok(parsed)
}

#[tauri::command]
pub async fn translate_project_subtitles(
    app: AppHandle, project_id: String, asset_id: String, cues: Vec<crate::media::SubtitleCue>,
    include_word_translations: bool, include_semantic_units: bool,
) -> Result<Vec<TranslationCue>, String> {
    if cues.is_empty() { return Err("Não há trechos de transcrição para traduzir.".into()); }
    if cues.len() > 5000 { return Err("O projeto excede o limite de 5.000 trechos por tradução.".into()); }
    if cues.iter().any(|cue| cue.id.trim().is_empty() || cue.text.trim().is_empty() || cue.text.len() > 2000) {
        return Err("A transcrição contém trechos vazios ou inválidos. Revise-a antes de traduzir.".into());
    }
    let mut ordered = cues;
    let mut ids = HashSet::new();
    if ordered.iter().any(|cue| !ids.insert(cue.id.as_str())) { return Err("A transcrição contém IDs de trechos duplicados.".into()); }
    ordered.sort_by_key(|cue| cue.start_ms);
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = translation_file(&app2, &project_id, &asset_id)?;
        let cfg = crate::shared_runtime::resolve_provider_settings(&app2, "groq")?;
        let key = crate::shared_runtime::resolve_provider_credential(&app2, "groq")?;
        let endpoint = format!("{}/chat/completions", cfg.endpoint.trim_end_matches('/'));
        let full_input = crate::translation_contract::build_editorial_input(&project_id, &asset_id, &ordered, include_word_translations, include_semantic_units);
        const BATCH_SIZE: usize = 12;
        let batches = ordered.chunks(BATCH_SIZE).collect::<Vec<_>>();
        let total = batches.len();
        let mut suggestions = Vec::new();
        for (index, batch) in batches.iter().enumerate() {
            emit(&app2, &project_id, "translating", index as f32 / total as f32 * 100.0, index, total, &format!("Executando contrato editorial 1.3, lote {} de {}", index + 1, total));
            let result = translate_batch(&cfg.model, &key, &endpoint, &full_input, batch, include_word_translations, include_semantic_units)?;
            let batch_result = json!({"contract":crate::translation_contract::OUTPUT_CONTRACT,"approval":"draft","predictions":result["predictions"],"suggestions":result["suggestions"]});
            suggestions.extend(validate_editorial_result(&batch_result, batch, include_word_translations, include_semantic_units)?);
            emit(&app2, &project_id, "translating", (index + 1) as f32 / total as f32 * 100.0, index + 1, total, &format!("Lote {} de {} validado", index + 1, total));
        }
        let final_result = json!({"contract":crate::translation_contract::OUTPUT_CONTRACT,"approval":"draft","predictions":{"word_translations":include_word_translations,"semantic_units":include_semantic_units},"suggestions":suggestions});
        persist_editorial_result(&app2, &project_id, &asset_id, &final_result, &ordered, include_word_translations, include_semantic_units)?;
        let by_id = final_result["suggestions"].as_array().unwrap().iter().filter_map(|s| {
            Some((s["cue_id"].as_str()?.to_string(), s["approved_pt"].as_str()?.to_string()))
        }).collect::<HashMap<_, _>>();
        let translations = ordered.iter().map(|cue| TranslationCue {
            id: cue.id.clone(), start_ms: cue.start_ms, end_ms: cue.end_ms,
            text: by_id.get(&cue.id).cloned().unwrap_or_default(),
        }).collect::<Vec<_>>();
        if translations.iter().any(|cue| cue.text.trim().is_empty()) { return Err("A tradução editorial está incompleta. Nenhuma alteração foi aplicada.".into()); }
        emit(&app2, &project_id, "completed", 100.0, total, total, "Contrato editorial 1.3 concluído; resultado salvo como rascunho");
        Ok(translations)
    }).await.map_err(|e| format!("A tradução foi interrompida: {e}"))?
}
