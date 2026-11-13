use reqwest::blocking::{multipart, Client};
use serde::{Deserialize, Serialize};
use std::{path::{Path, PathBuf}, time::Duration};
use tauri::{AppHandle, Emitter};

const MODEL: &str = "whisper-large-v3-turbo";
const CHUNK_MS: u64 = 58_000;
const OVERLAP_MS: u64 = 2_000;

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
fn ffmpeg(app:&AppHandle)->Result<PathBuf,String>{crate::media::shared_ffmpeg(app)}
fn ffprobe(ffmpeg:&Path)->Result<PathBuf,String>{
 let name=if cfg!(windows){"ffprobe.exe"}else{"ffprobe"};
 let p=ffmpeg.parent().map(|v|v.join(name)).ok_or("Diretório do FFmpeg inválido.")?;
 if p.is_file(){Ok(p)}else{Err("ffprobe não foi encontrado junto ao FFmpeg compartilhado. Sincronize os recursos pelo Shared Runtime Manager.".into())}
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
fn chunks(ffmpeg:&Path,audio:&Path,dir:&Path,duration:u64)->Result<Vec<(PathBuf,u64)>,String>{
 let mut out=Vec::new();let mut start=0u64;let mut index=0usize;
 while start<duration {let actual=if index==0{0}else{start.saturating_sub(OVERLAP_MS)};let end=(start+CHUNK_MS).min(duration);let path=dir.join(format!("chunk-{index:05}.flac"));
 let secs=(end-actual) as f64/1000.0;
 let result=crate::process::hidden_command(ffmpeg).args(["-y","-hide_banner","-loglevel","error","-ss"]).arg(format!("{:.3}",actual as f64/1000.0)).arg("-i").arg(audio).arg("-t").arg(format!("{secs:.3}")).args(["-ac","1","-ar","16000","-c:a","flac"]).arg(&path).output().map_err(|e|e.to_string())?;
 if !result.status.success(){return Err(format!("Falha ao dividir o áudio: {}",String::from_utf8_lossy(&result.stderr)))}
 out.push((path,actual));if end==duration{break}start=end;index+=1;
 } Ok(out)
}
#[derive(Deserialize)]
struct GroqResponse{ text:Option<String>, language:Option<String>, segments:Option<Vec<GroqSegment>> }
#[derive(Deserialize)]
struct GroqSegment{start:f64,end:f64,text:String,words:Option<Vec<GroqWord>>}
#[derive(Deserialize)]
struct GroqWord{start:Option<f64>,end:Option<f64>,word:String}
fn cloud(app:&AppHandle,project_id:&str,audio:&Path,dir:&Path,duration:u64,language:Option<&str>)->Result<TranscriptResult,String>{
 let ff=ffmpeg(app)?;let parts=chunks(&ff,audio,dir,duration)?;
 let cfg=crate::shared_runtime::resolve_provider_settings(app,"groq")?;
 let key=crate::shared_runtime::resolve_provider_credential(app,"groq")?;
 let endpoint=format!("{}/audio/transcriptions",cfg.endpoint.trim_end_matches('/'));
 let client=Client::builder().timeout(Duration::from_secs(180)).build().map_err(|e|e.to_string())?;
 let total=parts.len();let mut cues=Vec::new();let mut detected=language.map(str::to_string);
 for (index,(path,offset)) in parts.iter().enumerate(){
  emit(app,project_id,"cloud",index as f32/total.max(1) as f32*100.0,index,total,&format!("Transcrevendo bloco {} de {}",index+1,total));
  let bytes=std::fs::read(path).map_err(|e|e.to_string())?;
  if bytes.len()>25*1024*1024{return Err("Um bloco ultrapassou o limite de 25 MB da Groq.".into())}
  let mut response=None;let mut last=String::new();
  for attempt in 0..4{
   let part=multipart::Part::bytes(bytes.clone()).file_name("audio.flac").mime_str("audio/flac").map_err(|e|e.to_string())?;
   let mut form=multipart::Form::new().text("model",MODEL).text("response_format","verbose_json").text("temperature","0")
    .text("timestamp_granularities[]","word").text("timestamp_granularities[]","segment").part("file",part);
   if let Some(lang)=language{if !lang.trim().is_empty(){form=form.text("language",lang.to_string())}}
   match client.post(&endpoint).bearer_auth(&key).multipart(form).send(){
    Ok(r) if r.status().is_success()=>{response=Some(r.json::<GroqResponse>().map_err(|e|format!("Resposta da Groq inválida: {e}"))?);break}
    Ok(r)=>{let status=r.status();last=format!("Groq HTTP {status}: {}",r.text().unwrap_or_default().chars().take(400).collect::<String>());if status.as_u16()!=429&&!status.is_server_error(){return Err(last)}}
    Err(e)=>last=format!("Falha de conexão com a Groq: {e}")
   }
   if attempt<3{std::thread::sleep(Duration::from_secs(2u64.pow(attempt).min(12)))}
  }
  let data=response.ok_or(last)?;
  if detected.is_none(){detected=data.language.clone()}
  for seg in data.segments.unwrap_or_default(){
   let start=offset.saturating_add((seg.start.max(0.0)*1000.0) as u64);let end=offset.saturating_add((seg.end.max(seg.start)*1000.0) as u64);
   let text=seg.text.trim().to_string();if text.is_empty()||end<=start{continue}
   let words=seg.words.unwrap_or_default().into_iter().filter_map(|w|Some(TranscriptWord{text:w.word,start_ms:offset.saturating_add((w.start?.max(0.0)*1000.0) as u64),end_ms:offset.saturating_add((w.end?.max(w.start?)*1000.0) as u64)})).collect();
   if !cues.iter().any(|c:&TranscriptCue|c.text.eq_ignore_ascii_case(&text)&&c.start_ms.abs_diff(start)<1800){cues.push(TranscriptCue{id:uuid::Uuid::new_v4().to_string(),text,start_ms:start,end_ms:end,words})}
  }
  emit(app,project_id,"cloud",(index+1) as f32/total.max(1) as f32*100.0,index+1,total,&format!("Bloco {} de {} concluído",index+1,total));
 }
 cues.sort_by_key(|c|c.start_ms);
 Ok(TranscriptResult{engine:"groq".into(),model:MODEL.into(),language:detected,duration_ms:duration,cues})
}
fn run_python(args:&[&str])->Result<std::process::Output,String>{
 let first=match crate::process::hidden_command("python").args(args).output(){Ok(o) if o.status.success()=>return Ok(o),Ok(o)=>format!("python: {}",String::from_utf8_lossy(&o.stderr).chars().take(400).collect::<String>()),Err(e)=>format!("python: {e}")};
 let mut a=vec!["-3"];a.extend_from_slice(args);
 match crate::process::hidden_command("py").args(a).output(){Ok(o) if o.status.success()=>Ok(o),Ok(o)=>Err(format!("{first}; py -3: {}",String::from_utf8_lossy(&o.stderr).chars().take(600).collect::<String>())),Err(e)=>Err(format!("{first}; py -3: {e}"))}
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
 let p=audio.to_string_lossy().into_owned();let output=run_python(&["-c",SCRIPT,model,&p,language.unwrap_or("")]).map_err(|e|format!("Faster-Whisper local indisponível. Instale Python 3.10+ e o mecanismo local: {e}"))?;
 let marker=b"NOVA_ASR_JSON\n";let at=output.stdout.windows(marker.len()).rposition(|w|w==marker).ok_or("O mecanismo local não retornou o resultado esperado.")?;
 #[derive(Deserialize)]#[serde(rename_all="camelCase")]struct Data{language:Option<String>,cues:Vec<TranscriptCue>}
 let mut data:Data=serde_json::from_slice(&output.stdout[at+marker.len()..]).map_err(|e|format!("O mecanismo local retornou dados inválidos: {e}"))?;
 for c in &mut data.cues{c.id=uuid::Uuid::new_v4().to_string()}
 Ok(TranscriptResult{engine:"faster-whisper".into(),model:model.into(),language:data.language,duration_ms:0,cues:data.cues})
}
#[tauri::command]
pub fn check_local_asr()->Result<bool,String>{Ok(run_python(&["-c","import faster_whisper; print('ready')"]).map(|o|String::from_utf8_lossy(&o.stdout).contains("ready")).unwrap_or(false))}
#[tauri::command]
pub async fn install_local_asr()->Result<String,String>{tauri::async_runtime::spawn_blocking(||run_python(&["-m","pip","install","faster-whisper>=1.1,<2","av>=11,<19"]).map(|_|"Faster-Whisper instalado. O modelo será baixado na primeira transcrição local.".to_string())).await.map_err(|e|e.to_string())?}
#[tauri::command]
pub async fn transcribe_media(app:AppHandle,project_id:String,asset_id:String,mode:String,language:Option<String>,local_model:Option<String>)->Result<TranscriptResult,String>{
 if !["auto","cloud","local"].contains(&mode.as_str()){return Err("Modo de transcrição inválido.".into())}
 let model=local_model.unwrap_or_else(||"small".into());if !["tiny","base","small","medium","large-v3"].contains(&model.as_str()){return Err("Modelo local inválido.".into())}
 let app2=app.clone();
 tauri::async_runtime::spawn_blocking(move||{
  let source=safe_source(&app2,&project_id,&asset_id)?;let ff=ffmpeg(&app2)?;let probe=ffprobe(&ff)?;
  let temp=std::env::temp_dir().join(format!("nova-asr-{}",uuid::Uuid::new_v4()));std::fs::create_dir_all(&temp).map_err(|e|e.to_string())?;
  let result=(||{let audio=temp.join("source.flac");emit(&app2,&project_id,"preparing",0.0,0,0,"Extraindo áudio sem modificar o vídeo original");extract_audio(&ff,&source,&audio)?;let dur=duration(&probe,&audio)?;
   let mut result=if mode=="local"{local(&audio,&model,language.as_deref())?}else if mode=="cloud"{cloud(&app2,&project_id,&audio,&temp,dur,language.as_deref())?}else{match cloud(&app2,&project_id,&audio,&temp,dur,language.as_deref()){Ok(r)=>r,Err(cloud_error)=>{emit(&app2,&project_id,"fallback",0.0,0,0,&format!("Groq indisponível. Tentando processamento local. {cloud_error}"));local(&audio,&model,language.as_deref()).map_err(|e|format!("Transcrição na nuvem falhou: {cloud_error}. Processamento local também falhou: {e}"))?}}};
   result.duration_ms=dur;emit(&app2,&project_id,"completed",100.0,1,1,"Transcrição concluída");Ok(result)
  })();let _=std::fs::remove_dir_all(temp);result
 }).await.map_err(|e|format!("A transcrição foi interrompida: {e}"))?
}
