use serde::Deserialize;
use std::{
    io::{BufRead, BufReader, Read},
    path::Path,
    process::Stdio,
    sync::mpsc,
    thread,
    time::Duration,
};
use super::{duration_ms, ffmpeg, ffprobe, TranscriptCue, TranscriptResult};

type ProgressCallback<'a> = dyn FnMut(&str, f32, usize, usize, &str) + 'a;

fn run_python(
    python: &Path,
    args: &[&str],
    on_progress: &mut ProgressCallback<'_>,
) -> Result<std::process::Output, String> {
    let mut command = crate::process::hidden_command(python);
    crate::shared_runtime_manager::manager::configure_huggingface_command(&mut command)
        .map_err(|error| error.to_string())?;
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.args(args).spawn()
        .map_err(|error| format!("Não foi possível iniciar o ambiente isolado do Faster-Whisper: {error}"))?;

    let stdout = child.stdout.take().ok_or("Não foi possível acompanhar a saída do Faster-Whisper.")?;
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut reader = stdout;
        reader.read_to_end(&mut bytes).map(|_| bytes)
    });

    let stderr = child.stderr.take().ok_or("Não foi possível acompanhar os logs do Faster-Whisper.")?;
    let (sender, receiver) = mpsc::channel::<String>();
    let stderr_reader = thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            match line {
                Ok(line) => { if sender.send(line).is_err() { break; } }
                Err(_) => break,
            }
        }
    });

    let mut stderr_lines = Vec::new();
    let mut last_stage = "loading_model".to_string();
    let mut last_percent = 8.0_f32;
    loop {
        match receiver.recv_timeout(Duration::from_secs(5)) {
            Ok(line) => {
                if let Some(progress) = line.strip_prefix("NOVA_PROGRESS|") {
                    let mut parts = progress.splitn(5, '|');
                    let stage = parts.next().unwrap_or("processing");
                    let percent = parts.next().and_then(|value| value.parse::<f32>().ok()).unwrap_or(10.0);
                    let done = parts.next().and_then(|value| value.parse::<usize>().ok()).unwrap_or(0);
                    let total = parts.next().and_then(|value| value.parse::<usize>().ok()).unwrap_or(0);
                    let message = parts.next().unwrap_or("Processando áudio");
                    last_stage = stage.to_string();
                    last_percent = percent;
                    on_progress(stage, percent, done, total, message);
                } else if !line.trim().is_empty() {
                    let visible = line.chars().take(240).collect::<String>();
                    stderr_lines.push(visible.clone());
                    on_progress(&last_stage, last_percent, 0, 0, &visible);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                on_progress(
                    &last_stage,
                    last_percent,
                    0,
                    0,
                    "O processo continua ativo; baixando ou carregando o modelo de reconhecimento.",
                );
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    let status = child.wait().map_err(|error| format!("Falha ao aguardar o Faster-Whisper: {error}"))?;
    let stdout = stdout_reader.join()
        .map_err(|_| "Falha ao ler o resultado do Faster-Whisper.".to_string())?
        .map_err(|error| format!("Falha ao ler o resultado do Faster-Whisper: {error}"))?;
    let _ = stderr_reader.join();

    if !status.success() {
        let details = stderr_lines.join("\n");
        return Err(format!(
            "Faster-Whisper encerrou com código {:?}: {}",
            status.code(),
            details.chars().take(1200).collect::<String>()
        ));
    }
    Ok(std::process::Output { status, stdout, stderr: stderr_lines.join("\n").into_bytes() })
}

pub(super) fn run_local_python(
    audio: &Path,
    model: &str,
    language: Option<&str>,
    on_progress: &mut ProgressCallback<'_>,
) -> Result<TranscriptResult, String> {
    const SCRIPT: &str = r#"import contextlib,json,sys
from faster_whisper import WhisperModel

def clean_unicode(value):
    return "".join(chr(0xFFFD) if 0xD800 <= ord(ch) <= 0xDFFF else ch for ch in value)

def report(stage, percent, done, total, message):
    print("NOVA_PROGRESS|{}|{:.2f}|{}|{}|{}".format(stage, percent, done, total, message), file=sys.stderr, flush=True)

model_name, audio_path, language = sys.argv[1], sys.argv[2], sys.argv[3]
out=[]
report("loading_model", 8, 0, 0, "Baixando ou carregando o modelo " + model_name)
with contextlib.redirect_stdout(sys.stderr):
    model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=4, num_workers=1)
    report("transcribing", 15, 0, 0, "Modelo carregado; iniciando reconhecimento do áudio")
    segments, info = model.transcribe(audio_path, language=(language or None), word_timestamps=True, vad_filter=True, beam_size=1)
    total_duration = max(float(info.duration or 0), 0.001)
    for index, s in enumerate(segments, 1):
        words=[{"text":clean_unicode(w.word),"startMs":round(w.start*1000),"endMs":round(w.end*1000)} for w in (s.words or [])]
        out.append({"id":"","text":clean_unicode(s.text.strip()),"startMs":round(s.start*1000),"endMs":round(s.end*1000),"words":words})
        percent = min(95.0, 15.0 + (float(s.end) / total_duration) * 80.0)
        report("transcribing", percent, index, 0, "Reconhecendo áudio: {:.1f}s de {:.1f}s".format(s.end, total_duration))
payload=json.dumps({"language":clean_unicode(info.language or ""),"cues":out},ensure_ascii=True,separators=(",",":"))
sys.stdout.buffer.write(b"FRAMELAB_ASR_JSON\n"+payload.encode("ascii"))
sys.stdout.buffer.flush()
"#;
    let lang = language.unwrap_or("");
    let audio_arg = audio.to_string_lossy().into_owned();

    crate::shared_runtime_manager::dependency_queue::begin_operation();
    on_progress("preparing_runtime", 6.0, 0, 0, "Verificando o ambiente local do Faster-Whisper");
    let python = crate::shared_runtime_manager::dependency_manager::ensure_faster_whisper_runtime()
        .map_err(|error| format!("Não foi possível preparar automaticamente o mecanismo de transcrição local: {error}"))?;

    let output = run_python(&python, &["-u", "-c", SCRIPT, model, audio_arg.as_str(), lang], on_progress)?;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct LocalOutput { language: Option<String>, cues: Vec<TranscriptCue> }

    const JSON_MARKER: &[u8] = b"FRAMELAB_ASR_JSON\n";
    let marker_at = output.stdout.windows(JSON_MARKER.len()).rposition(|window| window == JSON_MARKER)
        .ok_or("O mecanismo local não retornou o bloco de resultado esperado.")?;
    let json_payload = &output.stdout[marker_at + JSON_MARKER.len()..];
    let mut parsed: LocalOutput = serde_json::from_slice(json_payload)
        .map_err(|error| format!("O mecanismo local retornou dados inválidos após normalizar a saída Unicode: {error}"))?;
    for cue in &mut parsed.cues {
        cue.id = uuid::Uuid::new_v4().to_string();
    }

    let duration = duration_ms(&ffprobe(&ffmpeg()?)?, audio)?;
    Ok(TranscriptResult {
        engine: "faster-whisper".into(),
        model: model.into(),
        language: parsed.language,
        duration_ms: duration,
        cues: parsed.cues,
    })
}

pub fn check_local_asr() -> Result<bool, String> {
    Ok(crate::shared_runtime_manager::dependency_manager::check_faster_whisper_runtime())
}

pub fn install_local_asr() -> Result<String, String> {
    crate::shared_runtime_manager::dependency_manager::ensure_faster_whisper_runtime()
        .map(|_| "Faster-Whisper preparado. O modelo será baixado automaticamente na primeira transcrição de cada modelo.".into())
        .map_err(|error| format!("{error}"))
}
