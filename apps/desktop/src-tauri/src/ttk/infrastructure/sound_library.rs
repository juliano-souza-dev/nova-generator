use std::path::{Path, Component};

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSound {
    pub id: String,
    pub name: String,
    pub file_name: String,
}

fn sound_manifest_path(directory: &std::path::Path) -> std::path::PathBuf {
    directory.join("library.json")
}

pub(crate) fn read_sound_manifest(directory: &std::path::Path) -> Result<Vec<GlobalSound>, String> {
    let path = sound_manifest_path(directory);
    if !path.exists() { return Ok(Vec::new()); }
    let raw = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| format!("Biblioteca de sons inválida: {error}"))
}

fn write_sound_manifest(directory: &std::path::Path, sounds: &[GlobalSound]) -> Result<(), String> {
    let path = sound_manifest_path(directory);
    let temporary = directory.join("library.json.tmp");
    let json = serde_json::to_vec_pretty(sounds).map_err(|error| error.to_string())?;
    std::fs::write(&temporary, json).map_err(|error| error.to_string())?;
    if path.exists() { std::fs::remove_file(&path).map_err(|error| error.to_string())?; }
    std::fs::rename(temporary, path).map_err(|error| error.to_string())
}

pub fn list(directory: &Path) -> Result<Vec<GlobalSound>, String> {
    let mut sounds = read_sound_manifest(directory)?;
    sounds.retain(|sound| directory.join(&sound.file_name).is_file());
    Ok(sounds)
}

pub fn import(directory: &Path, source_path: &str, name: &str) -> Result<GlobalSound, String> {
    let source = Path::new(source_path);
    if !source.is_file() { return Err("O arquivo de áudio selecionado não existe.".into()); }
    if source.components().any(|part| matches!(part, Component::ParentDir)) {
        return Err("Caminho de áudio inválido.".into());
    }
    let extension = source.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    if !["mp3", "wav", "ogg", "m4a", "aac", "flac"].contains(&extension.as_str()) {
        return Err("Formato não suportado. Use MP3, WAV, OGG, M4A, AAC ou FLAC.".into());
    }
    let clean_name = name.trim();
    if clean_name.is_empty() { return Err("Informe um nome para o efeito sonoro.".into()); }
    let mut sounds = read_sound_manifest(directory)?;
    let id = uuid::Uuid::new_v4().to_string();
    let file_name = format!("{id}.{extension}");
    let destination = directory.join(&file_name);
    std::fs::copy(source, &destination).map_err(|error| format!("Não foi possível copiar o áudio: {error}"))?;
    let sound = GlobalSound { id, name: clean_name.to_string(), file_name };
    sounds.push(sound.clone());
    if let Err(error) = write_sound_manifest(directory, &sounds) {
        let _ = std::fs::remove_file(destination);
        return Err(error);
    }
    Ok(sound)
}

pub fn get_path(directory: &Path, sound_id: &str) -> Result<String, String> {
    let sounds = read_sound_manifest(directory)?;
    let sound = sounds.iter().find(|item| item.id == sound_id).ok_or("Efeito sonoro não encontrado.")?;
    let path = directory.join(&sound.file_name).canonicalize().map_err(|error| error.to_string())?;
    if !path.starts_with(&directory.canonicalize().map_err(|error| error.to_string())?) || !path.is_file() {
        return Err("Caminho do efeito sonoro inválido.".into());
    }
    Ok(path.to_string_lossy().into_owned())
}

pub fn delete(directory: &Path, sound_id: &str) -> Result<(), String> {
    let mut sounds = read_sound_manifest(directory)?;
    let index = sounds.iter().position(|item| item.id == sound_id).ok_or("Efeito sonoro não encontrado.")?;
    let sound = sounds.remove(index);
    let path = directory.join(&sound.file_name);
    if path.exists() { std::fs::remove_file(path).map_err(|error| error.to_string())?; }
    write_sound_manifest(directory, &sounds)
}
