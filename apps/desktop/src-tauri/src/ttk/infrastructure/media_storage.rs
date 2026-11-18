use std::{fs, path::{Path, PathBuf}};
use uuid::Uuid;

use crate::domain::models::{timestamp_millis, MediaAsset};

#[derive(Clone)]
pub struct MediaStorage {
    projects_directory: PathBuf,
}

impl MediaStorage {
    pub fn new(app_data_directory: PathBuf) -> Self {
        Self { projects_directory: app_data_directory.join("projects") }
    }

    pub fn create_project_directory(&self, project_id: &str) -> Result<PathBuf, String> {
        validate_project_id(project_id)?;
        let directory = self.projects_directory.join(project_id);
        fs::create_dir_all(directory.join("media")).map_err(|error| error.to_string())?;
        Ok(directory)
    }

    pub fn remove_project_directory(&self, project_id: &str) {
        if validate_project_id(project_id).is_ok() {
            let _ = fs::remove_dir_all(self.projects_directory.join(project_id));
        }
    }

    pub fn project_media_directory(&self, project_id: &str) -> Result<PathBuf, String> {
        validate_project_id(project_id)?;
        let directory = self.projects_directory.join(project_id);
        if !directory.is_dir() {
            return Err("A pasta deste projeto não foi encontrada.".into());
        }
        let media = directory.join("media");
        fs::create_dir_all(&media).map_err(|error| error.to_string())?;
        Ok(media)
    }

    pub fn copy_local_files(&self, project_id: &str, paths: &[String]) -> Result<(Vec<MediaAsset>, Vec<PathBuf>), String> {
        if paths.len() > 100 {
            return Err("Importe até 100 arquivos por vez.".into());
        }

        let media_directory = self.project_media_directory(project_id)?;
        let mut assets = Vec::with_capacity(paths.len());
        let mut copied = Vec::with_capacity(paths.len());

        for raw_path in paths {
            let result = self.copy_one(&media_directory, raw_path);
            match result {
                Ok((asset, destination)) => {
                    assets.push(asset);
                    copied.push(destination);
                }
                Err(error) => {
                    self.remove_files(&copied);
                    return Err(error);
                }
            }
        }
        Ok((assets, copied))
    }

    fn copy_one(&self, media_directory: &Path, raw_path: &str) -> Result<(MediaAsset, PathBuf), String> {
        let source = PathBuf::from(raw_path).canonicalize()
            .map_err(|error| format!("Não foi possível acessar o arquivo selecionado: {error}"))?;
        if !source.is_file() {
            return Err("Um dos itens selecionados não é um arquivo.".into());
        }

        let original_name = source.file_name().and_then(|value| value.to_str())
            .ok_or("Nome de arquivo inválido.")?.to_string();
        let extension = source.extension().and_then(|value| value.to_str()).unwrap_or("");
        let (kind, mime_type) = classify_extension(extension)
            .ok_or_else(|| format!("Formato não suportado: .{extension}"))?;

        let id = Uuid::new_v4().to_string();
        let extension = extension.to_ascii_lowercase();
        let filename = format!("{id}.{extension}");
        let destination = media_directory.join(&filename);
        fs::copy(&source, &destination)
            .map_err(|error| format!("Falha ao copiar {original_name}: {error}"))?;
        let size_bytes = fs::metadata(&destination).map_err(|error| error.to_string())?.len();

        let asset = MediaAsset {
            id, name: original_name.clone(), original_name, kind: kind.into(),
            mime_type: mime_type.into(), size_bytes, relative_path: format!("media/{filename}"),
            source: "local".into(), source_url: None, duration_ms: None,
            width: None, height: None, created_at: timestamp_millis(),
        };
        Ok((asset, destination))
    }

    pub fn create_youtube_target(&self, project_id: &str) -> Result<(String, PathBuf, PathBuf), String> {
        let directory = self.project_media_directory(project_id)?;
        let id = Uuid::new_v4().to_string();
        let template = directory.join(format!("{id}.%(ext)s"));
        let final_path = directory.join(format!("{id}.mp4"));
        Ok((id, template, final_path))
    }

    pub fn remove_files(&self, paths: &[PathBuf]) {
        for path in paths {
            let _ = fs::remove_file(path);
        }
    }
}

fn validate_project_id(project_id: &str) -> Result<(), String> {
    Uuid::parse_str(project_id)
        .map(|_| ())
        .map_err(|_| "Identificador de projeto inválido.".into())
}

fn classify_extension(extension: &str) -> Option<(&'static str, &'static str)> {
    match extension.to_ascii_lowercase().as_str() {
        "mp4" => Some(("video", "video/mp4")),
        "mov" => Some(("video", "video/quicktime")),
        "m4v" => Some(("video", "video/x-m4v")),
        "mkv" => Some(("video", "video/x-matroska")),
        "webm" => Some(("video", "video/webm")),
        "avi" => Some(("video", "video/x-msvideo")),
        "mp3" => Some(("audio", "audio/mpeg")),
        "wav" => Some(("audio", "audio/wav")),
        "m4a" => Some(("audio", "audio/mp4")),
        "aac" => Some(("audio", "audio/aac")),
        "flac" => Some(("audio", "audio/flac")),
        "ogg" => Some(("audio", "audio/ogg")),
        "opus" => Some(("audio", "audio/opus")),
        "png" => Some(("image", "image/png")),
        "jpg" | "jpeg" => Some(("image", "image/jpeg")),
        "webp" => Some(("image", "image/webp")),
        "gif" => Some(("image", "image/gif")),
        "bmp" => Some(("image", "image/bmp")),
        _ => None,
    }
}
