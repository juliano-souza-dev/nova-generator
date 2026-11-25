use serde::Deserialize;
use std::path::Path;
use super::{duration_ms, ffmpeg, ffprobe, TranscriptCue, TranscriptResult};

fn run_python(python: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    let mut command = crate::process::hidden_command(python);
    crate::shared_runtime_manager::manager::configure_huggingface_command(&mut command)
        .map_err(|error| error.to_string())?;
    let output = command.args(args).output()
        .map_err(|error| format!("Não foi possível iniciar o ambiente isolado do Faster-Whisper: {}", error))?;
    if !output.status.success() {
        return Err(format!("Faster-Whisper encerrou com código {:?}: {}", output.status.code(),
            String::from_utf8_lossy(&output.stderr).chars().take(1200).collect::<String>()));
    }
    Ok(output)
}
pub(super) fn run_local_python(audio: &Path, model: &str, language: Option<&str>) -> Result<TranscriptResult, String> {
    const SCRIPT: &str = r#"import contextlib,json,sys
from faster_whisper import WhisperModel

def clean_unicode(value):
    return "".join(chr(0xFFFD) if 0xD800 <= ord(ch) <= 0xDFFF else ch for ch in value)

model_name, audio_path, language = sys.argv[1], sys.argv[2], sys.argv[3]
out=[]
with contextlib.redirect_stdout(sys.stderr):
    model = WhisperModel(model_name, device="auto", compute_type="auto")
    segments, info = model.transcribe(audio_path, language=(language or None), word_timestamps=True, vad_filter=True)
    for s in segments:
        words=[{"text":clean_unicode(w.word),"startMs":round(w.start*1000),"endMs":round(w.end*1000)} for w in (s.words or [])]
        out.append({"id":"","text":clean_unicode(s.text.strip()),"startMs":round(s.start*1000),"endMs":round(s.end*1000),"words":words})
payload=json.dumps({"language":clean_unicode(info.language or ""),"cues":out},ensure_ascii=True,separators=(",",":"))
sys.stdout.buffer.write(b"FRAMELAB_ASR_JSON\n"+payload.encode("ascii"))
sys.stdout.buffer.flush()
"#;
    let lang = language.unwrap_or("");
    let audio_arg = audio.to_string_lossy().into_owned();
    crate::shared_runtime_manager::dependency_queue::begin_operation();
    let python = crate::shared_runtime_manager::dependency_manager::ensure_faster_whisper_runtime()
        .map_err(|error| format!("Não foi possível preparar automaticamente o mecanismo de transcrição local: {}", error))?;
    let output = run_python(&python, &["-c", SCRIPT, model, audio_arg.as_str(), lang])?;
    #[derive(Deserialize)] #[serde(rename_all="camelCase")]
    struct LocalOutput { language: Option<String>, cues: Vec<TranscriptCue> }
    const JSON_MARKER: &[u8] = b"FRAMELAB_ASR_JSON\n";
    let marker_at = output.stdout.windows(JSON_MARKER.len()).rposition(|window| window == JSON_MARKER)
        .ok_or("O mecanismo local não retornou o bloco de resultado esperado.")?;
    let json_payload = &output.stdout[marker_at + JSON_MARKER.len()..];
    let mut parsed: LocalOutput = serde_json::from_slice(json_payload)
        .map_err(|e| format!("O mecanismo local retornou dados inválidos após normalizar a saída Unicode: {e}"))?;
    for cue in &mut parsed.cues { cue.id = uuid::Uuid::new_v4().to_string(); }
    Ok(TranscriptResult { engine:"faster-whisper".into(), model:model.into(), language:parsed.language, duration_ms:duration_ms(&ffprobe(&ffmpeg()?)?,audio)?, cues:parsed.cues })
}

pub fn check_local_asr() -> Result<bool, String> {
    Ok(crate::shared_runtime_manager::dependency_manager::check_faster_whisper_runtime())
}
pub fn install_local_asr() -> Result<String, String> {
    crate::shared_runtime_manager::dependency_manager::ensure_faster_whisper_runtime()
        .map(|_| "Faster-Whisper preparado. O modelo será baixado automaticamente na primeira transcrição de cada modelo.".into())
        .map_err(|error| format!("{}", error))
}
