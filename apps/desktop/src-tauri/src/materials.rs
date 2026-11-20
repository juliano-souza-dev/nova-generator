use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::Stdio,
};
use tauri::{AppHandle, Manager};

fn materials_file(app: &AppHandle, project_id: &str, asset_id: &str) -> Result<PathBuf, String> {
    let _ = crate::media::load_project_subtitles(app.clone(), project_id.to_string(), asset_id.to_string())?;
    let root = crate::media::project_media_root(app, project_id)?;
    let dir = root.join("materials");
    fs::create_dir_all(&dir).map_err(|e| format!("Não foi possível preparar a pasta de Materiais: {e}"))?;
    Ok(dir.join(format!("{asset_id}.json")))
}

#[tauri::command]
pub fn load_project_materials(app: AppHandle, project_id: String, asset_id: String) -> Result<Option<Value>, String> {
    let path = materials_file(&app, &project_id, &asset_id)?;
    if !path.exists() { return Ok(None); }
    let raw = fs::read_to_string(path).map_err(|e| format!("Não foi possível ler os Materiais salvos: {e}"))?;
    if raw.trim().is_empty() { return Ok(None); }
    serde_json::from_str(&raw).map(Some).map_err(|e| format!("Dados de Materiais inválidos: {e}"))
}

#[tauri::command]
pub fn save_project_materials(app: AppHandle, project_id: String, asset_id: String, materials: Value) -> Result<(), String> {
    if !materials.is_object() { return Err("Os Materiais precisam ser enviados como um objeto JSON.".into()); }
    let bytes = serde_json::to_vec_pretty(&materials).map_err(|e| e.to_string())?;
    if bytes.is_empty() || bytes.len() > 20 * 1024 * 1024 {
        return Err("Os Materiais estão vazios ou excedem o limite de 20 MB.".into());
    }
    let path = materials_file(&app, &project_id, &asset_id)?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, bytes).map_err(|e| format!("Não foi possível salvar os Materiais: {e}"))?;
    if path.exists() { fs::remove_file(&path).map_err(|e| e.to_string())?; }
    fs::rename(temp, path).map_err(|e| format!("Não foi possível concluir o salvamento dos Materiais: {e}"))
}

fn smart_learning_moments_file(app: &AppHandle, project_id: &str, asset_id: &str) -> Result<PathBuf, String> {
    let _ = crate::media::load_project_subtitles(app.clone(), project_id.to_string(), asset_id.to_string())?;
    let root = crate::media::project_media_root(app, project_id)?;
    let dir = root.join("materials").join("smart-learning-moments");
    fs::create_dir_all(&dir).map_err(|e| format!("Não foi possível preparar a pasta Smart Learning Moments: {e}"))?;
    Ok(dir.join(format!("{asset_id}.json")))
}

#[tauri::command]
pub fn load_smart_learning_moments(app: AppHandle, project_id: String, asset_id: String) -> Result<Option<Value>, String> {
    let path = smart_learning_moments_file(&app, &project_id, &asset_id)?;
    if !path.exists() { return Ok(None); }
    let raw = fs::read_to_string(path).map_err(|e| format!("Não foi possível ler Smart Learning Moments: {e}"))?;
    if raw.trim().is_empty() { return Ok(None); }
    serde_json::from_str(&raw).map(Some).map_err(|e| format!("Dados Smart Learning Moments inválidos: {e}"))
}

#[tauri::command]
pub fn save_smart_learning_moments(
    app: AppHandle, project_id: String, asset_id: String, value: Option<Value>,
) -> Result<(), String> {
    let path = smart_learning_moments_file(&app, &project_id, &asset_id)?;
    let Some(moment) = value else {
        if path.exists() { fs::remove_file(path).map_err(|e| format!("Não foi possível remover Smart Learning Moments: {e}"))?; }
        return Ok(());
    };
    if !moment.is_object() { return Err("Smart Learning Moments precisa ser um objeto JSON.".into()); }
    let bytes = serde_json::to_vec_pretty(&moment).map_err(|e| e.to_string())?;
    if bytes.is_empty() || bytes.len() > 20 * 1024 * 1024 {
        return Err("Smart Learning Moments está vazio ou excede o limite de 20 MB.".into());
    }
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, bytes).map_err(|e| format!("Não foi possível salvar Smart Learning Moments: {e}"))?;
    if path.exists() { fs::remove_file(&path).map_err(|e| format!("Não foi possível substituir Smart Learning Moments: {e}"))?; }
    fs::rename(temp, path).map_err(|e| format!("Não foi possível concluir o salvamento de Smart Learning Moments: {e}"))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioRequest {
    pub card_id: String,
    pub text: String,
    #[serde(default = "default_language")]
    pub language: String,
}
fn default_language() -> String { "English".into() }

