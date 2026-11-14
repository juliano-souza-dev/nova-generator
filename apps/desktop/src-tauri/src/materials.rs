use serde_json::Value;
use std::fs;
use tauri::AppHandle;

fn materials_file(app: &AppHandle, project_id: &str, asset_id: &str) -> Result<std::path::PathBuf, String> {
    // Reuse the media layer's project/asset validation before constructing a module-owned path.
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
