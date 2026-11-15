// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder,
    menu::{Menu, MenuItemBuilder},
    tray::{TrayIconBuilder, MouseButton, MouseButtonState, TrayIconEvent},
    webview::{WebviewWindowBuilder as WebViewWindowBuilder, WindowEvent},
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FsExt;
use tauri_plugin_log::{TargetKind, Level, Builder as LogBuilder};

#[cfg(target_os = "windows")]
mod win_harness;

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct AppState {
    pub open_files: Mutex<Vec<OpenFile>>,
    pub file_contents_cache: Mutex<HashMap<String, String>>,
    pub window_settings: Mutex<WindowSettings>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenFile {
    pub id: String,
    pub label: String,
    pub path: PathBuf,
    pub mime_type: Option<String>,
    pub detected_encoding: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WindowSettings {
    pub width: f64,
    pub height: f64,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub is_maximized: bool,
    pub is_fullscreen: bool,
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

pub fn read_file_as_string(path: &Path) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    Ok(std::fs::read_to_string(path)?)
}

pub fn write_string_as_file(path: &Path, content: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content)?;
    Ok(())
}

pub fn read_dir(path: &Path) -> Result<Vec<std::fs::DirEntry>, Box<dyn std::error::Error + Send + Sync>> {
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(path)? {
        entries.push(entry?);
    }
    Ok(entries)
}

// ---------------------------------------------------------------------------
// Logging helper
// ---------------------------------------------------------------------------

fn setup_logging() {
    let _ = LogBuilder::new()
        .target(TargetKind::Stdout)
        .target(TargetKind::LogDir { path: None })
        .level(Level::Info)
        .build();
}

// ---------------------------------------------------------------------------
// Commands - App Info
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_app_version(_state: State<'_, AppState>) -> Result<String, String> {
    Ok(env!("CARGO_PKG_VERSION").to_string())
}

#[tauri::command]
pub async fn get_app_name(_state: State<'_, AppState>) -> Result<String, String> {
    Ok(env!("CARGO_PKG_NAME").to_string())
}

#[tauri::command]
pub async fn get_app_description(_state: State<'_, AppState>) -> Result<String, String> {
    Ok(env!("CARGO_PKG_DESCRIPTION").to_string())
}

#[tauri::command]
pub async fn app_info(app: AppHandle) -> Result<AppInfo, String> {
    Ok(AppInfo {
        name: app.package_info().name.clone(),
        version: app.package_info().version.to_string(),
        identifier: app.package_info().identifier.clone(),
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub identifier: String,
}

// ---------------------------------------------------------------------------
// Commands - File Operations
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn open_file_dialog(app: AppHandle) -> Result<Option<PathBuf>, String> {
    let path = app.dialog().file()
        .add_filter("All supported", &["csv", "xlsx", "json", "tsv", "parquet", "txt"])
        .add_filter("CSV", &["csv"])
        .add_filter("Excel", &["xlsx"])
        .add_filter("JSON", &["json"])
        .add_filter("TSV", &["tsv"])
        .add_filter("Parquet", &["parquet"])
        .add_filter("Text", &["txt"])
        .blocking_pick_file();
    Ok(path)
}

#[tauri::command]
pub async fn save_file_dialog(app: AppHandle) -> Result<Option<PathBuf>, String> {
    let path = app.dialog().file()
        .add_filter("CSV", &["csv"])
        .add_filter("Excel", &["xlsx"])
        .add_filter("JSON", &["json"])
        .add_filter("TSV", &["tsv"])
        .add_filter("Text", &["txt"])
        .blocking_save_file();
    Ok(path)
}

#[tauri::command]
pub async fn read_local_file(path: PathBuf) -> Result<String, String> {
    let content = read_file_as_string(&path).map_err(|e| e.to_string())?;
    Ok(content)
}

#[tauri::command]
pub async fn write_local_file(path: PathBuf, content: String) -> Result<(), String> {
    write_string_as_file(&path, &content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_directory(dir: PathBuf) -> Result<Vec<PathBuf>, String> {
    let mut entries = Vec::new();
    let read_dir = read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in read_dir {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_file() {
            entries.push(entry.path());
        }
    }
    Ok(entries)
}

#[tauri::command]
pub async fn read_text_file(path: PathBuf) -> Result<String, String> {
    let content = tauri_plugin_fs::read_text_file(&path).map_err(|e| e.to_string())?;
    Ok(content)
}

#[tauri::command]
pub async fn write_text_file(path: PathBuf, content: String) -> Result<(), String> {
    tauri_plugin_fs::write_text_file(&path, &content).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn file_exists(path: PathBuf) -> Result<bool, String> {
    Ok(std::path::Path::new(&path).exists())
}

#[tauri::command]
pub async fn get_file_info(path: PathBuf) -> Result<FileInfo, String> {
    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    Ok(FileInfo {
        path,
        is_file: metadata.is_file(),
        is_dir: metadata.is_dir(),
        len: metadata.len(),
        modified: metadata.modified().ok(),
        created: metadata.created().ok(),
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileInfo {
    pub path: PathBuf,
    pub is_file: bool,
    pub is_dir: bool,
    pub len: u64,
    pub modified: Option<std::time::SystemTime>,
    pub created: Option<std::time::SystemTime>,
}

// ---------------------------------------------------------------------------
// Commands - Window Management
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn minimize_window(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Window not found")?;
    window.minimize().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn maximize_window(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Window not found")?;
    window.maximize().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn unmaximize_window(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Window not found")?;
    window.unmaximize().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn toggle_maximize_window(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Window not found")?;
    let is_maximized = window.is_maximized().map_err(|e| e.to_string())?;
    if is_maximized {
        window.unmaximize().map_err(|e| e.to_string())?;
    } else {
        window.maximize().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn close_window(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Window not found")?;
    window.close().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn hide_window(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Window not found")?;
    window.hide().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn show_window(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Window not found")?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_window_title(app: AppHandle, title: String) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Window not found")?;
    window.set_title(&title).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_window_state(app: AppHandle) -> Result<WindowState, String> {
    let window = app.get_webview_window("main").ok_or("Window not found")?;
    let (width, height) = window.outer_size().map_err(|e| e.to_string())?;
    let (x, y) = window.outer_position().map_err(|e| e.to_string())?;
    let is_maximized = window.is_maximized().map_err(|e| e.to_string())?;
    let is_fullscreen = window.is_fullscreen().map_err(|e| e.to_string())?;
    let is_visible = window.is_visible().map_err(|e| e.to_string())?;
    let is_focus = window.is_focused().map_err(|e| e.to_string())?;
    Ok(WindowState {
        width,
        height,
        x,
        y,
        is_maximized,
        is_fullscreen,
        is_visible,
        is_focus,
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WindowState {
    pub width: f64,
    pub height: f64,
    pub x: f64,
    pub y: f64,
    pub is_maximized: bool,
    pub is_fullscreen: bool,
    pub is_visible: bool,
    pub is_focus: bool,
}

// ---------------------------------------------------------------------------
// Commands - Shell Operations
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    app.shell().open(&url).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn open_in_browser(app: AppHandle, path: String) -> Result<(), String> {
    app.shell().open(&path).map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands - Dialog Operations
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn show_message_dialog(app: AppHandle, message: String, title: String) -> Result<(), String> {
    app.dialog().message()
        .title(&title)
        .message(&message)
        .blocking_show();
    Ok(())
}

#[tauri::command]
pub async fn show_confirm_dialog(app: AppHandle, message: String, title: String) -> Result<bool, String> {
    let result = app.dialog().confirm()
        .title(&title)
        .message(&message)
        .blocking_wait();
    Ok(result)
}

// ---------------------------------------------------------------------------
// Commands - App Operations
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn quit_app(app: AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn reopen_app(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Window not found")?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Window / tray helpers
// ---------------------------------------------------------------------------

fn setup_app_window_tray(app: &AppHandle) {
    let window = match app.get_webview_window("main") {
        Some(w) => w,
        None => {
            log::warn!("Main window not found during tray setup");
            return;
        }
    };

    // On close, hide instead of exiting; Quit menu item is the only exit path.
    window.on_window_event(|event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = window.hide();
            log::info!("Ledgerly window hidden on close request");
        }
    });

    #[cfg(desktop)]
    {
        let quit_item = MenuItemBuilder::with_id("quit", "Quit Ledgerly")
            .build(app)
            .unwrap_or_else(|_| panic!("menu item init failed"));
        let show_item = MenuItemBuilder::with_id("show", "Show Ledgerly")
            .build(app)
            .unwrap_or_else(|_| panic!("menu item init failed"));

        let menu = Menu::with_items(app, &[&show_item, &quit_item])
            .unwrap_or_else(|_| panic!("menu init failed"));

        let _tray = TrayIconBuilder::new()
            .icon(app.default_window_icon().unwrap().clone())
            .menu(&menu)
            .tooltip("Ledgerly")
            .on_menu_event(|app, event| {
                match event.id.as_ref() {
                    "quit" => {
                        log::info!("Quit requested from tray");
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    _ => {}
                }
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                    let app = tray.app_handle();
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            })
            .build(app);
    }

    #[cfg(target_os = "windows")]
    {
        // Prepare Windows build environment so mingw can find the resource/.lib
        // toolchain even when Cargo is invoked from a Linux host.
        win_harness::prepare_env().ok();
    }
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

pub fn run() {
    setup_logging();
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .target(TargetKind::Stdout)
                .target(TargetKind::LogDir { path: None })
                .level(Level::Info)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .setup(|app| {
            setup_app_window_tray(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            get_app_name,
            get_app_description,
            app_info,
            open_file_dialog,
            save_file_dialog,
            read_local_file,
            write_local_file,
            list_directory,
            read_text_file,
            write_text_file,
            file_exists,
            get_file_info,
            minimize_window,
            maximize_window,
            unmaximize_window,
            toggle_maximize_window,
            close_window,
            hide_window,
            show_window,
            set_window_title,
            get_window_state,
            open_external_url,
            open_in_browser,
            show_message_dialog,
            show_confirm_dialog,
            quit_app,
            reopen_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
