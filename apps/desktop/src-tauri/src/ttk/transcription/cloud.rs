use reqwest::blocking::{multipart, Client};
use serde::Deserialize;
use std::{path::{Path, PathBuf}, time::Duration};
use tauri::{AppHandle, Emitter};
use super::{chunk_audio, emit, ffmpeg, TranscriptCue, TranscriptResult, TranscriptWord};
use crate::translation::{resolve_api_endpoint, resolve_api_key};

const GROQ_MODEL: &str = "whisper-large-v3-turbo";

#[derive(Deserialize)]
struct GroqResponse {
    text: Option<String>,
    language: Option<String>,
    segments: Option<Vec<GroqSegment>>,
}
#[derive(Deserialize)]
struct GroqSegment {
    start: f64,
    end: f64,
    text: String,
    words: Option<Vec<GroqWord>>,
}
#[derive(Deserialize)]
struct GroqWord {
    start: Option<f64>,
    end: Option<f64>,
    word: String,
}

fn groq_chunk(client: &Client, key: &str, endpoint: &str, path: &Path, language: Option<&str>) -> Result<GroqResponse, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Não foi possível ler bloco de áudio: {e}"))?;
    if bytes.len() > 25 * 1024 * 1024 { return Err("Um bloco ultrapassou o limite de 25 MB da API. Reduza a duração dos blocos.".into()); }
    let part = multipart::Part::bytes(bytes).file_name("audio.flac").mime_str("audio/flac").map_err(|e| e.to_string())?;
    let mut form = multipart::Form::new().text("model", GROQ_MODEL).text("response_format", "verbose_json")
        .text("temperature", "0").text("timestamp_granularities[]", "word")
        .text("timestamp_granularities[]", "segment").part("file", part);
    if let Some(lang) = language { if !lang.trim().is_empty() { form = form.text("language", lang.to_string()); } }
    let response = client.post(endpoint).bearer_auth(key).multipart(form).send()
        .map_err(|e| format!("Falha de conexão com a Groq: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(format!("Groq HTTP {status}: {}", body.chars().take(500).collect::<String>()));
    }
    response.json::<GroqResponse>().map_err(|e| format!("Resposta de transcrição inválida: {e}"))
}
pub(super) fn transcribe_cloud(app: &AppHandle, project_id: &str, audio: &Path, directory: &Path, duration: u64, language: Option<&str>) -> Result<TranscriptResult, String> {
    let chunks = chunk_audio(&ffmpeg()?, audio, directory, duration)?;
    let total = chunks.len();
    let client = Client::builder().timeout(Duration::from_secs(180)).build().map_err(|e| e.to_string())?;
    let key = resolve_api_key(app)?;
    let endpoint = format!("{}/audio/transcriptions", resolve_api_endpoint(app)?.trim_end_matches('/'));
    let mut cues: Vec<TranscriptCue> = Vec::new();
    let mut detected_language = language.map(str::to_string);
    for (index, (path, offset)) in chunks.iter().enumerate() {
        emit(app, project_id, "cloud", (index as f32 / total.max(1) as f32) * 100.0, index, total, &format!("Transcrevendo bloco {} de {}", index + 1, total));
        let mut last = String::new();
        let mut response = None;
        for attempt in 0..4 {
            match groq_chunk(&client, &key, &endpoint, path, language) {
                Ok(value) => { response = Some(value); break; }
                Err(error) => {
                    last = error;
                    let retryable = last.contains("HTTP 429") || last.contains("HTTP 5") || last.contains("Falha de conexão");
                    if !retryable || attempt == 3 { break; }
                    std::thread::sleep(Duration::from_secs((2u64.pow(attempt)).min(12)));
                }
            }
        }
        let result = response.ok_or_else(|| last.clone())?;
        if detected_language.is_none() { detected_language = result.language.clone(); }
        for segment in result.segments.unwrap_or_default() {
            let start_ms = offset.saturating_add((segment.start.max(0.0) * 1000.0) as u64);
            let end_ms = offset.saturating_add((segment.end.max(segment.start) * 1000.0) as u64);
            let text = segment.text.trim().to_string();
            if text.is_empty() || end_ms <= start_ms { continue; }
            let words = segment.words.unwrap_or_default().into_iter().filter_map(|word| {
                let start = word.start?; let end = word.end?;
                Some(TranscriptWord { text: word.word, start_ms: offset.saturating_add((start.max(0.0)*1000.0) as u64), end_ms: offset.saturating_add((end.max(start)*1000.0) as u64) })
            }).collect();
            let duplicate = cues.iter().any(|cue| cue.text.eq_ignore_ascii_case(&text) && cue.start_ms.abs_diff(start_ms) < 1800);
            if !duplicate { cues.push(TranscriptCue { id: uuid::Uuid::new_v4().to_string(), text, start_ms, end_ms, words }); }
        }
        emit(app, project_id, "cloud", ((index + 1) as f32 / total.max(1) as f32) * 100.0, index + 1, total, &format!("Bloco {} de {} concluído", index + 1, total));
    }
    cues.sort_by_key(|cue| cue.start_ms);
    Ok(TranscriptResult { engine: "groq".into(), model: GROQ_MODEL.into(), language: detected_language, duration_ms: duration, cues })
}
