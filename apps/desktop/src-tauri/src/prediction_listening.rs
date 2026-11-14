use serde_json::{json, Value};
use std::{collections::HashSet, fs};
use tauri::AppHandle;

pub const INPUT_CONTRACT: &str = "nova-generator-prediction-listening-input/1.0";
pub const OUTPUT_CONTRACT: &str = "nova-generator-prediction-listening-output/1.0";

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PredictionListeningPackage {
    pub package_version: String,
    pub contract_id: String,
    pub source_hash: String,
    pub files: std::collections::BTreeMap<String, String>,
}

fn build_external_package(
    cues: &[crate::media::SubtitleCue],
    selected_cue_ids: &[String],
) -> Result<PredictionListeningPackage, String> {
    if cues.is_empty() {
        return Err("Não há transcrição para preparar o Prediction Listening.".into());
    }
    if cues.len() > 5000 {
        return Err("O projeto excede o limite de 5.000 trechos.".into());
    }
    if selected_cue_ids.is_empty() {
        return Err("Conclua o Shadowing e selecione ao menos um bloco antes de gerar o Prediction Listening.".into());
    }

    let selected: HashSet<&str> = selected_cue_ids.iter().map(String::as_str).collect();
    if selected.len() != selected_cue_ids.len() {
        return Err("A seleção de Shadowing contém blocos duplicados.".into());
    }
    if selected.iter().any(|id| !cues.iter().any(|cue| cue.id.as_str() == *id)) {
        return Err("A seleção de Shadowing não corresponde à transcrição atual.".into());
    }

    let mut next_word_number = 0usize;
    let mut cue_values = Vec::with_capacity(cues.len());
    let mut text_sections = Vec::with_capacity(cues.len());

    for (cue_index, cue) in cues.iter().enumerate() {
        if cue.id.trim().is_empty() || cue.text.trim().is_empty() || cue.end_ms <= cue.start_ms {
            return Err(format!("O trecho {} contém dados inválidos.", cue_index + 1));
        }
        let is_selected = selected.contains(cue.id.as_str());
        let aligned = cue.word_alignment.as_deref() == Some("whisperx");
        if is_selected && (!aligned || cue.words.as_deref().map_or(true, |words| words.is_empty())) {
            return Err(format!(
                "O bloco selecionado {} ainda não possui sincronização palavra por palavra do WhisperX. Conclua o alinhamento antes de gerar o material.",
                cue_index + 1
            ));
        }

        let mut word_values = Vec::new();
        let mut word_lines = Vec::new();
        if aligned {
            if let Some(words) = cue.words.as_deref() {
                for word in words {
                    if word.text.trim().is_empty() || word.end_ms <= word.start_ms {
                        return Err(format!("Há uma palavra com alinhamento inválido no bloco {}.", cue_index + 1));
                    }
                    next_word_number += 1;
                    word_values.push(json!({
                        "word_number": next_word_number,
                        "text": word.text,
                        "start_ms": word.start_ms,
                        "end_ms": word.end_ms
                    }));
                    word_lines.push(format!("[WORD {:06}] {}", next_word_number, word.text));
                }
            }
        }

        cue_values.push(json!({
            "cue_number": cue_index + 1,
            "cue_id": cue.id,
            "selected_for_shadowing": is_selected,
            "text": cue.text,
            "words": word_values
        }));

        let mut lines = vec![
            String::new(),
            format!("[CUE {:04}] {}", cue_index + 1, if is_selected { "TARGET: SELECTED IN SHADOWING" } else { "CONTEXT ONLY" }),
            format!("TEXT: {}", cue.text),
        ];
        if !word_lines.is_empty() {
            lines.push("NUMBERED WORDS:".into());
            lines.extend(word_lines);
        } else {
            lines.push("NUMBERED WORDS: unavailable for this context cue.".into());
        }
        text_sections.push(lines.join("\n"));
    }

    let mut input = json!({
        "contract": INPUT_CONTRACT,
        "selected_cue_ids": selected_cue_ids,
        "cues": cue_values
    });
    input["source_hash"] = json!(crate::translation_contract::input_hash(&input)?);
    let source_hash = input["source_hash"].as_str().unwrap_or_default().to_string();

    let sections = vec![
        "NOVA GENERATOR | PREDICTION LISTENING".to_string(),
        "EXTERNAL AI GENERATION PACKAGE | INPUT 1.0".to_string(),
        format!("INPUT_CONTRACT: {INPUT_CONTRACT}"),
        format!("REQUIRED_OUTPUT_CONTRACT: {OUTPUT_CONTRACT}"),
        format!("SOURCE_HASH: {source_hash}"),
        format!("TOTAL_CUES: {}", cues.len()),
        format!("TOTAL_NUMBERED_WORDS: {next_word_number}"),
        format!("SHADOWING_SELECTED_CUES: {}", selected_cue_ids.len()),
        String::new(),
        "==============================================================".into(),
        "1. YOUR ROLE".into(),
        "==============================================================".into(),
        "You are an English listening activity designer. Identify only high-value moments where a learner can predict what will be said next, then listen to verify the prediction.".into(),
        "Do not translate, rewrite, summarize, or correct the transcript. The supplied transcript is the authoritative source.".into(),
        String::new(),
        "2. PEDAGOGICAL OBJECTIVE".into(),
        "Create useful prediction challenges that develop contextual listening, vocabulary anticipation, recognition of expressions, and understanding of conversational flow.".into(),
        "A challenge must be answerable from the supplied context and must test something meaningful. Quality is more important than quantity.".into(),
        String::new(),
        "3. ALLOWED CHALLENGE TYPES".into(),
        "WORD: predict one upcoming word with meaningful vocabulary value.".into(),
        "EXPRESSION: predict a natural, contiguous expression, collocation, phrasal verb, or short phrase.".into(),
        "DIALOGUE: predict a natural response or continuation in a conversation.".into(),
        String::new(),
        "4. WHERE CHALLENGES MAY BE PLACED".into(),
        "Create challenges ONLY when the answer begins inside a cue marked TARGET: SELECTED IN SHADOWING.".into(),
        "Cues marked CONTEXT ONLY are provided to understand the conversation. Do not place the answer inside those cues.".into(),
        "Use surrounding context, including context-only cues, to understand the situation and choose a natural pause.".into(),
        "Do not create a challenge for every cue. Return fewer challenges when appropriate, or an empty array when no strong opportunities exist.".into(),
        String::new(),
        "5. QUALITY RULES".into(),
        "Avoid articles, prepositions, grammatical fragments, obvious completions, ambiguous answers, trivia, repeated tests, and pauses that split a natural expression.".into(),
        "The learner must have enough preceding context to make a reasonable prediction, but must not hear or see the answer before choosing.".into(),
        "Do not use knowledge that is absent from the transcript. Do not create multiple equally correct answers.".into(),
        String::new(),
        "6. WORD REFERENCES AND TIMING".into(),
        "Use ONLY the global WORD numbers shown in this document. Never invent word numbers, cue numbers, timestamps, internal IDs, or timing values.".into(),
        "cue_number identifies the cue containing the first answer word.".into(),
        "clip_start_word is the first word to replay when the learner requests context replay. It must exist and must occur before or at the answer.".into(),
        "pause_before_word identifies the first answer word. Playback pauses immediately before this word.".into(),
        "answer_word_start and answer_word_end identify the exact contiguous answer span in the original transcript.".into(),
        "resume_after_word must equal answer_word_end. Playback resumes after that word.".into(),
        "The answer span must use existing consecutive WORD numbers and must reproduce the exact source words in their original order.".into(),
        String::new(),
        "7. FOUR ANSWER CHOICES".into(),
        "Every challenge must contain exactly four distinct choices and exactly one correct choice.".into(),
        "The correct choice must match the exact source answer, ignoring only case and surrounding punctuation. Incorrect choices must be plausible but clearly incorrect according to the source.".into(),
        "WORD choices should normally be single words. EXPRESSION choices should be short expressions. DIALOGUE choices should be natural conversational responses.".into(),
        "Do not reveal the correct answer in the prompt. Do not make the correct choice obviously longer or more detailed.".into(),
        String::new(),
        "8. EXPLANATIONS".into(),
        "explanation is short learner-facing feedback explaining why the answer fits the context.".into(),
        "editorial_rationale is for the human editor only. Explain why this moment is pedagogically valuable.".into(),
        String::new(),
        "9. SOURCE TRANSCRIPT AND NUMBERED WORDS".into(),
        text_sections.join("\n"),
        String::new(),
        "10. REQUIRED JSON OUTPUT".into(),
        "Return ONLY one valid JSON object. Do not use Markdown fences, comments, introductory text, or trailing commas.".into(),
        format!("contract must be exactly: {OUTPUT_CONTRACT}"),
        format!("source_hash must be copied exactly: {source_hash}"),
        r#"{
  "contract": "nova-generator-prediction-listening-output/1.0",
  "source_hash": "COPY_SOURCE_HASH_EXACTLY",
  "challenges": [
    {
      "challenge_number": 1,
      "cue_number": 12,
      "type": "word",
      "clip_start_word": 41,
      "pause_before_word": 46,
      "answer_word_start": 46,
      "answer_word_end": 46,
      "resume_after_word": 46,
      "prompt": "What word do you think comes next?",
      "choices": [
        { "text": "choice one", "is_correct": false },
        { "text": "choice two", "is_correct": true },
        { "text": "choice three", "is_correct": false },
        { "text": "choice four", "is_correct": false }
      ],
      "explanation": "Short explanation for the learner.",
      "editorial_rationale": "Why this moment is pedagogically valuable."
    }
  ]
}"#.into(),
        String::new(),
        "11. FINAL VALIDATION".into(),
        "Before responding, verify: exact contract and hash; unique positive challenge_number; allowed type; selected target cue; all cue and word references exist; clip_start_word is not after the answer; pause_before_word equals answer_word_start; answer words are contiguous; resume_after_word equals answer_word_end; exactly four unique choices and one correct answer; correct choice matches the source; prompt and explanations are non-empty.".into(),
        "If no high-quality challenges exist, return the same contract and source_hash with an empty challenges array.".into(),
        "Return JSON only.".into(),
    ];

    let mut files = std::collections::BTreeMap::new();
    files.insert("prediction-listening-entrada.txt".into(), sections.join("\n"));
    Ok(PredictionListeningPackage {
        package_version: "1.0".into(),
        contract_id: OUTPUT_CONTRACT.into(),
        source_hash,
        files,
    })
}

