mod artifacts;
mod attachments;
mod discovery;
mod fonts;
mod local_discovery;
mod permission;
mod pi_query;
mod reasoning;
mod runtime;
mod storage;
mod traex_query;
mod types;

use runtime::RuntimeManager;
use serde_json::Value;
use std::sync::Arc;
use storage::Storage;
use tauri::{Emitter, Manager, State};
use types::{
    LocalEnvironmentReport, ProbeResult, RuntimeEvent, StartRequest, StorageInfo, TraceRef,
};

struct AppServices {
    storage: Arc<Storage>,
    runtimes: RuntimeManager,
}

#[tauri::command]
async fn load_state(services: State<'_, AppServices>) -> Result<Option<Value>, String> {
    let storage = services.storage.clone();
    tauri::async_runtime::spawn_blocking(move || storage.load())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn load_workspace_summary(services: State<'_, AppServices>) -> Result<Option<Value>, String> {
    let storage = services.storage.clone();
    tauri::async_runtime::spawn_blocking(move || storage.summary())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn load_task_event_page(
    task_id: String,
    after: i64,
    through: Option<i64>,
    services: State<'_, AppServices>,
) -> Result<Value, String> {
    let storage = services.storage.clone();
    tauri::async_runtime::spawn_blocking(move || storage.event_page(&task_id, after, through))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn load_trace_events(
    refs: Vec<TraceRef>,
    known_event_ids: Option<std::collections::HashMap<String, std::collections::HashSet<String>>>,
    services: State<'_, AppServices>,
) -> Result<Vec<RuntimeEvent>, String> {
    let storage = services.storage.clone();
    tauri::async_runtime::spawn_blocking(move || {
        storage.load_trace_events_except(&refs, &known_event_ids.unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn save_state(state: Value, services: State<'_, AppServices>) -> Result<(), String> {
    let storage = services.storage.clone();
    tauri::async_runtime::spawn_blocking(move || storage.save(&state))
        .await
        .map_err(|e| e.to_string())?
}

// A distinct command fails closed if a new web frontend meets an old binary.
// Never let an old save_state interpret an event delta as a full snapshot.
#[tauri::command]
async fn save_state_delta(state: Value, services: State<'_, AppServices>) -> Result<(), String> {
    let storage = services.storage.clone();
    tauri::async_runtime::spawn_blocking(move || storage.save_delta(&state))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn probe_runtime(executable: String) -> Result<ProbeResult, String> {
    tauri::async_runtime::spawn_blocking(move || discovery::probe(&executable))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn discover_local_environment() -> Result<LocalEnvironmentReport, String> {
    tauri::async_runtime::spawn_blocking(local_discovery::discover)
        .await
        .map_err(|_| "本机检测任务未能完成，请重试".to_string())
}

#[tauri::command]
async fn storage_info(services: State<'_, AppServices>) -> Result<StorageInfo, String> {
    let storage = services.storage.clone();
    tauri::async_runtime::spawn_blocking(move || storage.info())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn start_run(
    request: StartRequest,
    app: tauri::AppHandle,
    services: State<'_, AppServices>,
) -> Result<(), String> {
    services.runtimes.start(
        request,
        Arc::new(move |event| {
            let _ = app.emit("runtime-event", event);
        }),
    )
}

#[tauri::command]
fn stop_run(
    run_id: String,
    member_id: Option<String>,
    services: State<'_, AppServices>,
) -> Result<(), String> {
    services.runtimes.stop(&run_id, member_id.as_deref())
}

#[tauri::command]
fn respond_runtime_permission(
    run_id: String,
    member_id: String,
    request_id: String,
    option_id: Option<String>,
    services: State<'_, AppServices>,
) -> Result<(), String> {
    services
        .runtimes
        .respond_permission(&run_id, &member_id, &request_id, option_id.as_deref())
}

#[tauri::command]
async fn export_task(task: Value, services: State<'_, AppServices>) -> Result<String, String> {
    let storage = services.storage.clone();
    tauri::async_runtime::spawn_blocking(move || storage.export(&task))
        .await
        .map_err(|e| e.to_string())?
}

fn validated_external_url(value: &str) -> Result<tauri::Url, String> {
    let invalid = || "只能打开不含登录凭证的 HTTP 或 HTTPS 网页链接。".to_string();
    if value
        .chars()
        .any(|character| character.is_control() || character == ' ')
        || !value
            .get(..7)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("http://"))
            && !value
                .get(..8)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
    {
        return Err(invalid());
    }
    let url = tauri::Url::parse(value).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid());
    }
    Ok(url)
}

#[tauri::command]
async fn open_external_url(window: tauri::WebviewWindow, url: String) -> Result<(), String> {
    if window.label() != "main" {
        return Err("此窗口无法打开外部链接。".into());
    }
    let url = validated_external_url(&url)?;
    #[cfg(target_os = "macos")]
    return tauri::async_runtime::spawn_blocking(move || {
        // The scheme guard above guarantees this single argument cannot be an
        // option or local path. Never dispatch through a shell or navigate the
        // privileged app webview to model-generated content.
        let status = std::process::Command::new("/usr/bin/open")
            .arg(url.as_str())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|_| "无法启动默认浏览器。".to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err("默认浏览器未能打开此链接。".into())
        }
    })
    .await
    .map_err(|_| "打开链接的任务未能完成。".to_string())?;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = url;
        Err("当前桌面版本仅支持在 macOS 打开外部链接。".into())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init());
    #[cfg(target_os = "macos")]
    let builder = builder.on_window_event(|window, event| {
        if window.label() == "main" {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Err(error) = window.hide() {
                    eprintln!("无法隐藏 Goalward 窗口：{error}");
                }
            }
        }
    });
    let app = builder
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            storage::migrate_legacy_data(&data_dir).map_err(std::io::Error::other)?;
            let storage = Arc::new(Storage::new(data_dir).map_err(std::io::Error::other)?);
            let runtimes = RuntimeManager::new(storage.clone());
            app.manage(AppServices { storage, runtimes });
            #[cfg(debug_assertions)]
            {
                use tauri::menu::{Menu, MenuItem, Submenu};

                let menu = match app.menu() {
                    Some(menu) => menu,
                    None => Menu::default(app.handle())?,
                };
                let reload = MenuItem::with_id(
                    app,
                    "dev-reload",
                    "重新加载页面",
                    true,
                    Some("CmdOrCtrl+R"),
                )?;
                menu.append(&Submenu::with_items(app, "开发", true, &[&reload])?)?;
                app.set_menu(menu)?;
                app.on_menu_event(|app, event| {
                    if event.id().as_ref() == "dev-reload" {
                        if let Some(window) = app.get_webview_window("main") {
                            if let Err(error) = window.reload() {
                                eprintln!("重新加载页面失败：{error}");
                            }
                        }
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fonts::list_system_fonts,
            load_state,
            load_workspace_summary,
            load_task_event_page,
            load_trace_events,
            save_state,
            save_state_delta,
            probe_runtime,
            discover_local_environment,
            storage_info,
            start_run,
            stop_run,
            respond_runtime_permission,
            export_task,
            open_external_url,
            attachments::read_clipboard_attachments,
            attachments::save_clipboard_file,
            attachments::read_attachment_image,
            artifacts::read_artifact,
            artifacts::open_artifact,
            artifacts::save_artifact
        ])
        .build(tauri::generate_context!())
        .expect("Cannot initialize Goalward");
    app.run(|app, event| match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => {
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = window.show().and_then(|_| window.set_focus()) {
                    eprintln!("无法重新显示 Goalward 窗口：{error}");
                }
            }
        }
        tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. } => {
            app.state::<AppServices>().runtimes.shutdown();
        }
        _ => {}
    });
}

#[cfg(test)]
mod external_url_tests {
    use super::validated_external_url;

    #[test]
    fn accepts_only_absolute_web_urls_and_preserves_web_query_boundaries() {
        for value in [
            "https://example.com/docs?q=a%20b&source=chat#section",
            "http://127.0.0.1:1420/",
            "HTTPS://example.com/中文",
        ] {
            let url = validated_external_url(value).unwrap();
            assert!(matches!(url.scheme(), "http" | "https"));
        }
        assert_eq!(
            validated_external_url("https://example.com/?q=$(touch)")
                .unwrap()
                .query(),
            Some("q=$(touch)")
        );
    }

    #[test]
    fn rejects_app_schemes_credentials_controls_and_relative_paths() {
        for value in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "mailto:a@example.com",
            "data:text/html,test",
            "codex://threads/test",
            "/tmp/report.html",
            "//example.com",
            "https:example.com",
            "https://user:password@example.com",
            "https://user@example.com",
            "https://:password@example.com",
            " https://example.com",
            "https://example.com/a b",
            "https://example.com\n",
            "https://example.com\0",
            "https://example.com/\u{0085}",
            "https://",
            "--args",
            "",
        ] {
            assert!(validated_external_url(value).is_err(), "accepted {value:?}");
        }
    }
}
