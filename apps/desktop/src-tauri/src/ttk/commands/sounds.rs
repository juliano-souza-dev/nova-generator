use tauri::State;
use crate::{infrastructure::sound_library, state::AppState};

pub use crate::infrastructure::sound_library::GlobalSound;

#[tauri::command]
pub fn list_global_sounds(state: State<'_, AppState>) -> Result<Vec<GlobalSound>, String> {
    sound_library::list(&state.sound_library_directory)
}

#[tauri::command]
pub fn import_global_sound(state: State<'_, AppState>, source_path: String, name: String) -> Result<GlobalSound, String> {
    sound_library::import(&state.sound_library_directory, &source_path, &name)
}

#[tauri::command]
pub fn get_global_sound_path(state: State<'_, AppState>, sound_id: String) -> Result<String, String> {
    sound_library::get_path(&state.sound_library_directory, &sound_id)
}

#[tauri::command]
pub fn delete_global_sound(state: State<'_, AppState>, sound_id: String) -> Result<(), String> {
    sound_library::delete(&state.sound_library_directory, &sound_id)
}