fn result_file(app: &AppHandle, project_id: &str, asset_id: &str) -> Result<std::path::PathBuf, String> {
    // Reuse the media layer's project/asset validation before constructing a module-owned path.
    let _ = crate::media::load_project_subtitles(app.clone(), project_id.to_string(), asset_id.to_string())?;
    let root = crate::media::project_media_root(app, project_id)?;
    let dir = root.join("prediction-listening");
    fs::create_dir_all(&dir).map_err(|e| format!("Não foi possível preparar a pasta do Prediction Listening: {e}"))?;
    Ok(dir.join(format!("{asset_id}.json")))
}

#[tauri::command]
pub fn prepare_prediction_listening_package(
    app: AppHandle,
    project_id: String,
    asset_id: String,
    cues: Vec<crate::media::SubtitleCue>,
    selected_cue_ids: Vec<String>,
    source_signature: String,
) -> Result<PredictionListeningPackage, String> {
    let plan = crate::media::load_shadowing_selection(
        app.clone(), project_id.clone(), asset_id.clone(), cues.clone(), source_signature.clone()
    )?.ok_or("Conclua e salve o Shadowing antes de preparar o Prediction Listening.")?;
    if plan.source_signature != source_signature || plan.selected_cue_ids != selected_cue_ids {
        return Err("A seleção salva do Shadowing não corresponde à transcrição atual. Revise e salve o Shadowing novamente.".into());
    }
    build_external_package(&cues, &selected_cue_ids)
}

