use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::{HashMap, HashSet}, fs, io::{BufRead, BufReader}, path::PathBuf, thread, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationCue { pub id: String, pub start_ms: u64, pub end_ms: u64, pub text: String }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress { project_id: String, asset_id: String, stage: String, percent: f32, completed_chunks: usize, total_chunks: usize, message: String }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TranslationStream { project_id: String, asset_id: String, cue_id: String, delta: String }

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslationJob { source_hash: String, include_words: bool, include_units: bool, suggestions: Vec<Value> }

fn emit(app: &AppHandle, project_id: &str, asset_id: &str, stage: &str, percent: f32, done: usize, total: usize, message: &str) {
    let _ = app.emit("translation-progress", Progress {
        project_id: project_id.into(), asset_id: asset_id.into(), stage: stage.into(), percent: percent.clamp(0.0, 100.0),
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
fn translation_job_file(app: &AppHandle, project_id: &str, asset_id: &str) -> Result<PathBuf, String> {
    project_asset_file(app, project_id, asset_id, "translation-jobs")
}
fn atomic_write(path: &PathBuf, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, bytes).map_err(|e| e.to_string())?;
    if path.exists() { fs::remove_file(path).map_err(|e| e.to_string())?; }
    fs::rename(temp, path).map_err(|e| e.to_string())
}
fn source_hash(input: &Value) -> Result<String, String> { crate::translation_contract::input_hash(input) }
fn now_ms() -> u128 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() }

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

    let input = crate::translation_contract::build_editorial_input("", "", cues, include_words, include_units)?;
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
                let word_items = suggestion.get("word_translations").and_then(Value::as_array).cloned().unwrap_or_default();
                let mut previous: Option<usize> = None;
                for (member_index, id) in ids.iter().enumerate() {
                    let id = id.as_str().ok_or("word_id inválido em unidade semântica.")?;
                    let pos = *positions.get(id).ok_or_else(|| format!("Unidade '{group_id}' referencia palavra inexistente."))?;
                    if !used.insert(id.to_string()) || previous.map(|p| pos != p + 1).unwrap_or(false) {
                        return Err(format!("Unidade '{group_id}' não é contígua ou sobrepõe outro grupo."));
                    }
                    let word = word_items.iter().find(|word| word["word_id"].as_str() == Some(id))
                        .ok_or_else(|| format!("A palavra '{id}' da unidade semântica não existe em word_translations."))?;
                    let expected_role = if member_index == 0 { "lead" } else { "member" };
                    if word["semantic_group_id"].as_str() != Some(group_id) || word["semantic_group_role"].as_str() != Some(expected_role) {
                        return Err(format!("A palavra '{id}' não respeita o papel '{expected_role}' do grupo '{group_id}'."));
                    }
                    if member_index == 0 {
                        if word["pt"].as_str() != unit["pt"].as_str() {
                            return Err(format!("A palavra líder do grupo '{group_id}' deve conter a tradução completa da unidade em pt."));
                        }
                    } else if word["pt_original"].as_str().unwrap_or("").trim().is_empty() {
                        return Err(format!("A palavra membro '{id}' precisa preservar sua tradução individual em pt_original."));
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
    let input = crate::translation_contract::build_editorial_input(project_id, asset_id, cues, include_words, include_units)?;
    let hash = source_hash(&input)?;
    if result.get("source_hash").and_then(Value::as_str) != Some(hash.as_str()) {
        return Err("Este resultado pertence a outra versão da transcrição. Gere novamente o pacote ou a tradução.".into());
    }
    let path = editorial_file(app, project_id, asset_id)?;
    let previous = if path.exists() {
        fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or_else(|| json!({}))
    } else { json!({}) };
    let revision = previous.get("revision").and_then(Value::as_u64).unwrap_or(0) + 1;
    let mut audit = previous.get("audit").and_then(Value::as_array).cloned().unwrap_or_default();
    audit.push(json!({"revision":revision,"action":"save_draft","at_ms":now_ms()}));
    let stored = json!({
        "contract": crate::translation_contract::OUTPUT_CONTRACT,
        "approval": "draft",
        "revision": revision,
        "source_hash": hash,
        "predictions": {"word_translations": include_words, "semantic_units": include_units},
        "suggestions": suggestions,
        "audit": audit
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
pub fn load_project_editorial_result(app: AppHandle, project_id: String, asset_id: String, cues: Vec<crate::media::SubtitleCue>) -> Result<Option<Value>, String> {
    let path = editorial_file(&app, &project_id, &asset_id)?;
    if !path.exists() { return Ok(None); }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let stored: Value = serde_json::from_str(&raw).map_err(|e| format!("Resultado editorial salvo inválido: {e}"))?;
    let include_words = stored.pointer("/predictions/word_translations").and_then(Value::as_bool).unwrap_or(false);
    let include_units = stored.pointer("/predictions/semantic_units").and_then(Value::as_bool).unwrap_or(false);
    let input = crate::translation_contract::build_editorial_input(&project_id, &asset_id, &cues, include_words, include_units)?;
    let current_hash = source_hash(&input)?;
    if stored.get("source_hash").and_then(Value::as_str) != Some(current_hash.as_str()) {
        return Ok(None);
    }
    Ok(Some(stored))
}

#[tauri::command]
pub fn save_project_editorial_result(app: AppHandle, project_id: String, asset_id: String, result: Value, cues: Vec<crate::media::SubtitleCue>, include_word_translations: bool, include_semantic_units: bool) -> Result<(), String> {
    persist_editorial_result(&app, &project_id, &asset_id, &result, &cues, include_word_translations, include_semantic_units)
}

#[tauri::command]
pub fn clear_project_editorial_result(app: AppHandle, project_id: String, asset_id: String) -> Result<(), String> {
    let path = editorial_file(&app, &project_id, &asset_id)?;
    if path.exists() { fs::remove_file(path).map_err(|e| format!("Não foi possível remover o rascunho editorial: {e}"))?; }
    Ok(())
}

#[tauri::command]
pub fn approve_project_editorial_result(app: AppHandle, project_id: String, asset_id: String, cues: Vec<crate::media::SubtitleCue>) -> Result<Value, String> {
    let path = editorial_file(&app, &project_id, &asset_id)?;
    if !path.exists() { return Err("Não há resultado editorial para aprovar.".into()); }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut stored: Value = serde_json::from_str(&raw).map_err(|e| format!("Rascunho editorial inválido: {e}"))?;
    if stored.get("approval").and_then(Value::as_str) != Some("draft") {
        return Err("Este resultado não está em estado de rascunho.".into());
    }
    let include_words = stored.pointer("/predictions/word_translations").and_then(Value::as_bool).unwrap_or(false);
    let include_units = stored.pointer("/predictions/semantic_units").and_then(Value::as_bool).unwrap_or(false);
    let input = crate::translation_contract::build_editorial_input(&project_id, &asset_id, &cues, include_words, include_units)?;
    let current_hash = source_hash(&input)?;
    if stored.get("source_hash").and_then(Value::as_str) != Some(current_hash.as_str()) {
        return Err("A transcrição mudou desde a geração. Gere novamente as predições antes de aprovar.".into());
    }
    let _ = validate_editorial_result(&stored, &cues, include_words, include_units)?;
    let revision = stored.get("revision").and_then(Value::as_u64).unwrap_or(0) + 1;
    let mut audit = stored.get("audit").and_then(Value::as_array).cloned().unwrap_or_default();
    audit.push(json!({"revision":revision,"action":"human_approved","at_ms":now_ms()}));
    stored["approval"] = json!("approved");
    stored["revision"] = json!(revision);
    stored["approved_at_ms"] = json!(now_ms());
    stored["audit"] = json!(audit);
    atomic_write(&path, &serde_json::to_vec_pretty(&stored).map_err(|e| e.to_string())?)?;
    Ok(stored)
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

fn parse_streamed_json(raw: &str) -> Result<Value, String> {
    match serde_json::from_str::<Value>(raw.trim()) {
        Ok(value) => Ok(value),
        Err(_) => {
            let start = raw.find('{').ok_or("A Groq não retornou JSON válido.")?;
            let end = raw.rfind('}').ok_or("A resposta JSON da Groq está incompleta.")?;
            serde_json::from_str(&raw[start..=end]).map_err(|e| format!("JSON da Groq inválido: {e}"))
        }
    }
}

fn translate_cue_streaming(
    app: &AppHandle,
    project_id: &str,
    asset_id: &str,
    model: &str,
    key: &str,
    endpoint: &str,
    cue: &crate::media::SubtitleCue,
    include_words: bool,
    include_units: bool,
) -> Result<Value, String> {
    let words = if include_words {
        cue.words.as_deref().unwrap_or(&[]).iter().enumerate().map(|(order, word)| {
            let (leading, surface) = crate::translation_contract::split_leading(&word.text);
            json!({
                "word_id": format!("{}:word:{:04}", cue.id, order + 1),
                "surface": surface,
                "leading": leading
            })
        }).collect::<Vec<_>>()
    } else { Vec::new() };

    let user_payload = json!({
        "cue_id": cue.id,
        "text": cue.text,
        "predictions": {
            "word_translations": include_words,
            "semantic_units": include_units
        },
        "words": words
    });

    let mut system = String::from(
        "Você é o tradutor editorial do Nova Generator. Traduza integralmente a fala para português brasileiro natural, preservando sentido, negações, detalhes, repetições relevantes e tom. Não resuma nem acrescente explicações. Responda exclusivamente com um único objeto JSON, sem Markdown. O objeto deve conter approved_pt como tradução completa. Não devolva contrato, hash, timestamps, IDs de cue, esquema ou metadados que não foram pedidos."
    );
    if include_words {
        system.push_str(
            " Inclua word_translations como um array de strings, com uma tradução contextual curta para cada palavra, rigorosamente na mesma ordem do array words recebido. Inclua todas as palavras uma única vez. Não devolva IDs, leading, surface, order ou tempos."
        );
    }
    if include_units {
        system.push_str(
            " Inclua semantic_units sempre como array; use [] quando não houver expressões ou grupos contíguos cujo significado funcione como unidade. Cada item deve conter semantic_group_id curto e único dentro deste trecho, word_ids em ordem e pt com a tradução natural completa da expressão. Não force agrupamentos."
        );
    }
    system.push_str(
        " Não inclua approved_en, trailing, notes, approval, predictions ou source_hash. O aplicativo preencherá e validará esses campos."
    );

    // Modelo editorial padronizado para tradução e predições.
    // A chave e o endpoint continuam vindo do Shared Runtime (Groq).
    let editorial_model = "openai/gpt-oss-120b";
    let mut body = json!({
        "model": editorial_model,
        "temperature": 0.2,
        "response_format": {"type":"json_object"},
        "stream": true,
        "max_completion_tokens": 4096,
        "messages": [
            {"role":"system","content":system},
            {"role":"user","content":serde_json::to_string(&user_payload).map_err(|e| e.to_string())?}
        ]
    });
    // GPT-OSS oferece níveis de raciocínio; low prioriza a resposta editorial
    // sem gastar capacidade excessiva com raciocínio interno.
    body["reasoning_effort"] = json!("low");

    let client = Client::builder()
        .timeout(Duration::from_secs(240))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client.post(endpoint).bearer_auth(key).json(&body).send()
        .map_err(|e| format!("Falha de conexão com a Groq: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let retry_after = response.headers().get("retry-after").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let details = response.text().unwrap_or_default().chars().take(500).collect::<String>();
        return Err(format!("Groq HTTP {status}: {details} [retry-after: {retry_after}]"));
    }

    let mut reader = BufReader::new(response);
    let mut line = String::new();
    let mut raw = String::new();
    let mut finish_reason = String::from("desconhecido");
    let mut response_model = editorial_model.to_string();
    let mut refusal = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line).map_err(|e| format!("Falha ao receber streaming da Groq: {e}"))?;
        if read == 0 { break; }
        let Some(data) = line.trim().strip_prefix("data:") else { continue; };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" { continue; }
        let event: Value = serde_json::from_str(data)
            .map_err(|e| format!("Evento de streaming inválido da Groq ({model}): {e}"))?;
        if let Some(actual_model) = event.get("model").and_then(Value::as_str) {
            response_model = actual_model.to_string();
        }
        if let Some(choice) = event.get("choices").and_then(Value::as_array).and_then(|items| items.first()) {
            if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
                finish_reason = reason.to_string();
            }
            if let Some(message) = choice.get("delta") {
                if let Some(value) = message.get("refusal").and_then(Value::as_str) {
                    refusal.push_str(value);
                }
                if let Some(delta) = message.get("content").and_then(Value::as_str) {
                    raw.push_str(delta);
                    let _ = app.emit("translation-stream", TranslationStream {
                        project_id: project_id.into(),
                        asset_id: asset_id.into(),
                        cue_id: cue.id.clone(),
                        delta: delta.into(),
                    });
                }
            }
        }
    }
    if raw.trim().is_empty() {
        return Err(format!(
            "A Groq não enviou conteúdo para o trecho '{}' usando o modelo '{}'. finish_reason={finish_reason}. {}",
            cue.id, response_model,
            if refusal.is_empty() { "Verifique o modelo configurado e o limite de conclusão.".to_string() } else { format!("Recusa do modelo: {refusal}") }
        ));
    }
    if finish_reason == "length" {
        return Err(format!(
            "A resposta do modelo '{response_model}' foi interrompida pelo limite de tokens (finish_reason=length) no trecho '{}'. Reduza o tamanho do chunk ou ajuste o limite de saída.",
            cue.id
        ));
    }

    let parsed = match parse_streamed_json(&raw) {
        Ok(value) => value,
        Err(_) if !include_words && !include_units => json!({"approved_pt": raw.trim()}),
        Err(error) => return Err(format!(
            "O modelo '{response_model}' não retornou o formato esperado no trecho '{}'. finish_reason={finish_reason}; detalhe={error}; resposta recebida={}",
            cue.id, raw.chars().take(360).collect::<String>()
        )),
    };
    // Alguns modelos encapsulam os campos editoriais dentro de "text".
    // Normalizamos esse formato alternativo antes de validar a resposta.
    let nested_text = parsed.get("text").filter(|value| value.is_object());
    let content = nested_text.unwrap_or(&parsed);

    let translated = content.get("approved_pt")
        .or_else(|| content.get("translation"))
        .or_else(|| content.get("translated_text"))
        .or_else(|| content.get("pt"))
        .or_else(|| content.get("text"))
        .or_else(|| parsed.get("approved_pt"))
        .or_else(|| parsed.get("translation"))
        .or_else(|| parsed.get("translated_text"))
        .or_else(|| parsed.get("pt"))
        .or_else(|| parsed.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if translated.is_empty() {
        let root_keys = parsed.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>().join(", ")).unwrap_or_default();
        let nested_keys = content.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>().join(", ")).unwrap_or_default();
        return Err(format!(
            "O modelo '{response_model}' não devolveu approved_pt para o trecho '{}'. finish_reason={finish_reason}; chaves_raiz=[{}]; chaves_text=[{}]; resposta_chars={}; amostra={}",
            cue.id, root_keys, nested_keys, raw.chars().count(), raw.chars().take(1200).collect::<String>()
        ));
    }

    let mut parsed = parsed;
    parsed["approved_pt"] = json!(translated);

    // A resposta alternativa do ALLaM pode colocar traduções individuais
    // em semantic_units[].word_translations.pt, identificadas por word_id.
    if include_words {
        let source = parsed.get("text").filter(|value| value.is_object()).unwrap_or(&parsed);
        let mut normalized_words = source.get("word_translations")
            .and_then(Value::as_array)
            .cloned()
            .or_else(|| parsed.get("word_translations").and_then(Value::as_array).cloned())
            .unwrap_or_default();

        if normalized_words.is_empty() {
            let mut by_id = HashMap::<String, String>::new();
            if let Some(items) = source.get("semantic_units").and_then(Value::as_array) {
                for item in items {
                    let id = item.get("word_id").and_then(Value::as_str);
                    let pt = item.pointer("/word_translations/pt").and_then(Value::as_str)
                        .or_else(|| item.get("pt").and_then(Value::as_str));
                    if let (Some(id), Some(pt)) = (id, pt) {
                        by_id.insert(id.to_string(), pt.to_string());
                    }
                }
            }
            normalized_words = words.iter().filter_map(|word| {
                let id = word.get("word_id")?.as_str()?;
                by_id.get(id).map(|pt| json!(pt))
            }).collect();
        } else {
            normalized_words = normalized_words.into_iter().map(|value| {
                if let Some(text) = value.as_str() { json!(text) }
                else if let Some(text) = value.get("pt").and_then(Value::as_str) { json!(text) }
                else if let Some(text) = value.pointer("/word_translations/pt").and_then(Value::as_str) { json!(text) }
                else { Value::Null }
            }).collect();
        }

        if normalized_words.len() != words.len() {
            return Err(format!("A Groq devolveu {} traduções de palavras para '{}' mas eram esperadas {}. Verifique o formato emitido pelo modelo '{}'.", normalized_words.len(), cue.id, words.len(), response_model));
        }
        if normalized_words.iter().any(|value| value.as_str().unwrap_or("").trim().is_empty()) {
            return Err(format!("A Groq devolveu uma tradução de palavra vazia em '{}'.", cue.id));
        }
        parsed["word_translations"] = json!(normalized_words);
    }

    if include_units {
        let source = parsed.get("text").filter(|value| value.is_object()).unwrap_or(&parsed);
        let units = source.get("semantic_units").and_then(Value::as_array).cloned()
            .or_else(|| parsed.get("semantic_units").and_then(Value::as_array).cloned())
            .unwrap_or_default();
        // Descarta itens que representam palavras isoladas, não unidades semânticas.
        let valid_units = units.into_iter().filter(|unit| {
            unit.get("semantic_group_id").and_then(Value::as_str).is_some()
                && unit.get("word_ids").and_then(Value::as_array).is_some()
                && unit.get("pt").and_then(Value::as_str).is_some()
        }).collect::<Vec<_>>();
        parsed["semantic_units"] = json!(valid_units);
    }
    Ok(parsed)
}

fn build_contract_suggestion(
    cue: &crate::media::SubtitleCue,
    response: &Value,
    include_words: bool,
    include_units: bool,
) -> Result<Value, String> {
    let mut suggestion = json!({
        "cue_id": cue.id,
        "approved_en": cue.text,
        "approved_pt": response["approved_pt"],
        "trailing": "",
        "notes": ""
    });

    if include_words {
        let source_words = cue.words.as_deref().unwrap_or(&[]);
        let raw_translations = response.get("word_translations").and_then(Value::as_array)
            .ok_or("A resposta não contém a lista de traduções por palavra.")?;
        if raw_translations.len() != source_words.len() {
            return Err(format!("A resposta contém {} traduções de palavras, mas eram esperadas {}.", raw_translations.len(), source_words.len()));
        }
        let mut word_translations = Vec::with_capacity(source_words.len());
        for (index, word) in source_words.iter().enumerate() {
            let (leading, surface) = crate::translation_contract::split_leading(&word.text);
            let word_id = format!("{}:word:{:04}", cue.id, index + 1);
            let pt = raw_translations[index].as_str()
                .ok_or_else(|| format!("A tradução da palavra '{word_id}' não é um texto válido."))?;
            word_translations.push(json!({
                "word_id": word_id,
                "order": index + 1,
                "leading": leading,
                "surface": surface,
                "start_ms": word.start_ms,
                "end_ms": word.end_ms,
                "pt": pt
            }));
        }

        if include_units {
            let units = response.get("semantic_units").and_then(Value::as_array)
                .ok_or("A resposta não contém semantic_units.")?;
            let mut group_map: HashMap<String, (String, String)> = HashMap::new();
            for unit in units {
                let group_id = unit["semantic_group_id"].as_str().unwrap_or("").to_string();
                let phrase_pt = unit["pt"].as_str().unwrap_or("").to_string();
                let ids = unit["word_ids"].as_array().ok_or("Uma unidade semântica não contém word_ids.")?;
                for (member_index, id) in ids.iter().enumerate() {
                    let id = id.as_str().ok_or("word_id inválido em unidade semântica.")?.to_string();
                    let role = if member_index == 0 { "lead" } else { "member" };
                    if group_map.insert(id, (group_id.clone(), format!("{role}\u{0}{phrase_pt}"))).is_some() {
                        return Err("A Groq associou uma palavra a mais de uma unidade semântica.".into());
                    }
                }
            }
            for word in &mut word_translations {
                let id = word["word_id"].as_str().unwrap_or("").to_string();
                if let Some((group_id, role_and_phrase)) = group_map.get(&id) {
                    let mut parts = role_and_phrase.splitn(2, '\0');
                    let role = parts.next().unwrap_or("member");
                    let phrase_pt = parts.next().unwrap_or("");
                    let individual_pt = word["pt"].as_str().unwrap_or("").to_string();
                    word["semantic_group_id"] = json!(group_id);
                    word["semantic_group_role"] = json!(role);
                    if role == "lead" {
                        word["pt_original"] = json!(individual_pt);
                        word["pt"] = json!(phrase_pt);
                    } else {
                        word["pt_original"] = json!(individual_pt);
                    }
                }
            }
        }
        suggestion["word_translations"] = json!(word_translations);
    }

    if include_units {
        suggestion["semantic_units"] = response.get("semantic_units").cloned().unwrap_or_else(|| json!([]));
    }
    Ok(suggestion)
}

fn should_retry_groq_error(error: &str) -> bool {
    error.contains("Groq HTTP 429") || error.contains("Groq HTTP 500") ||
    error.contains("Groq HTTP 502") || error.contains("Groq HTTP 503") ||
    error.contains("Groq HTTP 504")
}

fn load_translation_job(path: &PathBuf, source_hash: &str, include_words: bool, include_units: bool) -> TranslationJob {
    if path.exists() {
        if let Ok(raw) = fs::read_to_string(path) {
            if let Ok(job) = serde_json::from_str::<TranslationJob>(&raw) {
                if job.source_hash == source_hash && job.include_words == include_words && job.include_units == include_units {
                    return job;
                }
            }
        }
    }
    TranslationJob {
        source_hash: source_hash.into(),
        include_words,
        include_units,
        suggestions: Vec::new(),
    }
}

#[tauri::command]
pub async fn translate_project_subtitles(
    app: AppHandle, project_id: String, asset_id: String, cues: Vec<crate::media::SubtitleCue>,
    include_word_translations: bool, include_semantic_units: bool,
) -> Result<Vec<TranslationCue>, String> {
    if include_semantic_units && !include_word_translations {
        return Err("Unidades semânticas dependem das traduções palavra por palavra. Ative as duas predições.".into());
    }
    if cues.is_empty() { return Err("Não há trechos de transcrição para traduzir.".into()); }
    if cues.len() > 5000 { return Err("O projeto excede o limite de 5.000 trechos por tradução.".into()); }
    if cues.iter().any(|cue| cue.id.trim().is_empty() || cue.text.trim().is_empty() || cue.text.len() > 2000) {
        return Err("A transcrição contém trechos vazios ou inválidos. Revise-a antes de traduzir.".into());
    }

    let mut ordered = cues;
    let mut ids = HashSet::new();
    if ordered.iter().any(|cue| !ids.insert(cue.id.as_str())) {
        return Err("A transcrição contém IDs de trechos duplicados.".into());
    }
    ordered.sort_by_key(|cue| cue.start_ms);

    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = translation_file(&app2, &project_id, &asset_id)?;
        let cfg = crate::shared_runtime::resolve_provider_settings(&app2, "groq")?;
        let key = crate::shared_runtime::resolve_provider_credential(&app2, "groq")?;
        let endpoint = format!("{}/chat/completions", cfg.endpoint.trim_end_matches('/'));
        let full_input = crate::translation_contract::build_editorial_input(
            &project_id, &asset_id, &ordered, include_word_translations, include_semantic_units
        )?;
        let hash = full_input["source_hash"].as_str().ok_or("Não foi possível calcular o hash da transcrição.")?.to_string();
        let job_path = translation_job_file(&app2, &project_id, &asset_id)?;
        let mut job = load_translation_job(&job_path, &hash, include_word_translations, include_semantic_units);
        let total = ordered.len();
        let mut suggestions_by_id = job.suggestions.iter().filter_map(|item| {
            Some((item["cue_id"].as_str()?.to_string(), item.clone()))
        }).collect::<HashMap<_, _>>();

        // Revalida o cache local antes de reutilizar qualquer trecho concluído.
        suggestions_by_id.retain(|cue_id, suggestion| {
            ordered.iter().find(|cue| cue.id == *cue_id).map(|cue| {
                let cached = json!({
                    "contract": crate::translation_contract::OUTPUT_CONTRACT,
                    "approval": "draft",
                    "source_hash": hash,
                    "predictions": {"word_translations": include_word_translations, "semantic_units": include_semantic_units},
                    "suggestions": [suggestion]
                });
                validate_editorial_result(&cached, std::slice::from_ref(cue), include_word_translations, include_semantic_units).is_ok()
            }).unwrap_or(false)
        });

        let completed = suggestions_by_id.len();
        emit(&app2, &project_id, &asset_id, "preparing", completed as f32 / total as f32 * 100.0, completed, total,
            &format!("Tarefa preparada. {} de {} trechos já concluídos serão reutilizados.", completed, total));

        let mut ordered_suggestions = Vec::with_capacity(total);
        for (index, cue) in ordered.iter().enumerate() {
            let suggestion = if let Some(cached) = suggestions_by_id.get(&cue.id) {
                cached.clone()
            } else {
                emit(&app2, &project_id, &asset_id, "streaming", index as f32 / total as f32 * 100.0,
                    index, total, &format!("Recebendo tradução do trecho {} de {} em streaming...", index + 1, total));

                let mut response = None;
                let mut last_error = String::new();
                for attempt in 0..3 {
                    match translate_cue_streaming(
                        &app2, &project_id, &asset_id, &cfg.model, &key, &endpoint, cue,
                        include_word_translations, include_semantic_units
                    ) {
                        Ok(value) => { response = Some(value); break; }
                        Err(error) => {
                            let retry = should_retry_groq_error(&error);
                            let retry_after = error.split("[retry-after: ").nth(1)
                                .and_then(|value| value.split(']').next())
                                .and_then(|value| value.parse::<u64>().ok());
                            last_error = error;
                            if !retry || attempt == 2 { break; }
                            let delay = retry_after.unwrap_or_else(|| 2_u64.pow(attempt as u32 + 1)).clamp(1, 60);
                            emit(&app2, &project_id, &asset_id, "retrying", index as f32 / total as f32 * 100.0,
                                index, total, &format!("Limite temporário da Groq. Nova tentativa em {delay}s..."));
                            thread::sleep(Duration::from_secs(delay));
                        }
                    }
                }
                let response = response.ok_or(last_error)?;
                let suggestion = build_contract_suggestion(cue, &response, include_word_translations, include_semantic_units)?;
                let single = json!({
                    "contract": crate::translation_contract::OUTPUT_CONTRACT,
                    "approval": "draft",
                    "source_hash": hash,
                    "predictions": {"word_translations": include_word_translations, "semantic_units": include_semantic_units},
                    "suggestions": [suggestion]
                });
                validate_editorial_result(&single, std::slice::from_ref(cue), include_word_translations, include_semantic_units)?;
                suggestion
            };

            if !suggestions_by_id.contains_key(&cue.id) {
                suggestions_by_id.insert(cue.id.clone(), suggestion.clone());
                job.suggestions = ordered.iter().filter_map(|item| suggestions_by_id.get(&item.id).cloned()).collect();
                atomic_write(&job_path, &serde_json::to_vec_pretty(&job).map_err(|e| e.to_string())?)?;
                let done = suggestions_by_id.len();
                emit(&app2, &project_id, &asset_id, "translating", done as f32 / total as f32 * 100.0,
                    done, total, &format!("Trecho {} de {} traduzido, validado e salvo.", done, total));
                // A pausa curta e sequencial ajuda a respeitar os limites da API gratuita.
                if done < total { thread::sleep(Duration::from_millis(2100)); }
            }
            ordered_suggestions.push(suggestion);
        }

        let final_result = json!({
            "contract": crate::translation_contract::OUTPUT_CONTRACT,
            "approval": "draft",
            "source_hash": hash,
            "predictions": {"word_translations": include_word_translations, "semantic_units": include_semantic_units},
            "suggestions": ordered_suggestions
        });
        persist_editorial_result(&app2, &project_id, &asset_id, &final_result, &ordered, include_word_translations, include_semantic_units)?;

        let by_id = final_result["suggestions"].as_array().unwrap().iter().filter_map(|s| {
            Some((s["cue_id"].as_str()?.to_string(), s["approved_pt"].as_str()?.to_string()))
        }).collect::<HashMap<_, _>>();
        let translations = ordered.iter().map(|cue| TranslationCue {
            id: cue.id.clone(), start_ms: cue.start_ms, end_ms: cue.end_ms,
            text: by_id.get(&cue.id).cloned().unwrap_or_default(),
        }).collect::<Vec<_>>();
        if translations.iter().any(|cue| cue.text.trim().is_empty()) {
            return Err("A tradução editorial está incompleta. Nenhuma alteração foi aplicada.".into());
        }
        if job_path.exists() { fs::remove_file(&job_path).map_err(|e| format!("Não foi possível finalizar a fila de tradução: {e}"))?; }
        emit(&app2, &project_id, &asset_id, "completed", 100.0, total, total,
            "Contrato editorial 1.3 concluído; rascunho montado e salvo pelo Nova Generator.");
        Ok(translations)
    }).await.map_err(|e| format!("A tradução foi interrompida: {e}"))?
}
