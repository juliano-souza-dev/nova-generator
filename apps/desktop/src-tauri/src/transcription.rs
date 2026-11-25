use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct TranscriptWord { pub text:String, pub start_ms:u64, pub end_ms:u64 }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct TranscriptCue { pub id:String, pub text:String, pub start_ms:u64, pub end_ms:u64, pub words:Vec<TranscriptWord> }
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct TranscriptResult { pub engine:String, pub model:String, pub language:Option<String>, pub duration_ms:u64, pub cues:Vec<TranscriptCue> }
#[derive(Clone, Serialize)]
#[serde(rename_all="camelCase")]
struct Progress { project_id:String, stage:String, percent:f32, completed_chunks:usize, total_chunks:usize, message:String }

fn emit(app:&AppHandle, project_id:&str, stage:&str, percent:f32, done:usize, total:usize, message:&str) {
 let _=app.emit("transcription-progress",Progress{project_id:project_id.into(),stage:stage.into(),percent:percent.clamp(0.0,100.0),completed_chunks:done,total_chunks:total,message:message.into()});
}
fn ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
    crate::media_tools::ensure_media_tools(app).map(|tools| tools.ffmpeg)
}
fn ffprobe(app: &AppHandle) -> Result<PathBuf, String> {
    crate::media_tools::ensure_media_tools(app).map(|tools| tools.ffprobe)
}
fn duration(probe:&Path,input:&Path)->Result<u64,String>{
 let out=crate::process::hidden_command(probe).args(["-v","error","-show_entries","format=duration","-of","default=noprint_wrappers=1:nokey=1"]).arg(input).output().map_err(|e|format!("Falha ao consultar duração: {e}"))?;
 if !out.status.success(){return Err(String::from_utf8_lossy(&out.stderr).into_owned())}
 let secs=String::from_utf8_lossy(&out.stdout).trim().parse::<f64>().map_err(|_|"Não foi possível identificar a duração do áudio.")?;
 Ok((secs.max(0.0)*1000.0).round() as u64)
}
fn safe_source(app:&AppHandle,project_id:&str,asset_id:&str)->Result<PathBuf,String>{
 let root=crate::media::project_media_root(app,project_id)?;
 let assets=crate::media::list_project_media(app.clone(),project_id.to_string())?;
 let asset=assets.iter().find(|a|a.id==asset_id).ok_or("Mídia não encontrada neste projeto.")?;
 if asset.kind!="video"&&asset.kind!="audio"{return Err("Selecione um vídeo ou arquivo de áudio para transcrever.".into())}
 let rel=Path::new(&asset.relative_path);
 if rel.is_absolute()||rel.components().any(|c|matches!(c,std::path::Component::ParentDir)){return Err("Caminho da mídia inválido.".into())}
 let canonical_root=root.canonicalize().map_err(|e|e.to_string())?;
 let path=root.join(rel).canonicalize().map_err(|e|format!("Arquivo de mídia não encontrado: {e}"))?;
 if !path.starts_with(&canonical_root)||!path.is_file(){return Err("O arquivo não pertence a este projeto.".into())}
 Ok(path)
}
fn extract_audio(ffmpeg:&Path,source:&Path,dest:&Path)->Result<(),String>{
 let out=crate::process::hidden_command(ffmpeg).args(["-y","-hide_banner","-loglevel","error","-i"]).arg(source).args(["-vn","-ac","1","-ar","16000","-c:a","flac"]).arg(dest).output().map_err(|e|format!("Não foi possível iniciar FFmpeg: {e}"))?;
 if !out.status.success(){return Err(format!("Falha ao preparar o áudio: {}",String::from_utf8_lossy(&out.stderr).chars().take(500).collect::<String>()))} Ok(())
}
fn run_python(python:&Path,args:&[&str])->Result<std::process::Output,String>{
 let mut command=crate::process::hidden_command(python);
 crate::shared_runtime_manager::manager::configure_huggingface_command(&mut command).map_err(|e|e.to_string())?;
 let output=command.args(args).output().map_err(|e|format!("Não foi possível iniciar o ambiente isolado do Faster-Whisper: {e}"))?;
 if !output.status.success(){return Err(format!("Faster-Whisper encerrou com código {:?}: {}",output.status.code(),String::from_utf8_lossy(&output.stderr).chars().take(1200).collect::<String>()))}
 Ok(output)
}
fn local(audio:&Path,model:&str,language:Option<&str>)->Result<TranscriptResult,String>{
 const SCRIPT:&str=r#"import contextlib,json,sys
from faster_whisper import WhisperModel
def clean(s): return ''.join('\ufffd' if 0xD800<=ord(c)<=0xDFFF else c for c in s)
name,path,lang=sys.argv[1],sys.argv[2],sys.argv[3]
out=[]
with contextlib.redirect_stdout(sys.stderr):
 m=WhisperModel(name,device='auto',compute_type='auto')
 segs,info=m.transcribe(path,language=(lang or None),word_timestamps=True,vad_filter=True)
 for s in segs:
  words=[{'text':clean(w.word),'startMs':round(w.start*1000),'endMs':round(w.end*1000)} for w in (s.words or [])]
  out.append({'id':'','text':clean(s.text.strip()),'startMs':round(s.start*1000),'endMs':round(s.end*1000),'words':words})
sys.stdout.buffer.write(b'NOVA_ASR_JSON\n'+json.dumps({'language':clean(info.language or ''),'cues':out},ensure_ascii=True,separators=(',',':')).encode('ascii'))
"#;
 crate::shared_runtime_manager::dependency_queue::begin_operation();
 let python=crate::shared_runtime_manager::dependency_manager::ensure_faster_whisper_runtime().map_err(|e|format!("Não foi possível preparar automaticamente o mecanismo de transcrição local: {e:#}"))?;
 let p=audio.to_string_lossy().into_owned();let output=run_python(&python,&["-c",SCRIPT,model,&p,language.unwrap_or("")])?;
 let marker=b"NOVA_ASR_JSON\n";let at=output.stdout.windows(marker.len()).rposition(|w|w==marker).ok_or("O mecanismo local não retornou o resultado esperado.")?;
 #[derive(Deserialize)]#[serde(rename_all="camelCase")]struct Data{language:Option<String>,cues:Vec<TranscriptCue>}
 let mut data:Data=serde_json::from_slice(&output.stdout[at+marker.len()..]).map_err(|e|format!("O mecanismo local retornou dados inválidos: {e}"))?;
 for c in &mut data.cues{c.id=uuid::Uuid::new_v4().to_string()}
 Ok(TranscriptResult{engine:"faster-whisper".into(),model:model.into(),language:data.language,duration_ms:0,cues:data.cues})
}
#[tauri::command]
pub fn nova_check_local_asr()->Result<bool,String>{Ok(crate::shared_runtime_manager::dependency_manager::check_faster_whisper_runtime())}
#[tauri::command]
pub async fn nova_install_local_asr()->Result<String,String>{tauri::async_runtime::spawn_blocking(||crate::shared_runtime_manager::dependency_manager::ensure_faster_whisper_runtime().map(|_|"Faster-Whisper preparado. O modelo será baixado automaticamente na primeira transcrição de cada modelo.".to_string()).map_err(|e|format!("{e:#}"))).await.map_err(|e|e.to_string())?}
#[tauri::command]
pub async fn nova_transcribe_media(app:AppHandle,project_id:String,asset_id:String,mode:String,language:Option<String>,local_model:Option<String>)->Result<TranscriptResult,String>{
 if mode != "local" { return Err("A transcrição está disponível somente no modo local.".into()); }
 let model=local_model.unwrap_or_else(||"small".into());if !["tiny","base","small","medium","large-v3"].contains(&model.as_str()){return Err("Modelo local inválido.".into())}
 let app2=app.clone();
 tauri::async_runtime::spawn_blocking(move||{
  let source=safe_source(&app2,&project_id,&asset_id)?;let ff=ffmpeg(&app2)?;let probe=ffprobe(&app2)?;
  let temp=std::env::temp_dir().join(format!("nova-asr-{}",uuid::Uuid::new_v4()));std::fs::create_dir_all(&temp).map_err(|e|e.to_string())?;
  let result=(||{let audio=temp.join("source.flac");emit(&app2,&project_id,"preparing",0.0,0,0,"Extraindo áudio sem modificar o vídeo original");extract_audio(&ff,&source,&audio)?;let dur=duration(&probe,&audio)?;
   let mut result=local(&audio,&model,language.as_deref())?;
   result.duration_ms=dur;emit(&app2,&project_id,"completed",100.0,1,1,"Transcrição concluída");Ok(result)
  })();let _=std::fs::remove_dir_all(temp);result
 }).await.map_err(|e|format!("A transcrição foi interrompida: {e}"))?
}