#[tauri::command]
pub fn load_prediction_listening_result(
    app: AppHandle,
    project_id: String,
    asset_id: String,
) -> Result<Option<Value>, String> {
    let path = result_file(&app, &project_id, &asset_id)?;
    if !path.exists() { return Ok(None); }
    let raw = fs::read_to_string(path).map_err(|e| format!("Não foi possível ler o Prediction Listening salvo: {e}"))?;
    if raw.trim().is_empty() { return Ok(None); }
    serde_json::from_str(&raw).map(Some).map_err(|e| format!("Resultado salvo do Prediction Listening inválido: {e}"))
}

#[tauri::command]
pub fn save_prediction_listening_result(
    app: AppHandle,
    project_id: String,
    asset_id: String,
    result: Value,
) -> Result<(), String> {
    if !result.is_object() { return Err("O resultado do Prediction Listening precisa ser um objeto JSON.".into()); }
    let bytes = serde_json::to_vec_pretty(&result).map_err(|e| e.to_string())?;
    if bytes.is_empty() || bytes.len() > 10 * 1024 * 1024 {
        return Err("O resultado do Prediction Listening está vazio ou excede 10 MB.".into());
    }
    let path = result_file(&app, &project_id, &asset_id)?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, bytes).map_err(|e| format!("Não foi possível salvar o Prediction Listening: {e}"))?;
    if path.exists() { fs::remove_file(&path).map_err(|e| e.to_string())?; }
    fs::rename(temp, path).map_err(|e| format!("Não foi possível concluir o salvamento do Prediction Listening: {e}"))
}