/// Qwen3-TTS expects its canonical language names, not locale codes such as en-US.
fn normalize_qwen_language(language: &str) -> Result<&'static str, String> {
    let normalized = language.trim().to_ascii_lowercase().replace('_', "-");
    match normalized.as_str() {
        "english" | "en" | "en-us" | "en-gb" | "en-au" | "en-ca" => Ok("English"),
        "portuguese" | "pt" | "pt-br" | "pt-pt" => Ok("Portuguese"),
        "chinese" | "zh" | "zh-cn" | "zh-tw" => Ok("Chinese"),
        "japanese" | "ja" => Ok("Japanese"),
        "korean" | "ko" => Ok("Korean"),
        "german" | "de" => Ok("German"),
        "french" | "fr" => Ok("French"),
        "russian" | "ru" => Ok("Russian"),
        "spanish" | "es" => Ok("Spanish"),
        "italian" | "it" => Ok("Italian"),
        _ => Err(format!(
            "Idioma de síntese '{language}' não reconhecido pelo Nova Generator. Use um idioma suportado pelo Qwen3-TTS."
        )),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioResult {
    pub card_id: String,
    pub audio_path: String,
    pub sample_rate: u32,
    pub language: String,
    pub speaker: String,
}

fn generate_audio_batch(
    app: &AppHandle,
    project_id: &str,
    asset_id: &str,
    voice_id: &str,
    requests: Vec<AudioRequest>,
) -> Result<Vec<AudioResult>, String> {
    if requests.is_empty() { return Ok(Vec::new()); }
    if requests.len() > 100 { return Err("Gere até 100 áudios por operação.".into()); }
    let mut seen = std::collections::HashSet::new();
    for request in &requests {
        if request.card_id.is_empty() || request.card_id.len() > 80 ||
            !request.card_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err("Um card contém um identificador inválido para o arquivo de áudio.".into());
        }
        if !seen.insert(request.card_id.as_str()) {
            return Err("A solicitação contém IDs de cards duplicados.".into());
        }
        if request.text.trim().is_empty() || request.text.chars().count() > 2000 {
            return Err(format!("O texto do card '{}' está vazio ou excede 2.000 caracteres.", request.card_id));
        }
        // Normalize locale tags to the exact language labels expected by Qwen3-TTS.
        normalize_qwen_language(&request.language)?;
    }

    // Voice profiles and their runtime are owned by Shared Runtime Manager.
    // The Nova project stores only the generated card audio, never a profile copy.
    let voice = crate::shared_runtime::voice_profile_runtime_for_app(app, voice_id)?;
    let python = &voice.python;
    let runner = &voice.runner;
    let model = &voice.model;
    let profile = &voice.profile;
    let voice_name = &voice.name;
    let target = materials_file(app, project_id, asset_id)?;
    let audio_dir = target.parent().ok_or("Pasta de Materiais inválida.")?.join("audio");
    fs::create_dir_all(&audio_dir).map_err(|e| format!("Não foi possível preparar a pasta de áudios: {e}"))?;

    let mut child = crate::process::hidden_command(&python)
        .arg(&runner)
        .arg(&model)
        .arg(&profile)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Não foi possível iniciar o executor da voz '{voice_name}' no Shared Runtime: {e}"))?;

    {
        let stdin = child.stdin.as_mut().ok_or("Não foi possível abrir a entrada do executor de voz.")?;
        for request in &requests {
            let output_path = audio_dir.join(format!("{}.wav", request.card_id));
            let payload = json!({
                "id": request.card_id,
                "operation": "synthesize",
                "text": request.text.trim(),
                "language": normalize_qwen_language(&request.language)?,
                "output_path": output_path,
                "voice_mode": voice.mode,
                "instruct": voice.instruct
            });
            serde_json::to_writer(&mut *stdin, &payload)
                .map_err(|e| format!("Não foi possível preparar a solicitação de áudio: {e}"))?;
            stdin.write_all(b"\n")
                .map_err(|e| format!("Não foi possível enviar a solicitação ao executor de voz: {e}"))?;
        }
    }
    drop(child.stdin.take());

    let output = child.wait_with_output()
        .map_err(|e| format!("Não foi possível finalizar a síntese da voz '{voice_name}': {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut responses = Vec::with_capacity(requests.len());
    let mut diagnostics = Vec::new();
    let mut executor_error: Option<Value> = None;

    for (line_number, line) in stdout.lines().map(str::trim).filter(|line| !line.is_empty()).enumerate() {
        match serde_json::from_str::<Value>(line) {
            Ok(response) => {
                if response.get("status").and_then(Value::as_str) == Some("completed") {
                    responses.push(response);
                } else {
                    executor_error = Some(response);
                }
            }
            Err(error) => {
                let preview: String = line.chars().take(1800).collect();
                diagnostics.push(format!("stdout linha {}: {} (JSON: {})", line_number + 1, preview, error));
            }
        }
    }

    let stderr_detail = stderr.lines().rev().take(16)
        .collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
    if let Some(response) = executor_error {
        let stage = response.get("stage").and_then(Value::as_str).unwrap_or("não informada");
        let operation = response.get("operation").and_then(Value::as_str).unwrap_or("não informada");
        let card_id = response.get("id").and_then(Value::as_str).unwrap_or("não associado");
        let error_type = response.get("error_type").and_then(Value::as_str).unwrap_or("Erro não classificado");
        let error = response.get("error").and_then(Value::as_str).unwrap_or("O worker não informou a causa.");
        let traceback = response.get("traceback").and_then(Value::as_str).unwrap_or("");
        let mut detail = format!(
            "Falha na síntese da voz '{voice_name}'. Etapa: {stage}. Operação: {operation}. Card: {card_id}.\nTipo: {error_type}.\nCausa: {error}"
        );
        if !traceback.trim().is_empty() {
            detail.push_str("\n\nRastreamento Python:\n");
            detail.push_str(traceback.trim());
        }
        if !stderr_detail.trim().is_empty() {
            detail.push_str("\n\nSaída de diagnóstico (stderr):\n");
            detail.push_str(&stderr_detail);
        }
        if !output.status.success() {
            detail.push_str(&format!("\n\nCódigo de encerramento: {}", output.status));
        }
        return Err(detail);
    }

    if !output.status.success() {
        let stdout_detail = diagnostics.join("\n");
        let mut detail = format!(
            "O executor da voz '{voice_name}' encerrou com falha. Código de encerramento: {}.",
            output.status
        );
        if !stdout_detail.is_empty() {
            detail.push_str("\n\nSaída não reconhecida (stdout):\n");
            detail.push_str(&stdout_detail);
        }
        if !stderr_detail.is_empty() {
            detail.push_str("\n\nErro do processo (stderr):\n");
            detail.push_str(&stderr_detail);
        }
        if stdout_detail.is_empty() && stderr_detail.is_empty() {
            detail.push_str("\nO processo não forneceu stdout nem stderr.");
        }
        return Err(detail);
    }

    if !diagnostics.is_empty() && responses.len() != requests.len() {
        let detail = diagnostics.join("\n");
        return Err(format!(
            "O executor da voz '{voice_name}' produziu uma saída que não pôde ser interpretada. Foram recebidas {} respostas válidas para {} solicitações.\n\nSaída original (stdout):\n{}{}",
            responses.len(),
            requests.len(),
            detail,
            if stderr_detail.is_empty() { String::new() } else { format!("\n\nDiagnóstico (stderr):\n{stderr_detail}") }
        ));
    }

    if responses.len() != requests.len() {
        return Err(format!(
            "O executor da voz '{voice_name}' concluiu sem retornar todas as respostas. Recebidas: {}. Solicitadas: {}. Código de encerramento: {}.{}",
            responses.len(),
            requests.len(),
            output.status,
            if stderr_detail.is_empty() { String::new() } else { format!("\n\nDiagnóstico (stderr):\n{stderr_detail}") }
        ));
    }

    let mut results = Vec::with_capacity(responses.len());
    for response in responses {
        let id = response.get("id").and_then(Value::as_str)
            .ok_or("A resposta do executor de voz não contém o ID do card.")?.to_string();
        let path = audio_dir.join(format!("{id}.wav"));
        if !path.is_file() || fs::metadata(&path).map(|meta| meta.len() == 0).unwrap_or(true) {
            return Err(format!("A voz '{voice_name}' informou sucesso, mas o áudio do card '{id}' não foi encontrado ou está vazio."));
        }
        let canonical = path.canonicalize()
            .map_err(|e| format!("Não foi possível validar o áudio gerado: {e}"))?;
        app.asset_protocol_scope().allow_file(&canonical)
            .map_err(|e| format!("Não foi possível liberar a reprodução do áudio gerado: {e}"))?;
        results.push(AudioResult {
            card_id: id.clone(),
            audio_path: path.to_string_lossy().into_owned(),
            sample_rate: response.get("sample_rate").and_then(Value::as_u64).unwrap_or(0) as u32,
            language: normalize_qwen_language(
                &requests.iter().find(|request| request.card_id == id)
                    .map(|request| request.language.as_str())
                    .unwrap_or("English")
            )?.into(),
            speaker: voice_name.clone(),
        });
    }
    Ok(results)
}

#[tauri::command]
pub async fn extract_material_source_audio(
    app: AppHandle, project_id: String, asset_id: String, card_id: String, start_ms: u64, end_ms: u64,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if card_id.is_empty() || card_id.len() > 80 || !card_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err("Identificador de card inválido para extração de áudio.".into());
        }
        if end_ms <= start_ms || end_ms - start_ms > 120_000 {
            return Err("O intervalo de áudio do card é inválido ou excede 2 minutos.".into());
        }
        let source = PathBuf::from(crate::media::open_project_media(app.clone(), project_id.clone(), asset_id.clone())?);
        let target = materials_file(&app, &project_id, &asset_id)?;
        let audio_dir = target.parent().ok_or("Pasta de Materiais inválida.")?.join("audio");
        fs::create_dir_all(&audio_dir).map_err(|e| format!("Não foi possível preparar a pasta de áudio: {e}"))?;
        let output = audio_dir.join(format!("{card_id}-source.wav"));
        let ffmpeg = crate::media::shared_ffmpeg_path(&app)?;
        let result = crate::process::hidden_command(&ffmpeg)
            .arg("-y").arg("-ss").arg(format!("{:.3}", start_ms as f64 / 1000.0))
            .arg("-i").arg(&source).arg("-t").arg(format!("{:.3}", (end_ms - start_ms) as f64 / 1000.0))
            .args(["-vn", "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le"])
            .arg(&output).output().map_err(|e| format!("Não foi possível iniciar o FFmpeg para extrair o áudio original: {e}"))?;
        if !result.status.success() || !output.is_file() || fs::metadata(&output).map(|meta| meta.len() == 0).unwrap_or(true) {
            let detail = String::from_utf8_lossy(&result.stderr);
            return Err(format!("Não foi possível extrair o áudio original deste trecho: {}", detail.trim()));
        }
        let canonical = output.canonicalize().map_err(|e| e.to_string())?;
        app.asset_protocol_scope().allow_file(&canonical)
            .map_err(|e| format!("Não foi possível liberar a reprodução do áudio original: {e}"))?;
        Ok(output.to_string_lossy().into_owned())
    }).await.map_err(|e| format!("A extração do áudio foi interrompida: {e}"))?
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartLessonAudioSegment {
    pub segment_id: String,
    pub audio_path: Option<String>,
    pub audio_base64: Option<String>,
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartLessonMergedAudio {
    pub audio_path: String,
    pub file_name: String,
    pub mime_type: String,
    pub segment_count: usize,
}

#[tauri::command]
pub async fn merge_smart_learning_moment_audio(
    app: AppHandle, project_id: String, asset_id: String, lesson_id: String,
    segments: Vec<SmartLessonAudioSegment>,
) -> Result<SmartLessonMergedAudio, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if lesson_id.is_empty() || lesson_id.len() > 100 ||
            !lesson_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err("Identificador da mini aula inválido.".to_string());
        }
        if segments.is_empty() || segments.len() > 30 {
            return Err("A mini aula precisa ter entre 1 e 30 segmentos de áudio.".to_string());
        }
        let mut seen = std::collections::HashSet::new();
        let root = crate::media::project_media_root(&app, &project_id)?;
        let audio_dir = root.join("materials").join("smart-learning-moments").join("audio");
        fs::create_dir_all(&audio_dir).map_err(|e| format!("Não foi possível preparar a pasta de áudio final: {e}"))?;
        let output = audio_dir.join(format!("{asset_id}-{lesson_id}.mp3"));
        let temp_dir = audio_dir.join(format!(".merge-{asset_id}-{lesson_id}"));
        if temp_dir.exists() { fs::remove_dir_all(&temp_dir).map_err(|e| e.to_string())?; }
        fs::create_dir_all(&temp_dir).map_err(|e| format!("Não foi possível preparar os segmentos: {e}"))?;

        let result = (|| -> Result<(), String> {
            let mut inputs = Vec::<PathBuf>::new();
            for (index, segment) in segments.iter().enumerate() {
                if segment.segment_id.trim().is_empty() || !seen.insert(segment.segment_id.as_str()) {
                    return Err("A lista contém identificadores de segmento vazios ou duplicados.".into());
                }
                let input = if let Some(encoded) = segment.audio_base64.as_deref() {
                    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded)
                        .map_err(|e| format!("Áudio Base64 inválido no segmento {}: {e}", segment.segment_id))?;
                    if bytes.is_empty() || bytes.len() > 50 * 1024 * 1024 {
                        return Err(format!("O áudio do segmento {} está vazio ou excede 50 MB.", segment.segment_id));
                    }
                    let ext = match segment.mime_type.as_deref().unwrap_or("audio/mpeg") {
                        "audio/wav" | "audio/x-wav" => "wav",
                        "audio/mp4" | "audio/x-m4a" => "m4a",
                        "audio/ogg" => "ogg",
                        "audio/aac" => "aac",
                        _ => "mp3"
                    };
                    let path = temp_dir.join(format!("{:03}.{}", index + 1, ext));
                    fs::write(&path, bytes).map_err(|e| format!("Não foi possível gravar o segmento {}: {e}", segment.segment_id))?;
                    path
                } else if let Some(source) = segment.audio_path.as_deref() {
                    let path = PathBuf::from(source);
                    if !path.is_file() { return Err(format!("Arquivo de áudio não encontrado para o segmento {}.", segment.segment_id)); }
                    path
                } else {
                    return Err(format!("O segmento {} não possui arquivo de áudio.", segment.segment_id));
                };
                inputs.push(input);
            }
            let ffmpeg = crate::media::shared_ffmpeg_path(&app)?;
            let mut command = crate::process::hidden_command(&ffmpeg);
            command.arg("-y");
            for input in &inputs { command.arg("-i").arg(input); }
            let mut filters = Vec::new();
            for index in 0..inputs.len() {
                filters.push(format!("[{}:a:0]aresample=24000,aformat=sample_fmts=fltp:channel_layouts=mono[a{}]", index, index));
            }
            let concat_inputs = (0..inputs.len()).map(|i| format!("[a{}]", i)).collect::<String>();
            filters.push(format!("{}concat=n={}:v=0:a=1[outa]", concat_inputs, inputs.len()));
            let status = command.arg("-filter_complex").arg(filters.join(";"))
                .arg("-map").arg("[outa]").arg("-c:a").arg("libmp3lame")
                .arg("-b:a").arg("128k").arg("-ar").arg("24000")
                .arg(&output).output()
                .map_err(|e| format!("Não foi possível iniciar o FFmpeg para unificar a mini aula: {e}"))?;
            if !status.status.success() {
                let detail = String::from_utf8_lossy(&status.stderr);
                return Err(format!("Falha ao unificar os áudios da mini aula: {}", detail.lines().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" ")));
            }
            if !output.is_file() || fs::metadata(&output).map(|m| m.len()).unwrap_or(0) == 0 {
                return Err("O FFmpeg terminou sem produzir o áudio final da mini aula.".into());
            }
            Ok(())
        })();
        let _ = fs::remove_dir_all(&temp_dir);
        result?;
        let canonical = output.canonicalize().map_err(|e| e.to_string())?;
        app.asset_protocol_scope().allow_file(&canonical)
            .map_err(|e| format!("Não foi possível liberar a reprodução do áudio final: {e}"))?;
        Ok(SmartLessonMergedAudio {
            audio_path: canonical.to_string_lossy().into_owned(),
            file_name: output.file_name().unwrap_or_default().to_string_lossy().into_owned(),
            mime_type: "audio/mpeg".into(),
            segment_count: segments.len(),
        })
    }).await.map_err(|e| format!("A unificação da mini aula foi interrompida: {e}"))?
}

