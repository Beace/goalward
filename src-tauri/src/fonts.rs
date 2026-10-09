#[tauri::command]
pub async fn list_system_fonts(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let (sender, receiver) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            let result = available_font_families();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            receiver.recv().map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())??
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("System font discovery is currently supported on macOS".to_string())
    }
}

#[cfg(target_os = "macos")]
pub(crate) fn available_font_families() -> Result<Vec<String>, String> {
    let mtm = objc2::MainThreadMarker::new()
        .ok_or_else(|| "Font discovery requires the main thread".to_string())?;
    let manager = objc2_app_kit::NSFontManager::sharedFontManager(mtm);
    let mut families: Vec<String> = manager
        .availableFontFamilies()
        .iter()
        .map(|name| name.to_string())
        .filter(|name| !name.is_empty() && !name.starts_with('.'))
        .collect();
    families.sort();
    families.dedup();
    Ok(families)
}