#[tauri::command]
pub fn save_prediction_listening_export(path: String, bytes: Vec<u8>) -> Result<(), String> {
    if !path.to_ascii_lowercase().ends_with(".json") {
        return Err("O material aprovado precisa ser salvo como arquivo .json.".into());
    }
    if bytes.is_empty() || bytes.len() > 20 * 1024 * 1024 {
        return Err("O arquivo JSON está vazio ou excede 20 MB.".into());
    }
    fs::write(&path, bytes).map_err(|e| format!("Não foi possível gravar o JSON aprovado: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::SubtitleCue;
    use crate::transcription::TranscriptWord;

    fn cue(id: &str, text: &str, start: u64, words: Vec<TranscriptWord>, aligned: bool) -> SubtitleCue {
        let end = words.last().map(|word| word.end_ms).unwrap_or(start + 1000);
        SubtitleCue {
            id: id.into(),
            start_ms: start,
            end_ms: end.max(start + 1),
            text: text.into(),
            words: Some(words),
            language: Some("en".into()),
            word_alignment: if aligned { Some("whisperx".into()) } else { None },
            word_alignment_hash: None,
        }
    }

    #[test]
    fn builds_txt_with_hash_and_numbered_words() {
        let cues = vec![
            cue("cue-a", "I thought you were going.", 0, vec![
                TranscriptWord { text: "I".into(), start_ms: 0, end_ms: 100 },
                TranscriptWord { text: "thought".into(), start_ms: 100, end_ms: 300 },
            ], true),
        ];
        let package = build_external_package(&cues, &["cue-a".into()]).unwrap();
        let txt = package.files.get("prediction-listening-entrada.txt").unwrap();
        assert!(txt.contains("SOURCE_HASH:"));
        assert!(txt.contains("[WORD 000001] I"));
        assert!(txt.contains("[WORD 000002] thought"));
        assert_eq!(package.contract_id, OUTPUT_CONTRACT);
    }

    #[test]
    fn refuses_selected_cues_without_whisperx_alignment() {
        let cues = vec![cue("cue-a", "Hello there.", 0, vec![
            TranscriptWord { text: "Hello".into(), start_ms: 0, end_ms: 300 },
        ], false)];
        let error = build_external_package(&cues, &["cue-a".into()]).unwrap_err();
        assert!(error.contains("WhisperX"));
    }
}
