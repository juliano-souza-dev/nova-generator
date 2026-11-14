mod media;
mod alignment;
mod shared_runtime;
mod transcription;
mod translation;
mod translation_contract;
mod process;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, time::{SystemTime, UNIX_EPOCH}};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Project {
    id: String,
    name: String,
    status: String,
    stage: String,
    created_at: String,
    updated_at: String,
}

fn projects_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    dir.push("projects.json");
    Ok(dir)
}

fn read_projects(app: &tauri::AppHandle) -> Result<Vec<Project>, String> {
    let path = projects_file(app)?;
    if !path.exists() { return Ok(Vec::new()); }
    let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if content.trim().is_empty() { return Ok(Vec::new()); }
    serde_json::from_str(&content).map_err(|e| format!("Não foi possível ler a lista de projetos: {e}"))
}

fn write_projects(app: &tauri::AppHandle, projects: &[Project]) -> Result<(), String> {
    let path = projects_file(app)?;
    let content = serde_json::to_string_pretty(projects).map_err(|e| e.to_string())?;
    fs::write(path, content).map_err(|e| format!("Não foi possível salvar os projetos: {e}"))
}

fn now() -> String {
    let duration = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let millis = duration.as_millis();
    let seconds = (millis / 1000) as i64;
    let days = seconds / 86400;
    let day_seconds = seconds % 86400;
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe/1460 + doe/36524 - doe/146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365*yoe + yoe/4 - yoe/100);
    let mp = (5*doy + 2)/153;
    let day = doy - (153*mp+2)/5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += if month <= 2 { 1 } else { 0 };
    let hour = day_seconds / 3600;
    let minute = (day_seconds % 3600) / 60;
    let second = day_seconds % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{:03}Z", millis % 1000)
}

fn new_id() -> String {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    format!("{:032x}", n)
}

#[tauri::command]
fn list_projects(app: tauri::AppHandle) -> Result<Vec<Project>, String> {
    let mut projects = read_projects(&app)?;
    projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(projects)
}

#[tauri::command]
fn create_project(app: tauri::AppHandle, name: String) -> Result<Project, String> {
    let name = name.trim();
    if name.is_empty() { return Err("Informe um nome para o projeto.".into()); }
    if name.chars().count() > 80 { return Err("O nome deve ter no máximo 80 caracteres.".into()); }
    let timestamp = now();
    let project = Project {
        id: new_id(), name: name.to_string(), status: "in_progress".into(),
        stage: "Editorial".into(), created_at: timestamp.clone(), updated_at: timestamp,
    };
    let mut projects = read_projects(&app)?;
    projects.push(project.clone());
    write_projects(&app, &projects)?;
    Ok(project)
}

#[tauri::command]
fn duplicate_project(app: tauri::AppHandle, id: String) -> Result<Project, String> {
    let mut projects = read_projects(&app)?;
    let original = projects.iter().find(|p| p.id == id).cloned().ok_or("Projeto não encontrado.")?;
    let timestamp = now();
    let copy = Project {
        id: new_id(), name: format!("{} (cópia)", original.name),
        status: "in_progress".into(), stage: "Editorial".into(),
        created_at: timestamp.clone(), updated_at: timestamp,
    };
    projects.push(copy.clone());
    write_projects(&app, &projects)?;
    Ok(copy)
}

#[tauri::command]
fn delete_project(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let mut projects = read_projects(&app)?;
    let previous = projects.len();
    projects.retain(|p| p.id != id);
    if projects.len() == previous { return Err("Projeto não encontrado.".into()); }
    write_projects(&app, &projects)
}

#[tauri::command]
fn update_project_status(app: tauri::AppHandle, id: String, status: String) -> Result<Project, String> {
    if status != "in_progress" && status != "completed" {
        return Err("Status de projeto inválido.".into());
    }
    let mut projects = read_projects(&app)?;
    let project = projects.iter_mut().find(|p| p.id == id).ok_or("Projeto não encontrado.")?;
    project.status = status;
    project.updated_at = now();
    let updated = project.clone();
    write_projects(&app, &projects)?;
    Ok(updated)
}

#[tauri::command]
fn save_external_translation_package(path: String, bytes: Vec<u8>) -> Result<(), String> {
    if !path.to_ascii_lowercase().ends_with(".txt") {
        return Err("A entrada editorial precisa ser salva como arquivo .txt.".into());
    }
    if bytes.is_empty() || bytes.len() > 20 * 1024 * 1024 {
        return Err("O arquivo TXT está vazio ou excede o limite de 20 MB.".into());
    }
    fs::write(&path, bytes).map_err(|e| format!("Não foi possível gravar o arquivo TXT: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_projects, create_project, duplicate_project, delete_project, update_project_status, save_external_translation_package,
            media::inspect_youtube, media::prepare_youtube_cache, media::authorize_youtube_preview, media::list_project_media,
            media::import_media_files, media::trim_youtube_cache,
            media::open_project_media, media::load_project_subtitles, media::save_project_subtitles,
            alignment::align_project_subtitles,
            shared_runtime::get_shared_runtime_status,
            transcription::transcribe_media, transcription::check_local_asr, transcription::install_local_asr,
            translation::translate_project_subtitles, translation::load_project_translations, translation::save_project_translations,
            translation::load_project_editorial_result, translation::save_project_editorial_result, translation::clear_project_editorial_result, translation::approve_project_editorial_result,
            translation_contract::prepare_external_translation_package
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Nova Generator");
}
