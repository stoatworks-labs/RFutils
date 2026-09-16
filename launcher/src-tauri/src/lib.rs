//! av-launcher — a Companion-style tray launcher that supervises a local
//! web-server app: pick a network interface + port, Start/Stop, open the GUI,
//! and live in the system tray.

mod config;
mod serve;

use std::process::{Child, Command};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent};

/// Runtime state: the supervised child process, or the in-process static
/// server, if running. A launcher has one or the other, never both — which
/// the config decides, not the panel.
#[derive(Default)]
struct AppState {
    child: Mutex<Option<Child>>,
    server: Mutex<Option<serve::StaticServer>>,
}

impl AppState {
    /// Kill the child or stop the server, whichever is running.
    fn shutdown(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        if let Ok(mut guard) = self.server.lock() {
            if let Some(server) = guard.take() {
                server.stop();
            }
        }
    }
}

/// Persisted user choices (port + interface + any custom field values), stored
/// next to the launcher's config in the OS app-config directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Settings {
    port: u16,
    /// Interface name (`en0`) or `all` for 0.0.0.0.
    interface: String,
    /// Custom-field values by key (e.g. `device` -> `192.168.1.42`). Older
    /// settings files without this parse fine and start empty.
    #[serde(default)]
    fields: std::collections::BTreeMap<String, String>,
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
    /// Custom inputs the panel should render (device IP, model, …).
    fields: Vec<config::FieldSpec>,
}

/// A field's effective value: the remembered one, or the config default when
/// nothing (or an empty string) is stored.
fn effective_fields(
    cfg: &config::LauncherConfig,
    s: &Settings,
) -> std::collections::BTreeMap<String, String> {
    cfg.field
        .iter()
        .map(|f| {
            let v = s
                .fields
                .get(&f.key)
                .filter(|x| !x.is_empty())
                .cloned()
                .unwrap_or_else(|| f.default.clone());
            (f.key.clone(), v)
        })
        .collect()
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

/// Where the operator's port/interface choice is remembered, in the OS
/// app-config directory.
fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolving app config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("creating app config dir: {e}"))?;
    Ok(dir.join("settings.json"))
}

/// Read persisted settings, falling back to defaults on EVERY failure path —
/// unresolvable config dir, missing file, unparseable JSON. Deliberate, so a
/// corrupt settings file can't brick the launcher, and it means a reset port is
/// silent: nothing distinguishes "never saved" from "file is damaged".
fn load_settings(app: &AppHandle, default_port: u16) -> Settings {
    let fallback = Settings {
        port: default_port,
        interface: "all".into(),
        fields: std::collections::BTreeMap::new(),
    };
    let Ok(path) = settings_path(app) else {
        return fallback;
    };
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or(fallback),
        Err(_) => fallback,
    }
}

/// Persist settings. Unlike loading, this reports a write failure — though
/// nothing re-reads to confirm the value survived.
fn store_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    let raw = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| format!("writing settings: {e}"))
}

#[tauri::command]
/// Static description of the supervised app, for the panel header: name,
/// default port, URL template and theme. Read from the launcher config, so it
/// changes only when the config does.
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
        fields: cfg.field,
    })
}

#[tauri::command]
/// Bindable IPv4 interfaces plus the `all` (0.0.0.0) pseudo-entry.
///
/// Infallible by design — the picker must always have something to show, so an
/// enumeration problem yields a short list rather than an error the panel would
/// have to handle.
fn list_interfaces() -> Vec<config::Interface> {
    config::list_interfaces()
}

#[tauri::command]
/// The operator's remembered port and interface, or the config's defaults.
fn get_settings(app: AppHandle) -> Result<Settings, String> {
    let cfg = config::load()?;
    Ok(load_settings(&app, cfg.app.default_port))
}

#[tauri::command]
/// Remember a port/interface/field choice. Takes effect on the next
/// start_server(); a running server is not restarted.
fn save_settings(
    app: AppHandle,
    port: u16,
    interface: String,
    fields: std::collections::BTreeMap<String, String>,
) -> Result<(), String> {
    store_settings(
        &app,
        &Settings {
            port,
            interface,
            fields,
        },
    )
}

/// Compute status from settings without touching the child (used by the UI to
/// preview the URL before starting).
fn status_from(app: &AppHandle, running: bool, message: String) -> Result<Status, String> {
    let cfg = config::load()?;
    let s = load_settings(app, cfg.app.default_port);
    let (_bind, display) = config::resolve_hosts(&s.interface);
    let mut url = cfg
        .app
        .url
        .replace("{host}", &display)
        .replace("{port}", &s.port.to_string());
    // Let a URL template reference a custom field too (e.g. {device}).
    for (k, v) in effective_fields(&cfg, &s) {
        url = url.replace(&format!("{{{k}}}"), &v);
    }
    Ok(Status {
        running,
        url,
        host: display,
        port: s.port,
        message,
    })
}

