//! av-launcher — a Companion-style tray launcher that supervises a local
//! web-server app: pick a network interface + port, Start/Stop, open the GUI,
//! and live in the system tray.

mod config;

use std::process::{Child, Command};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent};

/// Runtime state: the supervised child process, if running.
#[derive(Default)]
struct AppState {
    child: Mutex<Option<Child>>,
}

impl AppState {
    /// Kill the child, if one is running. Idempotent: the second caller finds
    /// nothing to do.
    fn shutdown(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// Persisted user choices (port + interface), stored next to the launcher's
/// config in the OS app-config directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Settings {
    port: u16,
    /// Interface name (`en0`) or `all` for 0.0.0.0.
    interface: String,
}

/// Static info about the supervised app, for the UI header.
#[derive(Debug, Clone, Serialize)]
struct AppInfo {
    name: String,
    default_port: u16,
    url_template: String,
    /// Where this launcher keeps `settings.json` — resolved per-platform, so
    /// the panel can name it instead of guessing a macOS path.
    config_dir: String,
    theme: std::collections::BTreeMap<String, String>,
}

/// The launcher's current status, mirrored into the panel.
#[derive(Debug, Clone, Serialize)]
struct Status {
    running: bool,
    url: String,
    host: String,
    port: u16,
    message: String,
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolving app config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("creating app config dir: {e}"))?;
    Ok(dir.join("settings.json"))
}

fn load_settings(app: &AppHandle, default_port: u16) -> Settings {
    let fallback = Settings {
        port: default_port,
        interface: "all".into(),
    };
    let Ok(path) = settings_path(app) else {
        return fallback;
    };
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or(fallback),
        Err(_) => fallback,
    }
}

fn store_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    let raw = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| format!("writing settings: {e}"))
}

#[tauri::command]
fn get_app_info(app: AppHandle) -> Result<AppInfo, String> {
    let cfg = config::load()?;
    Ok(AppInfo {
        name: cfg.app.name,
        default_port: cfg.app.default_port,
        url_template: cfg.app.url,
        config_dir: app
            .path()
            .app_config_dir()
            .map(|d| d.display().to_string())
            .unwrap_or_else(|_| "unavailable".into()),
        theme: cfg.app.theme,
    })
}

#[tauri::command]
fn list_interfaces() -> Vec<config::Interface> {
    config::list_interfaces()
}

#[tauri::command]
fn get_settings(app: AppHandle) -> Result<Settings, String> {
    let cfg = config::load()?;
    Ok(load_settings(&app, cfg.app.default_port))
}

#[tauri::command]
fn save_settings(app: AppHandle, port: u16, interface: String) -> Result<(), String> {
    store_settings(&app, &Settings { port, interface })
}

/// Compute status from settings without touching the child (used by the UI to
/// preview the URL before starting).
fn status_from(app: &AppHandle, running: bool, message: String) -> Result<Status, String> {
    let cfg = config::load()?;
    let s = load_settings(app, cfg.app.default_port);
    let (_bind, display) = config::resolve_hosts(&s.interface);
    let url = cfg
        .app
        .url
        .replace("{host}", &display)
        .replace("{port}", &s.port.to_string());
    Ok(Status {
        running,
        url,
        host: display,
        port: s.port,
        message,
    })
}

#[tauri::command]
fn get_status(app: AppHandle, state: State<AppState>) -> Result<Status, String> {
    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    let running = match guard.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(Some(_exited)) => {
                *guard = None; // process ended on its own
                false
            }
            Ok(None) => true,
            Err(_) => false,
        },
        None => false,
    };
    drop(guard);
    let msg = if running { "Running" } else { "Stopped" };
    status_from(&app, running, msg.into())
}

