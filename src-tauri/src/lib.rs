// Copyright 2026 contributors to the GeoPlegmata project.
// Originally authored by Francisco Salgueiro, Instituto Superior Técnico (francisco.salgueiro@tecnico.ulisboa.pt)
//
// Licenced under the Apache Licence, Version 2.0 <LICENCE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENCE-MIT or http://opensource.org/licenses/MIT>, at your
// discretion. This file may not be copied, modified, or distributed
// except according to those terms.

#[tauri::command]
async fn get_data(
    store: String,
    level: u32,
) -> Result<Vec<gp_encoding::query::VisualizationCell>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use gp_encoding::{ZarrBackend, StorageBackend};
        let backend = ZarrBackend::open(std::path::Path::new(&store)).map_err(|e| e.to_string())?;
        gp_encoding::query::export_level_as_visualization_json(&backend, level)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn get_data_binary(store: String, level: u32, bbox: Option<Vec<f64>>) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use gp_encoding::{StorageBackend, ZarrBackend, BoundingBox};
        let bbox = bbox.map(|b| BoundingBox::new(b[0], b[1], b[2], b[3]));
        let backend = ZarrBackend::open(std::path::Path::new(&store)).map_err(|e| e.to_string())?;
        gp_encoding::query::export_level_as_visualization_binary(&backend, level, bbox)
            .map(tauri::ipc::Response::new)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn get_levels(store: String) -> Result<Vec<u32>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use gp_encoding::{ZarrBackend, StorageBackend};
        let backend = ZarrBackend::open(std::path::Path::new(&store)).map_err(|e| e.to_string())?;
        Ok(backend.levels())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn load_vector_geojson(path: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let val: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        gp_encoding::vector::decode(val).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn check_file_type(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use gp_encoding::{ZarrBackend, StorageBackend};
        if ZarrBackend::open(std::path::Path::new(&path)).is_ok() {
            return Ok("raster".to_string());
        }

        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                if json.get("dggrs").is_some()
                    || json.get("layers").is_some()
                    || json.get("geojson").is_some()
                    || json.get("type").is_some()
                    || json.get("features").is_some()
                {
                    return Ok("vector".to_string());
                }
            }
        }

        Err("Invalid file type: neither a DGGS raster nor a valid DGGS vector file".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_data,
            get_data_binary,
            get_levels,
            load_vector_geojson,
            check_file_type
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
