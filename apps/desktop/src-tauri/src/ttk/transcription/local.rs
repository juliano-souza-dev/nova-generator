use serde::Deserialize;
use std::path::Path;
use super::{duration_ms, ffmpeg, ffprobe, TranscriptCue, TranscriptResult};

fn run_python(args: &[&str]) -> Result<std::process::Output, String> {
    let first_error = match crate::process::hidden_command("python").args(args).output() {
        Ok(output) if output.status.success() => return Ok(output),
        Ok(output) => format!("python: {}", String::from_utf8_lossy(&output.stderr).chars().take(500).collect::<String>()),
        Err(error) => format!("python: {error}"),
    };
    let mut py_args = vec!["-3"];
    py_args.extend_from_slice(args);
    match crate::process::hidden_command("py").args(py_args).output() {
        Ok(output) if output.status.success() => Ok(output),
        Ok(output) => Err(format!("{first_error}; py -3: {}", String::from_utf8_lossy(&output.stderr).chars().take(700).collect::<String>())),
        Err(error) => Err(format!("{first_error}; py -3: {error}")),
    }
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
    let output = run_python(&["-c", SCRIPT, model, audio_arg.as_str(), lang])
        .map_err(|error| format!("Falha no Faster-Whisper local. Instale Python 3.10+ e o suporte local: {error}"))?;
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
    match run_python(&["-c","import faster_whisper; print('ready')"]) {
        Ok(output) => Ok(String::from_utf8_lossy(&output.stdout).contains("ready")),
        Err(_) => Ok(false),
    }
}
pub fn install_local_asr() -> Result<String, String> {
    run_python(&["-m","pip","install","faster-whisper>=1.1,<2","av>=11,<19"])
        .map_err(|error| format!("Instalação do Faster-Whisper falhou: {error}"))?;
    Ok("Faster-Whisper instalado. O modelo será baixado automaticamente na primeira transcrição local.".into())
}