#[tauri::command]
pub async fn generate_material_audio(
    app: AppHandle, project_id: String, asset_id: String, voice_id: String, requests: Vec<AudioRequest>,
) -> Result<Vec<AudioResult>, String> {
    tauri::async_runtime::spawn_blocking(move || generate_audio_batch(&app, &project_id, &asset_id, &voice_id, requests))
        .await.map_err(|e| format!("A geração de áudio foi interrompida: {e}"))?
}

const APKG_EXPORT_SCRIPT: &str = r#"
import hashlib, html, json, os, pathlib, shutil, sqlite3, subprocess, sys, tempfile, time, uuid, zipfile
source = pathlib.Path(sys.argv[1])
output = pathlib.Path(sys.argv[2])
ffmpeg = pathlib.Path(sys.argv[3])
data = json.loads(source.read_text(encoding="utf-8"))
cards = [card for card in data.get("cards", []) if card.get("status") == "approved"]
if not cards:
    raise SystemExit("Aprove ao menos um card Anki antes de exportar.")
if any(not str(card.get("focus") or "").strip() or not str(card.get("meaning") or "").strip() for card in cards):
    raise SystemExit("Todos os cards aprovados precisam ter frente e verso preenchidos.")
for card in cards:
    audio = card.get("audioPath")
    if not audio or not pathlib.Path(audio).is_file():
        raise SystemExit("Gere o áudio de todos os cards aprovados antes de exportar o pacote Anki.")