/// Transcribes a user-selected voice-reference file without importing it into a project
/// using the locally installed Faster-Whisper engine.
#[tauri::command]
pub async fn nova_transcribe_voice_reference(
    app: AppHandle,
    audio_base64: String,
    filename: String,
) -> Result<String, String> {
    if audio_base64.len() > 140 * 1024 * 1024 {
        return Err("O áudio excede o limite de 100 MB.".into());
    }
    let extension = Path::new(&filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !["mp3", "wav", "m4a", "flac", "ogg", "aac", "wma"].contains(&extension.as_str()) {
        return Err("Formato de áudio não suportado para transcrição.".into());
    }

    let app_handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(audio_base64)
            .map_err(|_| "Não foi possível decodificar o áudio selecionado.".to_string())?;
        if bytes.is_empty() || bytes.len() > 100 * 1024 * 1024 {
            return Err("O áudio está vazio ou excede o limite de 100 MB.".into());
        }

        let temp = std::env::temp_dir().join(format!("nova-voice-reference-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).map_err(|e| format!("Não foi possível preparar a transcrição: {e}"))?;
        let result = (|| {
            let source = temp.join(format!("reference.{extension}"));
            let normalized = temp.join("reference.flac");
            std::fs::write(&source, bytes).map_err(|e| format!("Não foi possível salvar o áudio temporário: {e}"))?;

            let ff = ffmpeg(&app_handle)?;
            let probe = ffprobe(&app_handle)?;
            extract_audio(&ff, &source, &normalized)?;
            let duration_ms = duration(&probe, &normalized)?;
            if duration_ms == 0 {
                return Err("Não foi possível identificar áudio válido no arquivo.".into());
            }

            let transcript = local(&normalized, "small", None)?;
            let text = transcript.cues.into_iter()
                .map(|cue| cue.text.trim().to_string())
                .filter(|cue| !cue.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            if text.is_empty() {
                return Err("A transcrição não identificou fala no áudio.".into());
            }
            Ok(text)
        })();
        let _ = std::fs::remove_dir_all(&temp);
        result
    })
    .await
    .map_err(|e| format!("A transcrição foi interrompida: {e}"))?
}