#[tauri::command]
/// Current launcher state, as the single object the panel re-renders from.
///
/// REAPS THE CHILD: it calls `try_wait()`, so a server that exited on its own is
/// noticed here rather than leaving the panel claiming it's running. That makes
/// this a side-effecting getter — the panel polls it, and removing the reap
/// would make the UI lie.
fn get_status(app: AppHandle, state: State<AppState>) -> Result<Status, String> {
    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    let child_running = match guard.as_mut() {
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

    // Same reap for the static server: a serving thread that has stopped is
    // forgotten here, so the panel offers Start rather than claiming Running.
    let mut guard = state.server.lock().map_err(|e| e.to_string())?;
    let server_running = match guard.as_ref() {
        Some(server) if server.is_running() => true,
        Some(_) => {
            *guard = None;
            false
        }
        None => false,
    };
    drop(guard);

    let running = child_running || server_running;
    let msg = if running { "Running" } else { "Stopped" };
    status_from(&app, running, msg.into())
}

/// Start the in-process static server described by `[serve]`.
fn start_static(
    app: &AppHandle,
    state: &State<AppState>,
    cfg: &config::LauncherConfig,
    spec: &config::ServeSpec,
) -> Result<Status, String> {
    {
        let guard = state.server.lock().map_err(|e| e.to_string())?;
        if guard.as_ref().is_some_and(|s| s.is_running()) {
            drop(guard);
            return status_from(app, true, "Running".into());
        }
    }

    let s = load_settings(app, cfg.app.default_port);
    let (bind_host, _display) = config::resolve_hosts(&s.interface);
    let resource_dir = app.path().resource_dir().ok();
    let paths = config::resolve_serve(spec, resource_dir.as_deref())?;

    let headers = match &paths.headers {
        Some(h) => serve::HeaderRules::parse(
            &std::fs::read_to_string(h).map_err(|e| format!("reading {}: {e}", h.display()))?,
        ),
        None => serve::HeaderRules::default(),
    };
    let site = serve::Site {
        root: paths.dir,
        index: spec.index.clone(),
        not_found: serve::NotFound::parse(&spec.not_found)?,
        headers,
    };
    let server = serve::StaticServer::start(site, &bind_host, s.port)?;
    *state.server.lock().map_err(|e| e.to_string())? = Some(server);

    status_from(app, true, "Running".into())
}

#[tauri::command]
/// Spawn the supervised server on the chosen interface and port.
///
/// Safe to call twice: an already-running child reports its current status
/// instead of being double-spawned. It does NOT restart, so a settings change
/// needs an explicit stop first.
///
/// The host:port reaches the server by whichever injection mode the launcher
/// config selects — patching a key in its TOML, environment variables, or
/// argv placeholders. See config.rs; the launcher itself knows nothing about
/// any particular server.
fn start_server(app: AppHandle, state: State<AppState>) -> Result<Status, String> {
    let cfg = config::load()?;

    // A static site is served from this process; there is no child.
    if let Some(spec) = &cfg.serve {
        return start_static(&app, &state, &cfg, spec);
    }
    if cfg.app.command.is_empty() {
        return Err(
            "launcher.toml has no [app].command and no [serve] block — nothing to start".into(),
        );
    }

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

    let s = load_settings(&app, cfg.app.default_port);
    let (bind_host, _display) = config::resolve_hosts(&s.interface);
    let fields = effective_fields(&cfg, &s);

    let work_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("resolving app config dir: {e}"))?;
    let resource_dir = app.path().resource_dir().ok();
    let launch = config::build_launch(
        &cfg,
        &bind_host,
        s.port,
        &fields,
        &work_dir,
        resource_dir.as_deref(),
    )?;

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
/// Kill the supervised server, or stop the in-process one. There is no
/// graceful-shutdown signal for a child, so a server that writes state on
/// exit gets no chance to.
fn stop_server(app: AppHandle, state: State<AppState>) -> Result<Status, String> {
    state.shutdown();
    status_from(&app, false, "Stopped".into())
}

#[tauri::command]
/// Open the server's web UI in the default browser, resolving the URL fresh
/// rather than reusing whatever the panel last rendered.
fn open_gui(app: AppHandle) -> Result<(), String> {
    let status = status_from(&app, false, String::new())?;
    tauri_plugin_opener::open_url(status.url, None::<&str>)
        .map_err(|e| format!("opening browser: {e}"))
}

#[tauri::command]
/// Kill the server and exit. Distinct from hide_window(), which leaves it
/// running in the tray — the difference an operator most often gets wrong.
fn quit_app(app: AppHandle, state: State<AppState>) {
    state.shutdown();
    app.exit(0);
}

#[tauri::command]
/// Hide the panel back to the tray. THE SERVER KEEPS RUNNING.
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
/// Restore the execute bit on a bundled binary if packaging stripped it.
///
/// A binary shipped as a Tauri resource can lose its execute bit on some
/// platforms, and the symptom is indistinguishable from the app simply not
/// working. Best-effort: every failure is swallowed, because a server that
/// already has its bit set is the normal case.
///
/// Note this does NOT address the macOS Gatekeeper trap, which is a different
/// failure with the same shape: for an unsigned .app bundling helper binaries,
/// approving the app does not unquarantine its payload and the helpers are
/// SIGKILLed silently. No permission change fixes that — see the README.
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