#[tauri::command]
fn start_server(app: AppHandle, state: State<AppState>) -> Result<Status, String> {
    {
        // Already running? Report current status instead of double-spawning.
        let mut guard = state.child.lock().map_err(|e| e.to_string())?;
        if let Some(child) = guard.as_mut() {
            if matches!(child.try_wait(), Ok(None)) {
                drop(guard);
                return status_from(&app, true, "Running".into());
            }
        }
    }

    let cfg = config::load()?;
    let s = load_settings(&app, cfg.app.default_port);
    let (bind_host, _display) = config::resolve_hosts(&s.interface);

    let work_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolving app config dir: {e}"))?;
    let resource_dir = app.path().resource_dir().ok();
    let launch =
        config::build_launch(&cfg, &bind_host, s.port, &work_dir, resource_dir.as_deref())?;

    // A binary bundled as a resource can lose its execute bit on some platforms;
    // restore it before spawning so a shipped bundle just works.
    #[cfg(unix)]
    ensure_executable(&launch.program);

    let mut cmd = Command::new(&launch.program);
    cmd.args(&launch.args);

    // A GUI process spawning a console child pops a console window on Windows.
    // The server's output is not surfaced anywhere, so the window is pure noise
    // sitting on top of the panel.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    for (k, v) in &launch.envs {
        cmd.env(k, v);
    }
    if let Some(cwd) = &launch.cwd {
        std::fs::create_dir_all(cwd).ok();
        cmd.current_dir(cwd);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("starting {}: {e}", launch.program))?;
    *state.child.lock().map_err(|e| e.to_string())? = Some(child);

    status_from(&app, true, "Running".into())
}

#[tauri::command]
fn stop_server(app: AppHandle, state: State<AppState>) -> Result<Status, String> {
    state.shutdown();
    status_from(&app, false, "Stopped".into())
}

#[tauri::command]
fn open_gui(app: AppHandle) -> Result<(), String> {
    let status = status_from(&app, false, String::new())?;
    tauri_plugin_opener::open_url(status.url, None::<&str>)
        .map_err(|e| format!("opening browser: {e}"))
}

#[tauri::command]
fn quit_app(app: AppHandle, state: State<AppState>) {
    state.shutdown();
    app.exit(0);
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg(unix)]
fn ensure_executable(path: &str) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path) {
        let mode = meta.permissions().mode();
        if mode & 0o111 == 0 {
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode | 0o755));
        }
    }
}

/// Pin the config path so `config::load()` (which has no app handle) finds it.
/// Precedence: existing `$AV_LAUNCHER_CONFIG` > `./launcher.toml` (dev) >
/// the bundled `launcher.toml` in the resource dir.
fn pin_config_path(app: &AppHandle) {
    if std::env::var_os("AV_LAUNCHER_CONFIG").is_some() {
        return;
    }
    if std::env::current_dir()
        .map(|d| d.join("launcher.toml").exists())
        .unwrap_or(false)
    {
        return; // find_config_path will pick up ./launcher.toml
    }
    if let Ok(res) = app.path().resource_dir() {
        let bundled = res.join("launcher.toml");
        if bundled.exists() {
            std::env::set_var("AV_LAUNCHER_CONFIG", bundled);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            list_interfaces,
            get_settings,
            save_settings,
            get_status,
            start_server,
            stop_server,
            open_gui,
            hide_window,
            quit_app,
        ])
        .setup(|app| {
            pin_config_path(&app.handle().clone());

            // Name the tray after the app being launched, when we can read it.
            let app_name = config::load()
                .map(|c| c.app.name)
                .unwrap_or_else(|_| "Launcher".into());

            // Tray menu: Show / Quit.
            let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip(&app_name)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => {
                        if let Some(state) = app.try_state::<AppState>() {
                            state.shutdown();
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        // Closing the window hides it to the tray instead of quitting.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Every way out passes through here: ⌘Q, Quit from the Dock, and the
        // exit() our own Quit items call after stopping the server themselves.
        // Without this, ⌘Q exited the shell and left the child listening —
        // orphaned, with no tray left to stop it from, and holding the port
        // against the next Start. shutdown() is idempotent, so the paths that
        // already stopped the server cost nothing here.
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<AppState>() {
                    state.shutdown();
                }
            }
        });
}
