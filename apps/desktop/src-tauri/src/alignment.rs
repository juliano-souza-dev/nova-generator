use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};
use tauri::{AppHandle, Emitter};

const PADDING_MS: u64 = 350;
const ALIGNMENT_MODEL_KEY: &str = "whisperx-default-aligner-v1";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlignmentProgress {
    project_id: String,
    asset_id: String,
    completed: usize,
    total: usize,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentResult {
    pub aligned: usize,
    pub skipped: usize,
    pub total: usize,
    pub language: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerResponse {
    request_id: Option<String>,
    status: String,
    error: Option<String>,
    #[serde(default)]
    words: Vec<AlignedWord>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlignedWord {
    text: String,
    start_ms: u64,
    end_ms: u64,
}

struct AlignmentWorker {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl AlignmentWorker {
    fn start(python: &Path, runner: &Path) -> Result<Self, String> {
        let mut child = Command::new(python)
            .arg("-u")
            .arg(runner)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Não foi possível iniciar o WhisperX pelo Shared Runtime: {e}"))?;
        let input = child.stdin.take().ok_or("Não foi possível abrir a entrada do WhisperX.")?;
        let output = child.stdout.take().ok_or("Não foi possível abrir a saída do WhisperX.")?;
        Ok(Self { child, input, output: BufReader::new(output) })
    }

    fn align(&mut self, audio: &Path, text: &str, language: &str) -> Result<Vec<AlignedWord>, String> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let request = json!({
            "requestId": request_id,
            "audioPath": audio.to_string_lossy(),
            "text": text,
            "language": language
        });
        serde_json::to_writer(&mut self.input, &request).map_err(|e| e.to_string())?;
        self.input.write_all(b"\n").map_err(|e| format!("Falha ao enviar bloco ao WhisperX: {e}"))?;
        self.input.flush().map_err(|e| format!("Falha ao enviar bloco ao WhisperX: {e}"))?;

        let mut line = String::new();
        let read = self.output.read_line(&mut line)
            .map_err(|e| format!("Falha ao receber alinhamento do WhisperX: {e}"))?;
        if read == 0 {
            let status = self.child.try_wait().ok().flatten()
                .map(|s| s.to_string()).unwrap_or_else(|| "processo encerrou sem resposta".into());
            return Err(format!("O worker do WhisperX encerrou inesperadamente ({status})."));
        }
        let response: WorkerResponse = serde_json::from_str(line.trim())
            .map_err(|e| format!("Resposta inválida do WhisperX: {e}. Retorno: {}", line.chars().take(300).collect::<String>()))?;
        if response.request_id.as_deref() != Some(request_id.as_str()) {
            return Err("O WhisperX retornou uma resposta associada a outro bloco.".into());
        }
        if response.status != "completed" {
            return Err(response.error.unwrap_or_else(|| "O WhisperX não conseguiu alinhar este bloco.".into()));
        }
        Ok(response.words)
    }
}

impl Drop for AlignmentWorker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn language_code(raw: &str) -> Result<String, String> {
    let value = raw.trim().to_ascii_lowercase().replace('_', "-");
    let code = match value.as_str() {
        "portuguese" | "português" | "pt-br" | "pt-pt" => "pt",
        "english" | "inglês" | "en-us" | "en-gb" => "en",
        "spanish" | "español" | "espanhol" => "es",
        "french" | "français" | "francês" => "fr",
        "german" | "deutsch" | "alemão" => "de",
        "italian" | "italiano" => "it",
        "dutch" | "nederlands" => "nl",
        "japanese" | "日本語" => "ja",
        "chinese" | "中文" => "zh",
        "korean" | "한국어" => "ko",
        _ if value.len() == 2 && value.bytes().all(|b| b.is_ascii_lowercase()) => value.as_str(),
        _ => return Err(format!("Idioma '{raw}' não reconhecido para alinhamento. Informe um código de idioma compatível, como pt ou en.")),
    };
    Ok(code.to_string())
}

fn project_source(app: &AppHandle, project_id: &str, asset_id: &str) -> Result<PathBuf, String> {
    let root = crate::media::project_media_root(app, project_id)?;
    let assets = crate::media::list_project_media(app.clone(), project_id.to_string())?;
    let asset = assets.iter().find(|item| item.id == asset_id)
        .ok_or("Mídia não encontrada neste projeto.")?;
    if asset.kind != "video" && asset.kind != "audio" {
        return Err("O alinhamento exige um arquivo de vídeo ou áudio.".into());
    }
    let relative = Path::new(&asset.relative_path);
    if relative.is_absolute() || relative.components().any(|part| matches!(part, std::path::Component::ParentDir)) {
        return Err("Caminho da mídia inválido.".into());
    }
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let source = root.join(relative).canonicalize()
        .map_err(|e| format!("Arquivo de mídia não encontrado: {e}"))?;
    if !source.starts_with(&canonical_root) || !source.is_file() {
        return Err("O arquivo de mídia não pertence a este projeto.".into());
    }
    Ok(source)
}

fn extract_block(
    ffmpeg: &Path,
    source: &Path,
    output: &Path,
    start_ms: u64,
    end_ms: u64,
) -> Result<(), String> {
    if end_ms <= start_ms {
        return Err("O bloco possui duração inválida.".into());
    }
    let duration = (end_ms - start_ms) as f64 / 1000.0;
    let start = start_ms as f64 / 1000.0;
    let result = Command::new(ffmpeg)
        .args(["-y", "-hide_banner", "-loglevel", "error", "-ss"])
        .arg(format!("{start:.3}"))
        .arg("-i")
        .arg(source)
        .arg("-t")
        .arg(format!("{duration:.3}"))
        .args(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac"])
        .arg(output)
        .output()
        .map_err(|e| format!("Não foi possível iniciar o FFmpeg para preparar o bloco: {e}"))?;
    if !result.status.success() {
        return Err(format!(
            "Falha ao extrair o áudio do bloco: {}",
            String::from_utf8_lossy(&result.stderr).chars().take(500).collect::<String>()
        ));
    }
    Ok(())
}

fn block_fingerprint(audio: &Path, text: &str, language: &str, runner_bytes: &[u8]) -> Result<String, String> {
    let audio_bytes = fs::read(audio).map_err(|e| format!("Não foi possível calcular a impressão digital do áudio: {e}"))?;
    let mut digest = Sha256::new();
    digest.update(ALIGNMENT_MODEL_KEY.as_bytes());
    digest.update([0]);
    digest.update(language.as_bytes());
    digest.update([0]);
    digest.update(text.as_bytes());
    digest.update([0]);
    digest.update(&audio_bytes);
    digest.update([0]);
    digest.update(runner_bytes);
    Ok(format!("{:x}", digest.finalize()))
}

struct PendingBlock {
    index: usize,
    clip: PathBuf,
    language: String,
    fingerprint: String,
}

fn emit_progress(app: &AppHandle, project_id: &str, asset_id: &str, completed: usize, total: usize, message: &str) {
    let _ = app.emit("alignment-progress", AlignmentProgress {
        project_id: project_id.into(),
        asset_id: asset_id.into(),
        completed,
        total,
        message: message.into(),
    });
}

#[tauri::command]
pub async fn align_project_subtitles(
    app: AppHandle,
    project_id: String,
    asset_id: String,
    language: Option<String>,
) -> Result<AlignmentResult, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut cues = crate::media::load_project_subtitles(app.clone(), project_id.clone(), asset_id.clone())?;
        if cues.is_empty() {
            return Err("Este projeto ainda não possui blocos de transcrição para alinhar.".into());
        }
        let total = cues.iter().filter(|cue| !cue.text.trim().is_empty()).count();
        if total == 0 {
            return Err("Não há blocos com texto para alinhar.".into());
        }

        let (python, runner) = crate::shared_runtime::forced_alignment_paths(&app)?;
        let runner_bytes = fs::read(&runner).map_err(|e| format!("Não foi possível verificar a versão do alinhador: {e}"))?;
        let ffmpeg = crate::media::shared_ffmpeg(&app)?;
        let source = project_source(&app, &project_id, &asset_id)?;
        let temp = std::env::temp_dir().join(format!("nova-alignment-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp).map_err(|e| e.to_string())?;

        let result = (|| {
            let mut pending = Vec::<PendingBlock>::new();
            let mut skipped = 0usize;
            let mut scanned = 0usize;

            emit_progress(&app, &project_id, &asset_id, 0, total, "Verificando quais blocos já possuem alinhamento válido");
            for index in 0..cues.len() {
                if cues[index].text.trim().is_empty() {
                    continue;
                }
                scanned += 1;
                let raw_language = language.as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .or(cues[index].language.as_deref())
                    .ok_or_else(|| format!("O bloco {} não possui idioma registrado. Selecione o idioma da fala e tente novamente.", index + 1))?;
                let lang = language_code(raw_language)?;
                let clip_start = cues[index].start_ms.saturating_sub(PADDING_MS);
                let clip_end = cues[index].end_ms.saturating_add(PADDING_MS);
                let clip = temp.join(format!("block-{index:05}.flac"));
                extract_block(&ffmpeg, &source, &clip, clip_start, clip_end)?;
                let fingerprint = block_fingerprint(&clip, &cues[index].text, &lang, &runner_bytes)?;

                if cues[index].word_alignment.as_deref() == Some("whisperx")
                    && cues[index].word_alignment_hash.as_deref() == Some(fingerprint.as_str()) {
                    skipped += 1;
                } else {
                    if cues[index].word_alignment.as_deref() == Some("whisperx") {
                        cues[index].words = None;
                        cues[index].word_alignment = None;
                        cues[index].word_alignment_hash = None;
                        crate::media::save_project_subtitles(app.clone(), project_id.clone(), asset_id.clone(), cues.clone())?;
                    }
                    pending.push(PendingBlock { index, clip, language: lang, fingerprint });
                }
                emit_progress(
                    &app,
                    &project_id,
                    &asset_id,
                    skipped,
                    total,
                    &format!("Verificado bloco {} de {}", scanned, total),
                );
            }

            if pending.is_empty() {
                return Ok(AlignmentResult {
                    aligned: 0,
                    skipped,
                    total,
                    language,
                });
            }

            let mut worker = AlignmentWorker::start(&python, &runner)?;
            let mut aligned = 0usize;
            let mut resolved_language = None::<String>;

            for block in pending {
                let index = block.index;
                emit_progress(
                    &app,
                    &project_id,
                    &asset_id,
                    skipped + aligned,
                    total,
                    &format!("Alinhando bloco {} de {}", skipped + aligned + 1, total),
                );
                let words = worker.align(&block.clip, &cues[index].text, &block.language)?;
                if words.is_empty() {
                    return Err(format!("O WhisperX não encontrou palavras alinháveis no bloco {}. Os blocos concluídos anteriormente permanecem salvos.", index + 1));
                }

                let clip_start = cues[index].start_ms.saturating_sub(PADDING_MS);
                let cue_start = cues[index].start_ms;
                let cue_end = cues[index].end_ms;
                let mut mapped = Vec::with_capacity(words.len());
                for word in words {
                    let start = clip_start.saturating_add(word.start_ms).max(cue_start).min(cue_end.saturating_sub(1));
                    let end = clip_start.saturating_add(word.end_ms).min(cue_end).max(start.saturating_add(1));
                    if end <= start || word.text.trim().is_empty() { continue; }
                    mapped.push(crate::transcription::TranscriptWord {
                        text: word.text,
                        start_ms: start,
                        end_ms: end,
                    });
                }
                if mapped.is_empty() {
                    return Err(format!("O alinhamento do bloco {} não produziu tempos válidos dentro do trecho.", index + 1));
                }

                cues[index].words = Some(mapped);
                cues[index].language = Some(block.language.clone());
                cues[index].word_alignment = Some("whisperx".into());
                cues[index].word_alignment_hash = Some(block.fingerprint);
                crate::media::save_project_subtitles(app.clone(), project_id.clone(), asset_id.clone(), cues.clone())?;
                aligned += 1;
                resolved_language = Some(block.language);
                emit_progress(
                    &app,
                    &project_id,
                    &asset_id,
                    skipped + aligned,
                    total,
                    &format!("Bloco {} alinhado e salvo", index + 1),
                );
            }

            Ok(AlignmentResult {
                aligned,
                skipped,
                total,
                language: resolved_language.or(language),
            })
        })();

        let _ = fs::remove_dir_all(temp);
        if let Ok(summary) = &result {
            emit_progress(
                &app,
                &project_id,
                &asset_id,
                summary.total,
                summary.total,
                "Alinhamento concluído. Os blocos processados foram salvos.",
            );
        }
        result
    }).await.map_err(|e| format!("O alinhamento foi interrompido: {e}"))?
}
