mod captions;
pub mod ffmpeg;

use captions::{
    ass_caption_script, caption_background_geometry, ffmpeg_escape_expression,
    ffmpeg_escape_filter_path, wrap_text_for_export,
};
use ffmpeg::{ensure_ffmpeg_capabilities, media_has_audio_stream};
pub use ffmpeg::check_ffmpeg;
pub(crate) use ffmpeg::resolve_ffmpeg_executable;

use std::path::PathBuf;
use tauri::{AppHandle, Emitter, State};
use crate::{infrastructure::sound_library::read_sound_manifest, state::AppState};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportClip {
    id: String,
    asset_id: String,
    kind: String,
    source_start_ms: u64,
    source_end_ms: u64,
    timeline_start_ms: u64,
    volume: f64,
    muted: Option<bool>,
    #[serde(default)]
    transition_type: String,
    #[serde(default)]
    transition_ms: u64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportCaptionWord {
    text: String,
    start_ms: u64,
    end_ms: u64,
    #[serde(default)]
    pt: String,
    #[serde(default)]
    pt_group: String,
    #[serde(default)]
    pt_group_role: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportMotion {
    text: String,
    start_ms: u64,
    end_ms: u64,
    color: String,
    font_size: u32,
    x: f64,
    y: f64,
    #[serde(default)]
    font_family: String,
    #[serde(default)]
    font_weight: u32,
    #[serde(default)]
    text_align: String,
    #[serde(default)]
    preset: String,
    #[serde(default = "default_motion_entrance_duration")]
    entrance_duration_ms: u64,
    #[serde(default)]
    typewriter_duration_ms: u64,
    #[serde(default)]
    is_caption: bool,
    #[serde(default)]
    caption_words: Vec<ExportCaptionWord>,
    #[serde(default)]
    caption_accent: String,
    #[serde(default)]
    caption_background_color: String,
    #[serde(default)]
    caption_background_opacity: f64,
    #[serde(default)]
    caption_width: f64,
    #[serde(default)]
    caption_padding_em: f64,
    #[serde(default)]
    lucide_icon_png: Option<String>,
    #[serde(default)]
    lucide_icon_anchor: String,
    #[serde(default)]
    lucide_icon_size: u32,
    #[serde(default)]
    lucide_icon_offset_x: f64,
    #[serde(default)]
    lucide_icon_offset_y: f64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportImageOverlay {
    asset_id:String, start_ms:u64, end_ms:u64, x:f64, y:f64, width:u32, height:u32,
    #[serde(default = "default_overlay_animation")]
    entrance_animation: String,
    #[serde(default = "default_overlay_animation_duration")]
    entrance_duration_ms: u64,
}

fn default_motion_entrance_duration() -> u64 { 700 }

fn write_motion_text_file(value: &str, temp_files: &mut Vec<PathBuf>) -> Result<String, String> {
    let path = std::env::temp_dir()
        .join(format!("framelab-motion-text-{}.txt", uuid::Uuid::new_v4()));
    std::fs::write(&path, value.as_bytes())
        .map_err(|error| format!("Não foi possível preparar o texto para exportação: {error}"))?;
    temp_files.push(path.clone());
    Ok(ffmpeg_escape_filter_path(&path))
}

fn default_overlay_animation() -> String { "none".into() }
fn default_overlay_animation_duration() -> u64 { 600 }

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSoundEffect {
    sound_id: String,
    timeline_start_ms: u64,
    volume: f64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    project_id: String,
    destination: String,
    clips: Vec<ExportClip>,
    motion: Vec<ExportMotion>,
    #[serde(default)]
    image_overlays: Vec<ExportImageOverlay>,
    #[serde(default)]
    sound_effects: Vec<ExportSoundEffect>,
}

#[derive(Clone, serde::Serialize)]
struct ExportProgress {
    percent: f64,
}

#[tauri::command]
pub async fn export_timeline(
    app: AppHandle,
    request: ExportRequest,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let assets = state.media.list(&request.project_id)?;
    let storage = state.media_storage.clone();
    let sound_directory = state.sound_library_directory.clone();

    tauri::async_runtime::spawn_blocking(move || {
        use std::{io::{BufRead, BufReader, Read}, path::PathBuf, process::Stdio, thread};

        if request.clips.is_empty() {
            return Err("Adicione pelo menos uma mídia à timeline antes de exportar.".to_string());
        }
        let destination = PathBuf::from(&request.destination);
        if destination.extension().and_then(|value| value.to_str()).map(|value| !value.eq_ignore_ascii_case("mp4")).unwrap_or(true) {
            return Err("O arquivo de destino precisa ter a extensão .mp4.".into());
        }
        let mut args: Vec<String> = vec!["-y".into(), "-hide_banner".into(), "-loglevel".into(), "error".into()];
        let mut filter_parts: Vec<String> = Vec::new();
        let mut visual_inputs: Vec<(usize, &ExportClip)> = Vec::new();
        let mut audio_inputs: Vec<(usize, &ExportClip)> = Vec::new();
        let mut sound_inputs: Vec<(usize, &ExportSoundEffect)> = Vec::new();
        let mut overlay_inputs: Vec<(usize, &ExportImageOverlay)> = Vec::new();
        let mut icon_temp_files: Vec<PathBuf> = Vec::new();
        let mut text_temp_files: Vec<PathBuf> = Vec::new();
        let mut icon_inputs: Vec<(usize, usize, &ExportMotion)> = Vec::new();
        let mut total_ms = 0u64;

        for clip in &request.clips {
            if clip.source_end_ms <= clip.source_start_ms {
                continue;
            }
            let asset = assets.iter().find(|asset| asset.id == clip.asset_id)
                .ok_or_else(|| format!("A mídia do clipe {} não está mais na biblioteca.", clip.id))?;
            let relative = PathBuf::from(&asset.relative_path);
            if relative.components().any(|part| !matches!(part, std::path::Component::Normal(_))) {
                return Err("Caminho de mídia inválido durante a exportação.".into());
            }
            let media_dir = storage.project_media_directory(&request.project_id)?;
            let project_dir = media_dir.parent().ok_or("Diretório do projeto inválido.")?
                .canonicalize().map_err(|error| error.to_string())?;
            let file_path = project_dir.join(relative).canonicalize().map_err(|error| format!("Arquivo de mídia não encontrado: {error}"))?;
            if !file_path.starts_with(&project_dir) || !file_path.is_file() {
                return Err("Um arquivo da timeline não pertence a este projeto.".into());
            }
            let duration_ms = clip.source_end_ms - clip.source_start_ms;
            total_ms = total_ms.max(clip.timeline_start_ms + duration_ms);
            if clip.kind == "image" {
                args.extend(["-loop".into(), "1".into(), "-framerate".into(), "30".into(), "-t".into(), format!("{:.3}", duration_ms as f64 / 1000.0), "-i".into(), file_path.to_string_lossy().into_owned()]);
            } else {
                args.extend(["-ss".into(), format!("{:.3}", clip.source_start_ms as f64 / 1000.0), "-t".into(), format!("{:.3}", duration_ms as f64 / 1000.0), "-i".into(), file_path.to_string_lossy().into_owned()]);
            }
            let input_index = visual_inputs.len() + audio_inputs.len();
            if clip.kind == "audio" {
                audio_inputs.push((input_index, clip));
            } else {
                visual_inputs.push((input_index, clip));
            }
        }

        if visual_inputs.is_empty() {
            return Err("A timeline precisa conter pelo menos um vídeo ou uma imagem.".into());
        }
        let (ffmpeg_path, _) = resolve_ffmpeg_executable()?;
        let mut video_audio_inputs: Vec<(usize, &ExportClip)> = Vec::new();
        for (input_index, clip) in &visual_inputs {
            if clip.kind != "video" || clip.muted.unwrap_or(false) {
                continue;
            }
            let asset = assets.iter().find(|asset| asset.id == clip.asset_id)
                .ok_or_else(|| format!("A mídia do clipe {} não está mais na biblioteca.", clip.id))?;
            let relative = PathBuf::from(&asset.relative_path);
            let media_dir = storage.project_media_directory(&request.project_id)?;
            let project_dir = media_dir.parent().ok_or("Diretório do projeto inválido.")?
                .canonicalize().map_err(|error| error.to_string())?;
            let media_path = project_dir.join(relative).canonicalize()
                .map_err(|error| format!("Arquivo de vídeo não encontrado: {error}"))?;
            if media_has_audio_stream(&ffmpeg_path, &media_path)? {
                video_audio_inputs.push((*input_index, *clip));
            }
        }
        let registered_sounds = read_sound_manifest(&sound_directory)?;
        for sound in &request.sound_effects {
            let registered = registered_sounds.iter().find(|item| item.id == sound.sound_id)
                .ok_or_else(|| format!("O efeito sonoro {} não está mais na biblioteca global.", sound.sound_id))?;
            let path = sound_directory.join(&registered.file_name).canonicalize()
                .map_err(|error| format!("Arquivo de efeito sonoro não encontrado: {error}"))?;
            let canonical_directory = sound_directory.canonicalize().map_err(|error| error.to_string())?;
            if !path.starts_with(&canonical_directory) || !path.is_file() {
                return Err("Caminho de efeito sonoro inválido.".into());
            }
            let input_index = visual_inputs.len() + audio_inputs.len() + sound_inputs.len();
            args.extend(["-i".into(), path.to_string_lossy().into_owned()]);
            sound_inputs.push((input_index, sound));
        }

        for overlay in &request.image_overlays {
            if overlay.end_ms <= overlay.start_ms { continue; }
            let asset=assets.iter().find(|asset|asset.id==overlay.asset_id).ok_or_else(||format!("Imagem sobreposta {} não encontrada na biblioteca.",overlay.asset_id))?;
            if asset.kind!="image" { return Err("A camada sobreposta precisa ser uma imagem.".into()); }
            let relative=PathBuf::from(&asset.relative_path);
            if relative.components().any(|part|!matches!(part,std::path::Component::Normal(_))){return Err("Caminho de imagem sobreposta inválido.".into());}
            let media_dir=storage.project_media_directory(&request.project_id)?;
            let project_dir=media_dir.parent().ok_or("Diretório do projeto inválido.")?.canonicalize().map_err(|error|error.to_string())?;
            let file_path=project_dir.join(relative).canonicalize().map_err(|error|format!("Imagem sobreposta não encontrada: {error}"))?;
            if !file_path.starts_with(&project_dir)||!file_path.is_file(){return Err("A imagem sobreposta não pertence a este projeto.".into());}
            let duration=(overlay.end_ms-overlay.start_ms) as f64/1000.0;
            args.extend(["-loop".into(),"1".into(),"-framerate".into(),"30".into(),"-t".into(),format!("{duration:.3}"),"-i".into(),file_path.to_string_lossy().into_owned()]);
            let input_index=visual_inputs.len()+audio_inputs.len()+sound_inputs.len()+overlay_inputs.len();
            overlay_inputs.push((input_index,overlay));
            total_ms=total_ms.max(overlay.end_ms);
        }

        for (motion_index, item) in request.motion.iter().enumerate() {
            let Some(data_url) = item.lucide_icon_png.as_deref() else { continue; };
            let encoded = data_url.strip_prefix("data:image/png;base64,")
                .ok_or("Imagem Lucide inválida: esperado PNG em base64.")?;
            use base64::Engine as _;
            let bytes = base64::engine::general_purpose::STANDARD.decode(encoded)
                .map_err(|_| "Não foi possível decodificar a imagem do ícone Lucide.")?;
            if bytes.len() > 2 * 1024 * 1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                return Err("Imagem Lucide inválida ou maior que 2 MB.".into());
            }
            let icon_path = std::env::temp_dir().join(format!("framelab-icon-{}.png", uuid::Uuid::new_v4()));
            std::fs::write(&icon_path, &bytes).map_err(|error| format!("Não foi possível preparar o ícone: {error}"))?;
            let input_index = visual_inputs.len() + audio_inputs.len() + sound_inputs.len() + overlay_inputs.len() + icon_inputs.len();
            let duration = item.end_ms.saturating_sub(item.start_ms).max(1) as f64 / 1000.0;
            args.extend(["-loop".into(), "1".into(), "-framerate".into(), "30".into(), "-t".into(), format!("{duration:.3}"), "-i".into(), icon_path.to_string_lossy().into_owned()]);
            icon_temp_files.push(icon_path);
            icon_inputs.push((input_index, motion_index, item));
        }

        for item in &request.motion {
            total_ms = total_ms.max(item.end_ms);
        }
        if total_ms == 0 {
            return Err("A duração da timeline é inválida.".into());
        }

        filter_parts.push(format!("color=c=black:s=1080x1920:r=30:d={:.3}[base0]", total_ms as f64 / 1000.0));
        let mut previous = "base0".to_string();
        for (position, (input_index, clip)) in visual_inputs.iter().enumerate() {
            let label = format!("visual{position}");
            let start = clip.timeline_start_ms as f64 / 1000.0;
            let transition_ms = clip.transition_ms.min(2000);
            let transition_filter = if transition_ms == 0 { String::new() } else {
                let color = match clip.transition_type.as_str() { "fade-white" | "flash" => "white", _ => "black" };
                let duration = transition_ms as f64 / 1000.0;
                format!("fade=t=in:st=0:d={duration:.3}:color={color},")
            };
            filter_parts.push(format!("[{input_index}:v]{transition_filter}scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1,setpts=PTS-STARTPTS+{start:.3}/TB[{label}]"));
            let next = format!("base{}", position + 1);
            let end = (clip.timeline_start_ms + clip.source_end_ms - clip.source_start_ms) as f64 / 1000.0;
            let enable = ffmpeg_escape_expression(&format!("gte(t,{start:.6})*lt(t,{end:.6})"));
            filter_parts.push(format!("[{previous}][{label}]overlay=0:0:eof_action=pass:shortest=0:enable='{enable}'[{next}]"));
            previous = next;
        }

        for (position,(input_index,overlay)) in overlay_inputs.iter().enumerate() {
            let label=format!("image_overlay{position}");
            let start=overlay.start_ms as f64/1000.0;
            let end=overlay.end_ms as f64/1000.0;
            let width=overlay.width.clamp(1,1080);
            let height=overlay.height.clamp(1,1920);
            let source=format!("image_overlay_source{position}");
            let entrance_duration = (overlay.entrance_duration_ms.clamp(100, 3000) as f64 / 1000.0).min(end - start);
            let entrance_filter = match overlay.entrance_animation.as_str() {
                "fade" => format!(",fade=t=in:st=0:d={entrance_duration:.3}:alpha=1"),
                _ => String::new(),
            };
            filter_parts.push(format!("[{input_index}:v]scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=0x00000000,format=rgba{entrance_filter},setpts=PTS-STARTPTS+{start:.6}/TB[{source}]"));
            let next=format!("image_overlay_mix{position}");
            let x=(overlay.x.clamp(0.0,100.0)/100.0)*1080.0-width as f64/2.0;
            let y=(overlay.y.clamp(0.0,100.0)/100.0)*1920.0-height as f64/2.0;
            let slide_progress = format!("(1-pow(1-min(1\\,max(0\\,(t-{start:.6})/{entrance_duration:.3}))\\,3))");
            let animated_x = match overlay.entrance_animation.as_str() {
                "slide-left" => format!("{x:.2}-(1-({slide_progress}))*{width}"),
                "slide-right" => format!("{x:.2}+(1-({slide_progress}))*{width}"),
                _ => format!("{x:.2}"),
            };
            let animated_y = match overlay.entrance_animation.as_str() {
                "slide-up" => format!("{y:.2}+(1-({slide_progress}))*{height}"),
                "slide-down" => format!("{y:.2}-(1-({slide_progress}))*{height}"),
                _ => format!("{y:.2}"),
            };
            let enable = ffmpeg_escape_expression(&format!("gte(t,{start:.6})*lt(t,{end:.6})"));
            filter_parts.push(format!("[{previous}][{source}]overlay=x='{animated_x}':y='{animated_y}':format=auto:eof_action=pass:shortest=0:enable='{enable}'[{next}]"));
            previous=next;
        }

        for (index, item) in request.motion.iter().enumerate() {
            if item.is_caption {
                let start = item.start_ms as f64 / 1000.0;
                let end = item.end_ms as f64 / 1000.0;
                if end <= start { continue; }
                if let Some((x, y, width, height, color)) = caption_background_geometry(item) {
                    let background_label = format!("caption_background{index}");
                    filter_parts.push(format!(
                        "[{previous}]drawbox=x={x:.2}:y={y:.2}:w={width:.2}:h={height:.2}:color={color}:t=fill:enable='between(t\\,{start:.6}\\,{end:.6})'[{background_label}]"
                    ));
                    previous = background_label;
                }
                let subtitle_path = std::env::temp_dir().join(format!("framelab-caption-{}.ass", uuid::Uuid::new_v4()));
                std::fs::write(&subtitle_path, ass_caption_script(item).as_bytes())
                    .map_err(|error| format!("Não foi possível preparar a legenda karaoke: {error}"))?;
                text_temp_files.push(subtitle_path.clone());
                let subtitle_label = format!("caption_ass{index}");
                filter_parts.push(format!(
                    "[{previous}]ass=filename='{}'[{subtitle_label}]",
                    ffmpeg_escape_filter_path(&subtitle_path)
                ));
                previous = subtitle_label;
                continue;
            }
            let color = if item.color.starts_with('#') && item.color.len() == 7 { format!("0x{}", &item.color[1..]) } else { "white".into() };
            let (font_name, bold_suffix) = match item.font_family.as_str() {
                "Georgia" => ("georgia", "bd"), "Impact" => ("impact", ""),
                "Trebuchet MS" => ("trebuc", "bd"), "Verdana" => ("verdana", "bd"),
                "Courier New" => ("cour", "bd"), _ => ("arial", "bd"),
            };
            let font_suffix = if item.font_weight >= 700 { bold_suffix } else { "" };
            let font_file = format!("C\\:/Windows/Fonts/{font_name}{font_suffix}.ttf");
            // Use the same normalized 0-100% anchor as the editor preview.
            // The preview frame clips overflow, so do not silently shift text inward.
            let anchor_x = (item.x.clamp(0.0, 100.0) / 100.0) * 1080.0;
            let anchor_y = (item.y.clamp(0.0, 100.0) / 100.0) * 1920.0;
            let base_x = match item.text_align.as_str() {
                "left" => format!("{anchor_x}"),
                "right" => format!("{anchor_x}-text_w"),
                _ => format!("{anchor_x}-text_w/2"),
            };
            let start = item.start_ms as f64 / 1000.0;
            let end = item.end_ms as f64 / 1000.0;
            let entrance_duration_ms = item.entrance_duration_ms.clamp(100, 10000);
            let duration = entrance_duration_ms as f64 / 1000.0;
            let writing_duration = item.typewriter_duration_ms.clamp(100, 10000) as f64 / 1000.0;
            if item.preset == "typewriter" {
                // Render successive text prefixes in non-overlapping time slices. This
                // produces a true character-by-character reveal in the exported frames.
                let wrapped_text = wrap_text_for_export(&item.text, item.font_size);
                let characters: Vec<char> = wrapped_text.chars().collect();
                if characters.is_empty() { continue; }
                // A video is rendered at 30 fps. Creating one time slice per
                // character can make late slices shorter than a frame, so FFmpeg
                // may never evaluate the final prefixes. Reveal at most one prefix
                // per output frame, grouping characters when the text is longer.
                let frame_count = ((writing_duration * 30.0).floor() as usize).max(1);
                let steps = characters.len().min(frame_count).max(1);
                let mut current = previous.clone();
                for step in 0..steps {
                    let visible_count = ((step + 1) * characters.len() + steps - 1) / steps;
                    let prefix: String = characters[..visible_count].iter().collect();
                    let text_file = write_motion_text_file(&prefix, &mut text_temp_files)?;
                    let step_start = start + writing_duration * (step as f64 / steps as f64);
                    let step_end = start + writing_duration * ((step + 1) as f64 / steps as f64);
                    let next = format!("typewriter{index}_{step}");
                    // The preview removes the element exactly at endMs. Keep
                    // the final prefix bounded by that same lifetime instead of
                    // leaving it on screen for the rest of the exported video.
                    let enable = if step + 1 == steps {
                        format!("gte(t,{step_start:.6})*lt(t,{end:.6})")
                    } else {
                        format!("gte(t,{step_start:.6})*lt(t,{step_end:.6})")
                    };
                    let enable = ffmpeg_escape_expression(&enable);
                    filter_parts.push(format!("[{current}]drawtext=fontfile='{font_file}':textfile='{text_file}':fontcolor={color}:fontsize={}:x='{base_x}':y='{anchor_y}-text_h/2':enable='{enable}'[{next}]", item.font_size.clamp(18, 180)));
                    current = next;
                }
                previous = current;
                continue;
            }

            // Keep these curves in sync with motionPreviewState() in EditorWorkspace.tsx.
            let progress = format!("clip((t-{start:.6})/{duration:.6},0,1)");
            let eased = format!("(1-pow(1-{progress},3))");
            let (scale, x, alpha) = match item.preset.as_str() {
                "pop" => (format!("0.35+0.65*{eased}"), base_x.clone(), "1".to_string()),
                "slide" => ("1".to_string(), format!("({base_x})+text_w*(1-{eased})"), "1".to_string()),
                "zoom" => (format!("2.4-1.4*{eased}"), base_x.clone(), format!("min(1,{progress}*4)")),
                "impact" => (format!("if(lt({progress},0.65),3-2.12*({progress}/0.65),0.88+0.12*(({progress}-0.65)/0.35))"), base_x.clone(), format!("min(1,{progress}*4)")),
                _ => ("1".to_string(), base_x.clone(), "1".to_string()),
            };
            let next = format!("text{index}");
            let scale_expr = ffmpeg_escape_expression(&scale);
            let alpha_expr = ffmpeg_escape_expression(&alpha);
            let x_expr = ffmpeg_escape_expression(&x);
            let wrapped_text = wrap_text_for_export(&item.text, item.font_size);
            let text_file = write_motion_text_file(&wrapped_text, &mut text_temp_files)?;
            filter_parts.push(format!("[{previous}]drawtext=fontfile='{font_file}':textfile='{text_file}':fontcolor={color}:fontsize='max(1\\,{}*({scale_expr}))':alpha='{alpha_expr}':x='{x_expr}':y='{anchor_y}-text_h/2':enable='between(t\\,{start:.3}\\,{end:.3})'[{next}]", item.font_size.clamp(18, 180)));
            previous = next;
        }
        for (icon_position, (input_index, motion_index, item)) in icon_inputs.iter().enumerate() {
            let anchor_x = (item.x.clamp(0.0, 100.0) / 100.0) * 1080.0;
            let anchor_y = (item.y.clamp(0.0, 100.0) / 100.0) * 1920.0;
            let icon_size = item.lucide_icon_size.clamp(24, 512).max(24) as f64;
            let duration = item.entrance_duration_ms.clamp(100, 10000) as f64 / 1000.0;
            let progress = format!("clip(t/{duration:.6},0,1)");
            let eased = format!("(1-pow(1-{progress},3))");
            let (scale, fade_alpha) = match item.preset.as_str() {
                "pop" => (format!("0.35+0.65*{eased}"), false),
                "zoom" => (format!("2.4-1.4*{eased}"), true),
                "impact" => (format!("if(lt({progress},0.65),3-2.12*({progress}/0.65),0.88+0.12*(({progress}-0.65)/0.35))"), true),
                _ => ("1".to_string(), false),
            };
            let icon_stream = format!("icon_source{icon_position}_{motion_index}");
            let scale_expr = ffmpeg_escape_expression(&scale);
            let fade_filter = if fade_alpha {
                let start = item.start_ms as f64 / 1000.0;
                let fade_duration = (duration * 0.25).max(0.001);
                format!(",fade=t=in:st={start:.6}:d={fade_duration:.6}:alpha=1")
            } else {
                String::new()
            };
            filter_parts.push(format!("[{input_index}:v]scale=w='max(1\\,{icon_size}*({scale_expr}))':h='max(1\\,{icon_size}*({scale_expr}))':eval=frame,format=rgba{fade_filter}[{icon_stream}]"));
            let x = format!("{anchor_x}+({})+({icon_size}-overlay_w)/2", item.lucide_icon_offset_x);
            let y = format!("{anchor_y}+({})+({icon_size}-overlay_h)/2", item.lucide_icon_offset_y);
            let next = format!("icon{icon_position}_{motion_index}");
            let x_expr = ffmpeg_escape_expression(&x);
            let y_expr = ffmpeg_escape_expression(&y);
            let enable = ffmpeg_escape_expression(&format!("gte(t,{:.6})*lt(t,{:.6})", item.start_ms as f64 / 1000.0, item.end_ms as f64 / 1000.0));
            filter_parts.push(format!("[{previous}][{icon_stream}]overlay=x='{x_expr}':y='{y_expr}':format=auto:eof_action=pass:shortest=0:enable='{enable}'[{next}]"));
            previous = next;
        }
        filter_parts.push(format!("[{previous}]format=yuv420p[vout]"));

        let mut audio_labels = Vec::new();
        for (index, (input_index, clip)) in audio_inputs.iter().enumerate() {
            let label = format!("audio{index}");
            let delay = clip.timeline_start_ms;
            let volume = if clip.muted.unwrap_or(false) { 0.0 } else { clip.volume.clamp(0.0, 100.0) / 100.0 };
            filter_parts.push(format!("[{input_index}:a]asetpts=PTS-STARTPTS,volume={volume:.3},adelay={delay}|{delay}[{label}]"));
            audio_labels.push(format!("[{label}]"));
        }
        for (index, (input_index, clip)) in video_audio_inputs.iter().enumerate() {
            let label = format!("videoaudio{index}");
            let delay = clip.timeline_start_ms;
            let volume = clip.volume.clamp(0.0, 100.0) / 100.0;
            filter_parts.push(format!("[{input_index}:a]asetpts=PTS-STARTPTS,volume={volume:.3},adelay={delay}|{delay}[{label}]"));
            audio_labels.push(format!("[{label}]"));
        }
        for (index, (input_index, sound)) in sound_inputs.iter().enumerate() {
            let label = format!("sfx{index}");
            let delay = sound.timeline_start_ms;
            let volume = sound.volume.clamp(0.0, 100.0) / 100.0;
            filter_parts.push(format!("[{input_index}:a]asetpts=PTS-STARTPTS,volume={volume:.3},adelay={delay}|{delay}[{label}]"));
            audio_labels.push(format!("[{label}]"));
        }
        if !audio_labels.is_empty() {
            filter_parts.push(format!("{}amix=inputs={}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95,atrim=duration={:.3}[aout]", audio_labels.join(""), audio_labels.len(), total_ms as f64 / 1000.0));
        }

        // Valide os recursos reais do binário antes de iniciar a exportação.
        // Builds do FFmpeg podem existir sem filtros opcionais, como drawtext.
        let (ffmpeg_path, ffmpeg_version) = resolve_ffmpeg_executable()?;
        let mut required_filters = vec![
            "color", "scale", "crop", "fps", "setsar", "setpts", "overlay", "format", "fade",
        ];
        if request.motion.iter().any(|item| !item.is_caption) {
            required_filters.push("drawtext");
        }
        if request.motion.iter().any(|item| item.is_caption) {
            required_filters.extend(["ass", "drawbox"]);
        }
        if !icon_inputs.is_empty() {
            required_filters.push("colorchannelmixer");
        }
        if !audio_labels.is_empty() {
            required_filters.extend(["asetpts", "volume", "adelay", "amix", "alimiter", "atrim"]);
        }
        if let Err(error) = ensure_ffmpeg_capabilities(&ffmpeg_path, &required_filters) {
            for path in &icon_temp_files { let _ = std::fs::remove_file(path); }
            for path in &text_temp_files { let _ = std::fs::remove_file(path); }
            return Err(error);
        }

        // O grafo pode ficar muito grande (principalmente com typewriter,
        // que cria uma etapa drawtext por caractere). No Windows, passar todo
        // esse conteúdo como argumento pode ultrapassar o limite do CreateProcess.
        // Grave-o em arquivo e use a sintaxe compatível com a versão do FFmpeg.
        let filter_script_path = std::env::temp_dir()
            .join(format!("framelab-filter-{}.txt", uuid::Uuid::new_v4()));
        let filter_script = filter_parts.join(";\n");
        if let Err(error) = std::fs::write(&filter_script_path, filter_script.as_bytes()) {
            for path in &icon_temp_files { let _ = std::fs::remove_file(path); }
            for path in &text_temp_files { let _ = std::fs::remove_file(path); }
            return Err(format!("Não foi possível preparar os filtros de exportação: {error}"));
        }

        // FFmpeg 8.0 removed the deprecated -filter_complex_script option.
        // Newer versions load option values from files with the /option syntax.
        let ffmpeg_major = ffmpeg_version
            .split("version ")
            .nth(1)
            .and_then(|value| value.split('.').next())
            .and_then(|value| value.trim_start_matches('n').parse::<u32>().ok())
            .unwrap_or(0);
        // Nightly builds may report a git hash instead of a semantic FFmpeg
        // version. libavcodec 63 is the ABI shipped with FFmpeg 8.
        let libavcodec_major = ffmpeg_version
            .split("libavcodec")
            .nth(1)
            .and_then(|value| value.trim().split('.').next())
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(0);
        let filter_file_option = if ffmpeg_major >= 8 || libavcodec_major >= 63 {
            "-/filter_complex"
        } else {
            "-filter_complex_script"
        };

        args.extend([
            filter_file_option.into(),
            filter_script_path.to_string_lossy().into_owned(),
            "-map".into(),
            "[vout]".into(),
        ]);
        if !audio_labels.is_empty() {
            args.extend(["-map".into(), "[aout]".into(), "-c:a".into(), "aac".into(), "-b:a".into(), "192k".into()]);
        } else {
            args.push("-an".into());
        }
        args.extend(["-t".into(), format!("{:.3}", total_ms as f64 / 1000.0), "-c:v".into(), "libx264".into(), "-preset".into(), "medium".into(), "-crf".into(), "20".into(), "-pix_fmt".into(), "yuv420p".into(), "-movflags".into(), "+faststart".into(), "-progress".into(), "pipe:1".into(), "-nostats".into(), destination.to_string_lossy().into_owned()]);

        let output_result = crate::process::hidden_command(&ffmpeg_path)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        let mut child = match output_result {
            Ok(child) => child,
            Err(error) => {
                let _ = std::fs::remove_file(&filter_script_path);
                for path in &icon_temp_files { let _ = std::fs::remove_file(path); }
                for path in &text_temp_files { let _ = std::fs::remove_file(path); }
                return Err(format!(
                    "Não foi possível iniciar o FFmpeg em {}: {error}",
                    ffmpeg_path.display()
                ));
            }
        };
        // stderr é drenado em paralelo para evitar bloqueio do processo caso o FFmpeg
        // produza muitas mensagens de diagnóstico durante a renderização.
        let stderr_pipe = child.stderr.take();
        let stderr_reader = thread::spawn(move || {
            let mut details = String::new();
            if let Some(mut pipe) = stderr_pipe {
                let _ = pipe.read_to_string(&mut details);
            }
            details
        });
        if let Some(stdout) = child.stdout.take() {
            let reader = BufReader::new(stdout);
            for line in reader.lines().flatten() {
                if let Some(value) = line.strip_prefix("out_time_us=") {
                    if let Ok(elapsed_us) = value.parse::<u64>() {
                        let total_us = total_ms.saturating_mul(1000).max(1);
                        let percent = ((elapsed_us as f64 / total_us as f64) * 100.0).clamp(0.0, 99.0);
                        let _ = app.emit("export-progress", ExportProgress { percent });
                    }
                }
            }
        }
        // O FFmpeg lê o grafo de filtros depois de iniciar. Só podemos remover
        // o arquivo temporário quando o processo terminar, nunca logo após spawn().
        let status_result = child.wait();
        let _ = std::fs::remove_file(&filter_script_path);
        for path in &icon_temp_files { let _ = std::fs::remove_file(path); }
        for path in &text_temp_files { let _ = std::fs::remove_file(path); }
        let status = status_result
            .map_err(|error| format!("Não foi possível aguardar o FFmpeg: {error}"))?;
        let stderr = stderr_reader.join().unwrap_or_else(|_| "Não foi possível ler o diagnóstico do FFmpeg.".into());
        if !status.success() {
            let stderr = stderr.as_str();
            // Preserve o contexto do erro. A última linha isolada ("Filter not
            // found", por exemplo) esconde a causa útil ("No such filter: drawtext").
            let detail = stderr.lines().rev().take(12).collect::<Vec<_>>()
                .into_iter().rev().collect::<Vec<_>>().join("\n");
            let detail = if detail.trim().is_empty() {
                "O FFmpeg encerrou com erro, mas não forneceu detalhes.".to_string()
            } else {
                detail
            };
            return Err(format!("Falha ao exportar o vídeo:\n{detail}"));
        }
        let _ = app.emit("export-progress", ExportProgress { percent: 100.0 });
        Ok(destination.to_string_lossy().into_owned())
    }).await.map_err(|error| format!("A exportação foi interrompida: {error}"))?
}