output.parent.mkdir(parents=True, exist_ok=True)
stamp = int(time.time())
deck_id = max(1000000000, stamp * 1000)
model_id = deck_id + 1
with tempfile.TemporaryDirectory(prefix="nova-anki-") as temporary:
    work = pathlib.Path(temporary)
    db_path = work / "collection.anki2"
    media_map = {}
    audio_entries = []
    db = sqlite3.connect(db_path)
    db.executescript("""
    CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);
    CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
    CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
    CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
    CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
    CREATE INDEX ix_notes_usn on notes (usn);
    CREATE INDEX ix_cards_usn on cards (usn);
    CREATE INDEX ix_cards_nid on cards (nid);
    CREATE INDEX ix_cards_sched on cards (did, queue, due);
    CREATE INDEX ix_revlog_usn on revlog (usn);
    CREATE INDEX ix_revlog_cid on revlog (cid);
    """)
    now = stamp
    fields = ["FrontSentence", "BackSentence", "CardType", "FocusDetail", "MeaningDetail", "Explanation", "ExampleEn", "ExamplePt", "Speaker", "Audio"]
    field_defs = [{"name": name, "ord": index, "sticky": False, "rtl": False, "font": "Arial", "size": 20, "media": []} for index, name in enumerate(fields)]
    front_template = """{{#Audio}}<div class='flashcard-audio'>{{Audio}}</div>{{/Audio}}<span class='flashcard-direction'>EN → PT</span><h2 class='flashcard-sentence'>{{FrontSentence}}</h2>"""
    back_template = """<div class='flashcard-answer-primary'><h3 class='flashcard-sentence is-pt'>{{BackSentence}}</h3></div><div class='flashcard-mini-lesson'><span class='flashcard-mini-lesson-title'>MINI LESSON</span><section class='flashcard-lesson-summary'><span>{{CardType}}</span><strong>{{FocusDetail}}</strong><small>MEANING</small><b>{{MeaningDetail}}</b></section><section class='flashcard-lesson-explanation'><span>HOW TO UNDERSTAND / USE</span><p>{{Explanation}}</p></section><section class='flashcard-lesson-example'><span>ANOTHER EXAMPLE</span><strong>{{ExampleEn}}</strong><small>{{ExamplePt}}</small></section>{{#Speaker}}<p class='flashcard-speaker'>Speaker: {{Speaker}}</p>{{/Speaker}}{{#Audio}}<div class='flashcard-scene-audio'>Card audio: {{Audio}}</div>{{/Audio}}</div>"""
    css = """
    .card { font-family: Arial, sans-serif; font-size: 18px; text-align: left; color: #071828; background: #f4f7fa; padding: 18px; }
    .flashcard-front,.flashcard-answer { max-width: 700px; margin: 0 auto; padding: 28px; background: #fff; border: 1px solid #dbe3ea; border-radius: 18px; }
    .flashcard-audio { margin-bottom: 18px; }
    .flashcard-direction { display: inline-flex; padding: 8px 12px; color: #08785f; background: #dcf8ea; border-radius: 8px; font-size: 12px; font-weight: 900; letter-spacing: .04em; }
    .flashcard-sentence { margin: 20px 0 0; color: #071828; font-size: 30px; font-weight: 850; letter-spacing: -.035em; line-height: 1.25; }
    .flashcard-sentence.is-pt { color: #078342; margin: 0; }
    .flashcard-focus-highlight { padding: .08em .18em; color: #8a5100; background: #ffd56a; border-radius: .18em; font-weight: 900; }
    .flashcard-answer-primary { padding: 18px 0 22px; border-bottom: 1px solid #dbe3ea; margin-bottom: 18px; }
    .flashcard-mini-lesson { display: grid; gap: 12px; }
    .flashcard-mini-lesson-title { color: #153049; font-size: 12px; font-weight: 950; letter-spacing: .13em; }
    .flashcard-lesson-summary { display: grid; gap: 5px; padding: 16px 18px; background: #e9f3fd; border-left: 4px solid #317fd3; }
    .flashcard-lesson-summary>span,.flashcard-lesson-summary>small,.flashcard-lesson-explanation>span,.flashcard-lesson-example>span { color: #2458a0; font-size: 10px; font-weight: 950; letter-spacing: .09em; }
    .flashcard-lesson-summary>strong { color: #0b2f64; font-size: 22px; line-height: 1.22; }
    .flashcard-lesson-summary>small { margin-top: 2px; color: #9a4c00; }
    .flashcard-lesson-summary>b { color: #9a4c00; font-size: 16px; line-height: 1.35; }
    .flashcard-lesson-explanation { padding: 15px 18px 16px; background: #f1f3f5; border-left: 4px solid #df6f67; }
    .flashcard-lesson-explanation>span { color: #16314a; }
    .flashcard-lesson-explanation>p { margin: 8px 0 0; color: #17324b; font-size: 15px; line-height: 1.6; }
    .flashcard-lesson-example { display: grid; gap: 4px; padding: 13px 16px; background: #fff; border: 1px solid #dbe3ea; border-radius: 9px; }
    .flashcard-lesson-example>span { color: #9a4c00; }
    .flashcard-lesson-example>strong { color: #12283b; font-size: 15px; line-height: 1.45; }
    .flashcard-lesson-example>small { color: #566574; font-size: 13px; line-height: 1.45; }
    .flashcard-speaker { color: #566574; font-size: 12px; }
    .flashcard-scene-audio { margin-top: 12px; color: #9a4c00; font-size: 12px; }
    """
    model = {
      "id": model_id, "name": "iHub English · Didactic v3", "type": 0, "mod": now, "usn": -1, "sortf": 0, "did": deck_id,
      "tmpls": [{"name": "EN → PT · Didactic v3", "ord": 0, "qfmt": front_template, "afmt": back_template, "bqfmt": "", "bafmt": "", "did": None, "bfont": "Arial", "bsize": 20}],
      "flds": field_defs, "css": css, "latexPre": "", "latexPost": "", "req": [[0, "all", [0]]], "vers": []
    }
    deck = {"id": deck_id, "name": "iHubEnglish · " + str(data.get("assetName") or "English Materials"), "mod": now, "usn": -1, "desc": "iHub English Didactic v3 cards generated by Nova Generator", "dyn": 0, "collapsed": False, "browserCollapsed": False, "conf": 1}
    decks = {"1": {"id": 1, "name": "Default", "mod": now, "usn": -1, "desc": "", "dyn": 0, "collapsed": False, "browserCollapsed": False, "conf": 1}, str(deck_id): deck}
    conf = {"activeDecks": [deck_id], "curDeck": deck_id, "newSpread": 0, "collapseTime": 1200, "timeLim": 0, "estTimes": True, "dueCounts": True, "curModel": model_id}
    db.execute("INSERT INTO col VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?)", (now - 86400, now, now, 11, 0, -1, 0, json.dumps({"activeDecks":[deck_id],"curDeck":deck_id,"newSpread":0,"curModel":model_id}), json.dumps({str(model_id):model}), json.dumps(decks), json.dumps({"1":{"id":1,"name":"Default","mod":now,"usn":-1,"maxTaken":60,"autoplay":True,"timer":0,"replayq":True,"new":{"bury":True,"delays":[1,10],"initialFactor":2500,"ints":[1,4],"order":1,"perDay":20},"rev":{"bury":True,"ease4":1.3,"ivlFct":1.0,"maxIvl":36500,"perDay":200},"lapse":{"delays":[10],"leechAction":0,"leechFails":8,"minInt":1,"mult":0.0}}}), "{}"))
    media_index = 0
    def highlight_text(sentence, target):
        sentence = str(sentence or "")
        target = str(target or "")
        if not sentence:
            return ""
        if not target:
            return html.escape(sentence)
        position = sentence.casefold().find(target.casefold())
        if position < 0:
            return html.escape(sentence)
        end = position + len(target)
        return html.escape(sentence[:position]) + '<span class="flashcard-focus-highlight">' + html.escape(sentence[position:end]) + '</span>' + html.escape(sentence[end:])
    for index, card in enumerate(cards):
        focus = str(card.get("focus") or "").strip()
        meaning = str(card.get("meaning") or "").strip()
        if not focus or not meaning:
            continue
        audio_path = pathlib.Path(card["audioPath"])
        audio_name = "audio_%04d.wav" % (index + 1)
        media_map[str(media_index)] = audio_name
        media_index += 1
        audio_entries.append((audio_name, audio_path))
        audio_field = "[sound:%s]" % audio_name
        front_html = highlight_text(focus, card.get("markedEn") or card.get("highlightEn") or focus)
        back_html = highlight_text(meaning, card.get("markedPt") or card.get("highlightPt") or meaning)
        values = [
            front_html,
            back_html,
            str(card.get("type") or "expression").replace("_", " ").upper(),
            str(card.get("highlightEn") or focus),
            str(card.get("highlightPt") or meaning),
            str(card.get("explanation") or ""),
            str(card.get("exampleEn") or ""),
            str(card.get("examplePt") or ""),
            str(card.get("speaker") or ""),
            audio_field
        ]
        joined = "\x1f".join(values)
        note_id = stamp * 100000 + index + 1
        card_id = note_id + 50000000
        checksum = int(hashlib.sha1(focus.encode("utf-8")).hexdigest()[:8], 16)
        card_tags = "nova_generator " + str(card.get("sourceType") or "manual")
        db.execute("INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)", (note_id, uuid.uuid4().hex, model_id, now, -1, card_tags, joined, focus, checksum, 0, ""))
        db.execute("INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (card_id, note_id, deck_id, 0, now, -1, 0, 0, index + 1, 0, 2500, 0, 0, 0, 0, 0, 0, ""))
    db.commit()
    db.close()
    check_db = sqlite3.connect("file:" + str(db_path) + "?mode=ro", uri=True)
    integrity = check_db.execute("PRAGMA integrity_check").fetchone()[0]
    required_tables = {row[0] for row in check_db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    check_db.close()
    if integrity != "ok" or not {"col", "notes", "cards", "revlog", "graves"}.issubset(required_tables):
        raise SystemExit("O banco interno do pacote Anki não passou na validação de integridade.")
    media_path = work / "media"
    media_path.write_text(json.dumps(media_map, ensure_ascii=False), encoding="utf-8")
    apkg = work / "nova-generator.apkg"
    with zipfile.ZipFile(apkg, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(db_path, "collection.anki2")
        archive.write(media_path, "media")
        for name, path in audio_entries:
            archive.write(path, name)
    package_data = json.loads(json.dumps(data))
    for card in package_data.get("cards", []):
        audio_path = card.get("audioPath")
        if audio_path:
            card["audioFile"] = pathlib.Path(audio_path).name
            card["audioPath"] = "audio/" + pathlib.Path(audio_path).name
    package_json = work / "materiais.json"
    package_json.write_text(json.dumps(package_data, ensure_ascii=False, indent=2), encoding="utf-8")
    hub_final = work / "hub_final.json"
    hub_payload = {
        "schema": "ihub-english-hub-final/1.0",
        "projectId": package_data.get("projectId"),
        "assetId": package_data.get("assetId"),
        "assetName": package_data.get("assetName"),
        "youtubeVideoId": package_data.get("sourceVideoId"),
        "cards": [card for card in package_data.get("cards", []) if card.get("status") == "approved"],
        "audio": [{"cardId": card.get("id"), "file": card.get("audioFile")} for card in package_data.get("cards", []) if card.get("status") == "approved" and card.get("audioFile")]
    }
    hub_final.write_text(json.dumps(hub_payload, ensure_ascii=False, indent=2), encoding="utf-8")
    concat_file = work / "audio-reel-concat.txt"
    concat_lines = []
    for _, audio_path in audio_entries:
        safe_path = str(audio_path.resolve()).replace("\\", "/").replace("'", "'\\''")
        concat_lines.append("file '" + safe_path + "'")
    concat_file.write_text("\n".join(concat_lines) + "\n", encoding="utf-8")
    reel = work / "anki_audio_reel.mp4"
    reel_command = [
        str(ffmpeg), "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file),
        "-f", "lavfi", "-i", "color=c=0x101014:s=1280x720:r=30", "-shortest",
        "-map", "1:v:0", "-map", "0:a:0",
        "-vf", "drawtext=text='NOVA GENERATOR | ANKI AUDIO REEL':fontcolor=white:fontsize=42:x=(w-text_w)/2:y=(h-text_h)/2",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", str(reel)
    ]
    reel_result = subprocess.run(reel_command, capture_output=True, text=True)
    if reel_result.returncode != 0 or not reel.is_file() or reel.stat().st_size == 0:
        detail = (reel_result.stderr or reel_result.stdout)[-1800:]
        raise SystemExit("Não foi possível gerar anki_audio_reel.mp4 com o FFmpeg compartilhado: " + detail)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(apkg, "anki/anki.apkg")
        archive.write(package_json, "materiais.json")
        archive.write(package_json, "cards/cards.json")
        archive.write(hub_final, "hub_final.json")
        archive.write(reel, "anki_audio_reel.mp4")
        manifest_lines = []
        package_files = [
            ("anki/anki.apkg", apkg), ("materiais.json", package_json),
            ("cards/cards.json", package_json), ("hub_final.json", hub_final),
            ("anki_audio_reel.mp4", reel)
        ]
        for archive_name, file_path in package_files:
            digest = hashlib.sha256(file_path.read_bytes()).hexdigest()
            manifest_lines.append(digest + "  " + archive_name)
        for name, audio_path in audio_entries:
            archive_name = "audio/" + name
            archive.write(audio_path, archive_name)
            manifest_lines.append(hashlib.sha256(audio_path.read_bytes()).hexdigest() + "  " + archive_name)
        archive.writestr("manifest.sha256", "\n".join(manifest_lines) + "\n")
    with zipfile.ZipFile(output, "r") as archive:
        bad_entry = archive.testzip()
        if bad_entry:
            raise SystemExit("O pacote ZIP contém um arquivo inválido: " + bad_entry)
        required = {"anki/anki.apkg", "materiais.json", "cards/cards.json", "hub_final.json", "anki_audio_reel.mp4", "manifest.sha256"}
        missing = required.difference(archive.namelist())
        if missing:
            raise SystemExit("O pacote final está incompleto: " + ", ".join(sorted(missing)))
print(str(output))
"#;

#[tauri::command]
pub async fn export_project_materials_package(
    app: AppHandle, project_id: String, asset_id: String, output_path: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let stored = load_project_materials(app.clone(), project_id.clone(), asset_id.clone())?
            .ok_or("Salve os Materiais antes de exportar o pacote.")?;
        let path = PathBuf::from(&output_path);
        if path.extension().and_then(|value| value.to_str()).map(|value| value.to_ascii_lowercase()) != Some("zip".into()) {
            return Err("O pacote final precisa usar a extensão .zip.".into());
        }
        let cards = stored.get("cards").and_then(Value::as_array).ok_or("O documento de Materiais não contém cards Anki.")?;
        if !cards.iter().any(|card| card.get("status").and_then(Value::as_str) == Some("approved")) {
            return Err("Aprove ao menos um card Anki antes de exportar.".into());
        }
        let (python, _, _) = crate::shared_runtime::qwen3_tts_paths(&app)?;
        let ffmpeg = crate::media::shared_ffmpeg_path(&app)?;
        let parent = path.parent().ok_or("Caminho de exportação inválido.")?;
        fs::create_dir_all(parent).map_err(|e| format!("Não foi possível preparar o destino do pacote: {e}"))?;
        let input_path = parent.join(format!(".nova-materials-{}-input.json", uuid::Uuid::new_v4()));
        fs::write(&input_path, serde_json::to_vec_pretty(&stored).map_err(|e| e.to_string())?)
            .map_err(|e| format!("Não foi possível preparar os dados do pacote: {e}"))?;
        let result = crate::process::hidden_command(&python)
            .arg("-c").arg(APKG_EXPORT_SCRIPT).arg(&input_path).arg(&path).arg(&ffmpeg)
            .output().map_err(|e| format!("Não foi possível iniciar o exportador Anki: {e}"));
        let _ = fs::remove_file(&input_path);
        let output = result?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let detail = if !stderr.trim().is_empty() { stderr.trim() } else { stdout.trim() };
            return Err(format!("Falha ao montar o pacote Anki: {detail}"));
        }
        if !path.is_file() || fs::metadata(&path).map(|meta| meta.len() == 0).unwrap_or(true) {
            return Err("O exportador terminou sem criar um pacote válido.".into());
        }
        Ok(path.to_string_lossy().into_owned())
    }).await.map_err(|e| format!("A exportação foi interrompida: {e}"))?
}
