//! av-launcher — a Companion-style tray launcher that supervises a local
//! web-server app: pick a network interface + port, Start/Stop, open the GUI,
//! and live in the system tray.

mod config;
mod serve;

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, State, WindowEvent};

/// Runtime state: the supervised child process, or the in-process static
/// server, if running. A launcher has one or the other, never both — which
/// the config decides, not the panel.
#[derive(Default)]
struct AppState {
    child: Mutex<Option<Supervised>>,
    server: Mutex<Option<serve::StaticServer>>,
    /// Why the last Start failed, or why the server last stopped by itself.
    /// Held here rather than flashed by the panel because the panel re-renders
    /// from `get_status` every two seconds, and anything it only flashed was
    /// gone on the next poll — which is how a port clash used to look like
    /// nothing happening at all. Cleared by the next Start, Stop or settings
    /// change.
    failure: Mutex<Option<Failure>>,
}

impl AppState {
    /// Kill the child or stop the server, whichever is running.
    fn shutdown(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut sup) = guard.take() {
                let _ = sup.child.kill();
                let _ = sup.child.wait();
            }
        }
        if let Ok(mut guard) = self.server.lock() {
            if let Some(server) = guard.take() {
                server.stop();
            }
        }
    }

    /// Record why starting failed or the server stopped, for the panel — and
    /// for the log, which outlives the panel's next poll.
    fn fail(&self, failure: Failure) {
        if failure.detail.is_empty() {
            tracing::warn!("{}", failure.message);
        } else {
            tracing::warn!("{}\n{}", failure.message, failure.detail);
        }
        if let Ok(mut guard) = self.failure.lock() {
            *guard = Some(failure);
        }
    }

    fn clear_failure(&self) {
        if let Ok(mut guard) = self.failure.lock() {
            *guard = None;
        }
    }

    fn failure(&self) -> Option<Failure> {
        self.failure.lock().ok().and_then(|g| g.clone())
    }
}

/// A supervised child and the tail of what it has written, kept together so
/// that whoever notices the child has died can say what it said last.
struct Supervised {
    child: Child,
    output: OutputTail,
}

/// What went wrong, in words for the operator. Serialised into `Status` so
/// the panel shows it for as long as it holds.
#[derive(Debug, Clone, Serialize, PartialEq)]
struct Failure {
    /// One or two sentences: what happened and what to do about it.
    message: String,
    /// The server's last output lines, when it wrote any before dying.
    /// Empty otherwise; the panel hides the block.
    detail: String,
    /// The chosen port is held by something else. The panel offers Open
    /// anyway, since what is listening there may well be this very app,
    /// started some other way.
    port_busy: bool,
}

impl Failure {
    fn plain(message: impl Into<String>) -> Failure {
        Failure {
            message: message.into(),
            detail: String::new(),
            port_busy: false,
        }
    }
}

/// How many lines of the child's output to keep, and how long each may be.
/// Enough to hold a stack trace's useful end; small enough to fit the panel.
const TAIL_LINES: usize = 30;
const TAIL_LINE_CHARS: usize = 400;

/// The last few lines the supervised server wrote to stdout or stderr.
///
/// A tray app has nowhere else for the child's output to go: inherited, as it
/// used to be, an app launched from the Finder or the Start menu sends it to
/// the void, so a server that died of "address already in use" died in
/// silence. Both pipes are drained continuously on their own threads — a
/// pipe nobody reads fills at 64 KiB and then blocks the child on its next
/// write, which would hang a chatty server for a reason nothing could show.
#[derive(Clone, Default)]
struct OutputTail(Arc<TailInner>);

#[derive(Default)]
struct TailInner {
    lines: Mutex<VecDeque<String>>,
    /// Pipes still being read, and a wake-up for whoever waits on them
    /// reaching EOF (see [`OutputTail::wait_eof`]).
    open: Mutex<usize>,
    closed: std::sync::Condvar,
}

impl OutputTail {
    /// Read `reader` to EOF on a thread of its own, keeping the tail.
    fn pump<R: Read + Send + 'static>(&self, reader: R) {
        if let Ok(mut open) = self.0.open.lock() {
            *open += 1;
        }
        let tail = self.clone();
        let spawned = thread::Builder::new()
            .name("av-launcher-child-output".into())
            .spawn(move || {
                let mut reader = BufReader::new(reader);
                let mut line = Vec::new();
                loop {
                    line.clear();
                    match reader.read_until(b'\n', &mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => tail.push(&line),
                    }
                }
                tail.closed_one();
            });
        if spawned.is_err() {
            // The pipe now goes unread. Nothing to do about it here; a
            // machine that cannot spawn a thread has bigger problems.
            eprintln!("av-launcher: could not start the output reader thread");
            self.closed_one();
        }
    }

    fn closed_one(&self) {
        if let Ok(mut open) = self.0.open.lock() {
            *open = open.saturating_sub(1);
        }
        self.0.closed.notify_all();
    }

    /// Wait for every pipe to reach EOF, or for `timeout`. A child's death
    /// closes its ends of the pipes and the readers finish at once — unless a
    /// grandchild inherited them and lives on, which is what the timeout is
    /// for. Called before quoting a dead server, so its last line is in.
    fn wait_eof(&self, timeout: Duration) {
        let Ok(open) = self.0.open.lock() else {
            return;
        };
        let _ = self
            .0
            .closed
            .wait_timeout_while(open, timeout, |open| *open > 0);
    }

    fn push(&self, raw: &[u8]) {
        let line = strip_ansi(&String::from_utf8_lossy(raw));
        let line = line.trim_end_matches(['\r', '\n']);
        if line.trim().is_empty() {
            return;
        }
        let mut line: String = line.chars().take(TAIL_LINE_CHARS).collect();
        if line.chars().count() == TAIL_LINE_CHARS {
            line.push('…');
        }
        if let Ok(mut lines) = self.0.lines.lock() {
            if lines.len() == TAIL_LINES {
                lines.pop_front();
            }
            lines.push_back(line);
        }
    }

    /// The kept lines, newline-joined.
    fn text(&self) -> String {
        self.0
            .lines
            .lock()
            .map(|lines| lines.iter().cloned().collect::<Vec<_>>().join("\n"))
            .unwrap_or_default()
    }
}

/// Remove ANSI escape sequences. Servers that colour their logs mostly check
/// for a terminal first, but `tracing-subscriber`'s default does not, and a
/// panel line reading `[2m2026-09-17T…[0m` helps nobody.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            // CSI: ESC [ <params> <final byte in 0x40..=0x7e>
            Some('[') => {
                chars.next();
                for c in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&c) {
                        break;
                    }
                }
            }
            // ESC + one other byte (e.g. `ESC c` reset): drop both.
            Some(_) => {
                chars.next();
            }
            None => {}
        }
    }
    out
}

/// Try to bind the address the server is about to bind, and turn a refusal
/// into words an operator can act on, before anything is spawned.
///
/// The probe mirrors what the server itself will do — the standard library
/// sets `SO_REUSEADDR` on Unix, as Node, Go, Python and every Rust server
/// do — so an address it can bind, they can, and one that refuses it will
/// refuse them. (On macOS that lets a wildcard bind sit beside a loopback
/// listener on the same port; the server's will too, and its URL still
/// reaches it.) It is a preview, not a reservation: the socket is closed at
/// once, and the outcome is confirmed by watching the server after it
/// starts.
fn probe_bind(app_name: &str, bind_host: &str, interface: &str, port: u16) -> Result<(), Failure> {
    let addr: SocketAddr = format!("{bind_host}:{port}")
        .parse()
        .map_err(|e| Failure::plain(format!("Bad address {bind_host}:{port}: {e}")))?;
    match TcpListener::bind(addr) {
        Ok(_probe) => Ok(()),
        Err(e) => Err(bind_failure(app_name, bind_host, interface, port, &e)),
    }
}

/// Words for a bind refusal, by what the OS said rather than by guesswork:
/// which port needs administrator rights is an OS policy (macOS stopped
/// reserving the low ones in 10.14; Windows reserves ranges of its own and
/// answers `EACCES` for a port another program holds exclusively).
fn bind_failure(
    app_name: &str,
    bind_host: &str,
    interface: &str,
    port: u16,
    e: &std::io::Error,
) -> Failure {
    use std::io::ErrorKind;
    let where_ = if bind_host == "0.0.0.0" {
        format!("Port {port}")
    } else {
        format!("Port {port} on {bind_host}")
    };
    match e.kind() {
        ErrorKind::AddrInUse => Failure {
            message: format!(
                "{where_} is already in use: another program is listening on it — \
                 perhaps {app_name} is already running. Stop that, or choose a different port."
            ),
            detail: String::new(),
            port_busy: true,
        },
        ErrorKind::PermissionDenied => Failure::plain(format!(
            "This computer refuses {where_}: it is reserved by the system or needs \
             administrator rights. Choose a different port, above 1023."
        )),
        ErrorKind::AddrNotAvailable => Failure::plain(format!(
            "{bind_host} ({interface}) is not an address of this computer right now — \
             the interface may be down. Choose another interface."
        )),
        _ => Failure::plain(format!("{where_} could not be opened: {e}")),
    }
}

/// What the server did in its first moments after being spawned.
#[derive(Debug, PartialEq)]
enum Startup {
    /// It exited: the bind failed, the runtime is missing, Gatekeeper killed
    /// it. The status says which.
    Exited(ExitStatus),
    /// It is accepting connections on its port.
    Listening,
    /// Neither yet, after the grace period. It is running as far as anyone
    /// can tell; the status poll keeps watching.
    StillStarting,
}

/// How long to watch a freshly spawned server before calling it started.
/// Long enough for a Node runtime to load a bundle and reach its `listen`;
/// short enough that Start still feels immediate when nothing answers.
const STARTUP_GRACE: Duration = Duration::from_millis(1500);

/// Watch a freshly spawned server until it exits, answers on its port, or
/// the grace period is up.
///
/// A server that cannot bind its port exits within milliseconds, which the
/// old code never saw: it reported Running the instant the spawn succeeded,
/// and the next status poll quietly said Stopped. Waiting here turns that
/// into an answer on the click that caused it.
///
/// Readiness is only checked through loopback. Connecting to one of this
/// machine's own LAN addresses is an outgoing connection to a local-network
/// address as macOS's local network privacy defines it (TN3179), so a server
/// bound to a specific interface is watched for exit only and gets the full
/// grace period.
fn watch_startup(child: &mut Child, bind_host: &str, port: u16) -> Startup {
    const STEP: Duration = Duration::from_millis(40);
    let probe: Option<SocketAddr> = match bind_host {
        "0.0.0.0" | "127.0.0.1" => Some(SocketAddr::from(([127, 0, 0, 1], port))),
        _ => None,
    };
    let deadline = Instant::now() + STARTUP_GRACE;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Startup::Exited(status);
        }
        if let Some(addr) = probe {
            if TcpStream::connect_timeout(&addr, STEP).is_ok() {
                return Startup::Listening;
            }
        }
        if Instant::now() >= deadline {
            return Startup::StillStarting;
        }
        thread::sleep(STEP);
    }
}

/// Words for a server that has exited, with whatever it said last.
/// `at_start` distinguishes "died on the click" from "died later".
fn exit_failure(
    app_name: &str,
    status: ExitStatus,
    output: &OutputTail,
    at_start: bool,
) -> Failure {
    let how = describe_exit(status);
    let when = if at_start {
        "exited right after starting"
    } else {
        "stopped on its own"
    };
    let detail = output.text();
    let said = if detail.is_empty() {
        "It printed nothing to say why."
    } else {
        "Its last output is below."
    };
    Failure {
        message: format!("The {app_name} server {when} ({how}). {said}"),
        detail,
        port_busy: false,
    }
}

/// `exit code 1`, or the signal that killed it — naming the one case an
/// operator cannot reason out: on macOS, SIGKILL with no output is what
/// Gatekeeper does to an unsigned binary bundled inside an app (README §5).
fn describe_exit(status: ExitStatus) -> String {
    if let Some(code) = status.code() {
        return format!("exit code {code}");
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            return if sig == 9 && cfg!(target_os = "macos") {
                "killed by signal 9 — on macOS, typically Gatekeeper refusing an unsigned bundled binary".into()
            } else {
                format!("killed by signal {sig}")
            };
        }
    }
    format!("{status}")
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
    /// Why it is not running when it should be — see [`AppState::failure`].
    /// `None` while nothing is wrong.
    failure: Option<Failure>,
}

/// Where the operator's port/interface choice is remembered, in the OS
/// app-config directory.
fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, String> {
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
fn load_settings<R: Runtime>(app: &AppHandle<R>, default_port: u16) -> Settings {
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
fn store_settings<R: Runtime>(app: &AppHandle<R>, s: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    let raw = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| format!("writing settings: {e}"))
}

#[tauri::command]
/// Static description of the supervised app, for the panel header: name,
/// default port, URL template and theme. Read from the launcher config, so it
/// changes only when the config does.
fn get_app_info<R: Runtime>(app: AppHandle<R>) -> Result<AppInfo, String> {
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
fn get_settings<R: Runtime>(app: AppHandle<R>) -> Result<Settings, String> {
    let cfg = config::load()?;
    Ok(load_settings(&app, cfg.app.default_port))
}

#[tauri::command]
/// Remember a port/interface/field choice. Takes effect on the next
/// start_server(); a running server is not restarted. A failure on show
/// was about the old choice, so it is cleared.
fn save_settings<R: Runtime>(
    app: AppHandle<R>,
    state: State<AppState>,
    port: u16,
    interface: String,
    fields: std::collections::BTreeMap<String, String>,
) -> Result<(), String> {
    state.clear_failure();
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
/// preview the URL before starting). `failure` is whatever the state holds,
/// passed in so a caller without state (open_gui) can say `None`.
fn status_from<R: Runtime>(
    app: &AppHandle<R>,
    running: bool,
    message: String,
    failure: Option<Failure>,
) -> Result<Status, String> {
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
        failure,
    })
}

/// The status the panel renders after a start attempt or a poll: Running or
/// Stopped, plus whatever failure the state holds.
fn current_status<R: Runtime>(
    app: &AppHandle<R>,
    state: &AppState,
    running: bool,
) -> Result<Status, String> {
    let msg = if running { "Running" } else { "Stopped" };
    status_from(app, running, msg.into(), state.failure())
}

#[tauri::command]
/// Current launcher state, as the single object the panel re-renders from.
///
/// REAPS THE CHILD: it calls `try_wait()`, so a server that exited on its own is
/// noticed here rather than leaving the panel claiming it's running. That makes
/// this a side-effecting getter — the panel polls it, and removing the reap
/// would make the UI lie. A child found dead is reported, with its exit
/// status and last output, as the failure the panel then shows.
fn get_status<R: Runtime>(app: AppHandle<R>, state: State<AppState>) -> Result<Status, String> {
    let app_name = config::load().map(|c| c.app.name).unwrap_or_default();

    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    let child_running = match guard.as_mut() {
        Some(sup) => match sup.child.try_wait() {
            Ok(Some(exited)) => {
                // Process ended on its own. Say so, and say what it said.
                sup.output.wait_eof(Duration::from_millis(300));
                state.fail(exit_failure(&app_name, exited, &sup.output, false));
                *guard = None;
                false
            }
            Ok(None) => true,
            Err(e) => {
                // Cannot even ask. Let it go rather than keep a child the
                // next Start would spawn a twin beside.
                let _ = sup.child.kill();
                state.fail(Failure::plain(format!(
                    "Lost track of the {app_name} server: {e}"
                )));
                *guard = None;
                false
            }
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
            state.fail(Failure::plain(
                "The built-in web server stopped on its own. Start it again; if it keeps \
                 stopping, collect diagnostics.",
            ));
            *guard = None;
            false
        }
        None => false,
    };
    drop(guard);

    current_status(&app, &state, child_running || server_running)
}

/// Start the in-process static server described by `[serve]`.
fn start_static<R: Runtime>(
    app: &AppHandle<R>,
    state: &State<AppState>,
    cfg: &config::LauncherConfig,
    spec: &config::ServeSpec,
) -> Result<Status, String> {
    {
        let guard = state.server.lock().map_err(|e| e.to_string())?;
        if guard.as_ref().is_some_and(|s| s.is_running()) {
            drop(guard);
            return current_status(app, state, true);
        }
    }

    let s = load_settings(app, cfg.app.default_port);
    let (bind_host, _display) = config::resolve_hosts(&s.interface);
    if let Err(f) = probe_bind(&cfg.app.name, &bind_host, &s.interface, s.port) {
        state.fail(f);
        return current_status(app, state, false);
    }
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
    let server = match serve::StaticServer::start(site, &bind_host, s.port) {
        Ok(server) => server,
        Err(e) => {
            // The probe passed a moment ago, so this is a race or something
            // other than the port; the raw reason is the best there is.
            state.fail(Failure::plain(e));
            return current_status(app, state, false);
        }
    };
    *state.server.lock().map_err(|e| e.to_string())? = Some(server);

    current_status(app, state, true)
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
///
/// A start that fails is not an `Err`: it comes back as a Stopped status
/// carrying the failure, which the panel shows until the next attempt. `Err`
/// is kept for the launcher's own trouble — an unreadable config, a poisoned
/// lock.
fn start_server<R: Runtime>(app: AppHandle<R>, state: State<AppState>) -> Result<Status, String> {
    let cfg = config::load()?;
    state.clear_failure();

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
        if let Some(sup) = guard.as_mut() {
            if matches!(sup.child.try_wait(), Ok(None)) {
                drop(guard);
                return current_status(&app, &state, true);
            }
        }
    }

    let s = load_settings(&app, cfg.app.default_port);
    let (bind_host, _display) = config::resolve_hosts(&s.interface);
    let fields = effective_fields(&cfg, &s);

    // Ask the OS about the port before spawning anything: a clash answered
    // here is one sentence on the click, not a server that dies unseen.
    if let Err(f) = probe_bind(&cfg.app.name, &bind_host, &s.interface, s.port) {
        state.fail(f);
        return current_status(&app, &state, false);
    }

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
    // Both streams are captured so a server that dies can be quoted. They are
    // drained continuously (see OutputTail) — never pipe a child's output
    // without reading it.
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    // A GUI process spawning a console child pops a console window on Windows.
    // The server's output goes to the tail above, not a console, so the window
    // would be pure noise sitting on top of the panel.
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

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            state.fail(Failure::plain(format!(
                "Could not start the {} server ({}): {e}",
                cfg.app.name, launch.program
            )));
            return current_status(&app, &state, false);
        }
    };
    let output = OutputTail::default();
    if let Some(out) = child.stdout.take() {
        output.pump(out);
    }
    if let Some(err) = child.stderr.take() {
        output.pump(err);
    }

    if let Startup::Exited(status) = watch_startup(&mut child, &bind_host, s.port) {
        // The exit is seen through wait(), the output through pipes, and the
        // pipes can trail by a scheduling quantum: let the readers finish.
        output.wait_eof(Duration::from_millis(300));
        state.fail(exit_failure(&cfg.app.name, status, &output, true));
        return current_status(&app, &state, false);
    }
    *state.child.lock().map_err(|e| e.to_string())? = Some(Supervised { child, output });

    current_status(&app, &state, true)
}

#[tauri::command]
/// Kill the supervised server, or stop the in-process one. There is no
/// graceful-shutdown signal for a child, so a server that writes state on
/// exit gets no chance to.
fn stop_server<R: Runtime>(app: AppHandle<R>, state: State<AppState>) -> Result<Status, String> {
    state.shutdown();
    state.clear_failure();
    current_status(&app, &state, false)
}

#[tauri::command]
/// Open the server's web UI in the default browser, resolving the URL fresh
/// rather than reusing whatever the panel last rendered.
fn open_gui<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let status = status_from(&app, false, String::new(), None)?;
    tauri_plugin_opener::open_url(status.url, None::<&str>)
        .map_err(|e| format!("opening browser: {e}"))
}

#[tauri::command]
/// Kill the server and exit. Distinct from hide_window(), which leaves it
/// running in the tray — the difference an operator most often gets wrong.
fn quit_app<R: Runtime>(app: AppHandle<R>, state: State<AppState>) {
    state.shutdown();
    app.exit(0);
}

#[tauri::command]
/// Resize the panel to `height` logical pixels, keeping its width. The window
/// is fixed-size as far as the operator is concerned; the panel itself grows
/// to show a failure's output and shrinks back when it clears (main.js
/// `fitWindow`), rather than scrolling inside a window that hides half of
/// what it has to say.
fn fit_panel<R: Runtime>(app: AppHandle<R>, height: f64) -> Result<(), String> {
    let Some(w) = app.get_webview_window("main") else {
        return Ok(());
    };
    let scale = w.scale_factor().map_err(|e| e.to_string())?;
    let size = w
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let height = height.clamp(200.0, 1000.0);
    if (size.height - height).abs() < 1.0 {
        return Ok(());
    }
    // Keep the top-left where it is: on macOS a content-size change holds the
    // bottom-left corner, so the window would grow upward instead.
    let pos = w.outer_position().map_err(|e| e.to_string())?;
    w.set_size(tauri::LogicalSize::new(size.width, height))
        .map_err(|e| e.to_string())?;
    w.set_position(pos).map_err(|e| e.to_string())
}

#[tauri::command]
/// Hide the panel back to the tray. THE SERVER KEEPS RUNNING.
fn hide_window<R: Runtime>(app: AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

fn show_main<R: Runtime>(app: &AppHandle<R>) {
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
fn pin_config_path<R: Runtime>(app: &AppHandle<R>) {
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
            fit_panel,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A listener on an ephemeral loopback port, for the probe to trip over.
    fn occupied_port() -> (TcpListener, u16) {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        (l, port)
    }

    #[test]
    fn probe_passes_on_a_free_port() {
        // Port 0: always free, and no other test can take it in between —
        // an ephemeral port released here is exactly what the next bind(0)
        // in a parallel test gets handed.
        assert_eq!(probe_bind("App", "127.0.0.1", "lo0", 0), Ok(()));
    }

    #[test]
    fn probe_names_the_port_and_the_likely_cause_when_it_is_held() {
        let (_l, port) = occupied_port();
        let f = probe_bind("openRCS", "127.0.0.1", "lo0", port).unwrap_err();
        assert!(f.port_busy, "{f:?}");
        assert!(
            f.message
                .starts_with(&format!("Port {port} on 127.0.0.1 is already in use")),
            "{}",
            f.message
        );
        assert!(
            f.message.contains("perhaps openRCS is already running"),
            "{}",
            f.message
        );
        assert!(f.detail.is_empty());
    }

    #[test]
    fn a_wildcard_bind_names_only_the_port() {
        let e = std::io::Error::from(std::io::ErrorKind::AddrInUse);
        let f = bind_failure("Flock", "0.0.0.0", "all", 8080, &e);
        assert!(
            f.message.starts_with("Port 8080 is already in use"),
            "{}",
            f.message
        );
        assert!(f.port_busy);
    }

    #[test]
    fn a_refused_port_is_not_reported_as_busy() {
        let e = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let f = bind_failure("Flock", "0.0.0.0", "all", 80, &e);
        assert!(!f.port_busy);
        assert!(f.message.contains("Port 80"), "{}", f.message);
        assert!(f.message.contains("administrator"), "{}", f.message);
    }

    #[test]
    fn a_vanished_address_blames_the_interface() {
        let e = std::io::Error::from(std::io::ErrorKind::AddrNotAvailable);
        let f = bind_failure("Flock", "192.168.1.5", "en0", 8080, &e);
        assert!(!f.port_busy);
        assert!(
            f.message.starts_with("192.168.1.5 (en0) is not an address"),
            "{}",
            f.message
        );
    }

    #[test]
    fn an_unexpected_bind_error_keeps_the_os_wording() {
        let e = std::io::Error::other("something odd");
        let f = bind_failure("Flock", "0.0.0.0", "all", 8080, &e);
        assert_eq!(f.message, "Port 8080 could not be opened: something odd");
    }

    #[test]
    fn tail_keeps_the_last_lines_and_strips_noise() {
        let tail = OutputTail::default();
        for i in 0..(TAIL_LINES + 5) {
            tail.push(format!("line {i}\n").as_bytes());
        }
        tail.push(b"\n"); // blank lines are not worth a slot
        tail.push(b"\x1b[2m2026-09-17T10:00:00Z\x1b[0m \x1b[31mERROR\x1b[0m bind failed\r\n");
        let text = tail.text();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), TAIL_LINES);
        assert_eq!(lines[0], "line 6"); // the first six fell off the front
        assert_eq!(
            *lines.last().unwrap(),
            "2026-09-17T10:00:00Z ERROR bind failed"
        );
    }

    #[test]
    fn tail_truncates_a_runaway_line() {
        let tail = OutputTail::default();
        tail.push("x".repeat(TAIL_LINE_CHARS * 2).as_bytes());
        let text = tail.text();
        assert_eq!(text.chars().count(), TAIL_LINE_CHARS + 1);
        assert!(text.ends_with('…'));
    }

    #[test]
    fn tail_tolerates_bytes_that_are_not_utf8() {
        let tail = OutputTail::default();
        tail.push(b"caf\xff\n");
        assert_eq!(tail.text(), "caf\u{FFFD}");
    }

    #[test]
    fn strip_ansi_leaves_plain_text_alone() {
        assert_eq!(strip_ansi("plain"), "plain");
        assert_eq!(strip_ansi("a\x1b[1;32mb\x1b[0mc"), "abc");
        assert_eq!(strip_ansi("trailing\x1b"), "trailing");
    }

    #[cfg(unix)]
    #[test]
    fn a_server_that_dies_at_once_is_quoted_with_its_exit_code() {
        let mut cmd = Command::new("sh");
        cmd.args([
            "-c",
            "echo starting; echo 'bind: address already in use' >&2; exit 3",
        ]);
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().unwrap();
        let output = OutputTail::default();
        output.pump(child.stdout.take().unwrap());
        output.pump(child.stderr.take().unwrap());

        let started = Instant::now();
        let outcome = watch_startup(&mut child, "0.0.0.0", 1);
        let Startup::Exited(status) = outcome else {
            panic!("expected an exit, got {outcome:?}");
        };
        assert!(
            started.elapsed() < STARTUP_GRACE,
            "the exit should end the watch early"
        );
        output.wait_eof(Duration::from_secs(2));

        let f = exit_failure("Flock", status, &output, true);
        assert_eq!(
            f.message,
            "The Flock server exited right after starting (exit code 3). Its last output is below."
        );
        assert!(f.detail.contains("starting"), "{}", f.detail);
        assert!(
            f.detail.contains("bind: address already in use"),
            "{}",
            f.detail
        );
        assert!(!f.port_busy);
    }

    #[cfg(unix)]
    #[test]
    fn a_server_that_listens_is_seen_listening() {
        // Any listener will do for the readiness probe: it only connects.
        let (_l, port) = occupied_port();
        let mut cmd = Command::new("sleep");
        cmd.arg("5");
        let mut child = cmd.spawn().unwrap();
        let started = Instant::now();
        assert_eq!(
            watch_startup(&mut child, "127.0.0.1", port),
            Startup::Listening
        );
        assert!(started.elapsed() < STARTUP_GRACE);
        let _ = child.kill();
        let _ = child.wait();
    }

    #[cfg(unix)]
    #[test]
    fn a_server_bound_elsewhere_is_given_the_grace_period() {
        // No loopback probe for a LAN address, so the watch runs out the
        // clock and calls it started.
        let mut cmd = Command::new("sleep");
        cmd.arg("5");
        let mut child = cmd.spawn().unwrap();
        let started = Instant::now();
        assert_eq!(
            watch_startup(&mut child, "192.0.2.1", 1),
            Startup::StillStarting
        );
        assert!(started.elapsed() >= STARTUP_GRACE);
        let _ = child.kill();
        let _ = child.wait();
    }

    #[cfg(unix)]
    #[test]
    fn a_server_that_died_later_says_so_and_prints_nothing_if_it_said_nothing() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "kill -9 $$"]);
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().unwrap();
        let output = OutputTail::default();
        output.pump(child.stdout.take().unwrap());
        output.pump(child.stderr.take().unwrap());
        let status = child.wait().unwrap();
        output.wait_eof(Duration::from_secs(2));
        let f = exit_failure("Flock", status, &output, false);
        assert!(
            f.message
                .starts_with("The Flock server stopped on its own (killed by signal 9"),
            "{}",
            f.message
        );
        assert!(
            f.message.ends_with("It printed nothing to say why."),
            "{}",
            f.message
        );
        assert!(f.detail.is_empty());
    }

    /// The commands themselves, run against Tauri's mock runtime with a real
    /// config, real settings and a real (fake) server process — the layer
    /// between the panel and the process, which nothing exercised before.
    #[cfg(unix)]
    mod commands {
        use super::super::*;
        use std::path::PathBuf;
        use std::sync::MutexGuard;

        /// The config path is an environment variable and the settings file
        /// is one directory, so these tests take turns.
        static TURN: Mutex<()> = Mutex::new(());

        /// A stand-in server: `$3` picks what it does.
        ///   die    print an error (with ANSI colour) and exit 1, like a bind failure
        ///   linger live without listening, until killed
        ///   serve  listen for real, with python's http.server
        const FAKE_SERVER: &str = "#!/bin/sh
case \"$3\" in
  die)
    echo \"probe starting on $1:$2\"
    printf '\\033[2m2026-09-17T20:00:00Z\\033[0m \\033[31mERROR\\033[0m could not bind %s:%s: Address already in use (os error 48)\\n' \"$1\" \"$2\" >&2
    exit 1
    ;;
  linger)
    exec sleep 30
    ;;
  serve)
    exec python3 -m http.server \"$2\" --bind \"$1\"
    ;;
esac
";

        /// A launcher config, a settings directory of its own, and the lock.
        struct Bench {
            _turn: MutexGuard<'static, ()>,
            dir: PathBuf,
            app: tauri::App<tauri::test::MockRuntime>,
        }

        impl Bench {
            fn new(name: &str, mode: &str) -> Bench {
                let turn = TURN.lock().unwrap_or_else(|e| e.into_inner());
                let dir = std::env::temp_dir()
                    .join(format!("av-launcher-cmd-{name}-{}", std::process::id()));
                let _ = std::fs::remove_dir_all(&dir);
                std::fs::create_dir_all(&dir).unwrap();

                let server = dir.join("fake-server.sh");
                std::fs::write(&server, FAKE_SERVER).unwrap();
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&server, std::fs::Permissions::from_mode(0o755))
                        .unwrap();
                }
                let config = dir.join("launcher.toml");
                std::fs::write(
                    &config,
                    format!(
                        "[app]\nname = \"Probe\"\ncommand = '{}'\nargs = [\"{{host}}\", \"{{port}}\", \"{mode}\"]\n\
                         url = \"http://{{host}}:{{port}}/\"\ndefault_port = 8765\n\n[inject]\nmode = \"args\"\n",
                        server.display()
                    ),
                )
                .unwrap();
                std::env::set_var("AV_LAUNCHER_CONFIG", &config);

                // The identifier decides where settings.json goes: somewhere
                // of our own, cleaned up on drop.
                let mut ctx = tauri::test::mock_context(tauri::test::noop_assets());
                ctx.config_mut().identifier = format!("com.allansargeant.av-launcher.test-{name}");
                let app = tauri::test::mock_builder()
                    .manage(AppState::default())
                    .build(ctx)
                    .unwrap();
                Bench {
                    _turn: turn,
                    dir,
                    app,
                }
            }

            fn handle(&self) -> AppHandle<tauri::test::MockRuntime> {
                self.app.handle().clone()
            }

            fn state(&self) -> State<'_, AppState> {
                self.app.state::<AppState>()
            }

            fn use_port(&self, port: u16) {
                save_settings(
                    self.handle(),
                    self.state(),
                    port,
                    "all".into(),
                    Default::default(),
                )
                .unwrap();
            }
        }

        impl Drop for Bench {
            fn drop(&mut self) {
                self.state().shutdown();
                std::env::remove_var("AV_LAUNCHER_CONFIG");
                let _ = std::fs::remove_dir_all(&self.dir);
                if let Ok(cfg) = self.app.path().app_config_dir() {
                    let _ = std::fs::remove_dir_all(cfg);
                }
            }
        }

        /// A port nothing is using, outside the ephemeral range so that no
        /// parallel test's bind(0) is handed the same one a moment later.
        fn free_port() -> u16 {
            for port in (20000..30000).step_by(7) {
                if TcpListener::bind(("0.0.0.0", port)).is_ok() {
                    return port;
                }
            }
            panic!("no free port between 20000 and 30000");
        }

        fn have_python() -> bool {
            Command::new("python3")
                .arg("--version")
                .output()
                .is_ok_and(|o| o.status.success())
        }

        #[test]
        fn a_held_port_is_reported_on_the_click_and_nothing_is_spawned() {
            let bench = Bench::new("busy", "serve");
            let holder = TcpListener::bind(("0.0.0.0", 0)).unwrap();
            let port = holder.local_addr().unwrap().port();
            bench.use_port(port);

            let status = start_server(bench.handle(), bench.state()).unwrap();
            assert!(!status.running);
            let f = status.failure.expect("a failure");
            assert!(f.port_busy);
            assert_eq!(
                f.message,
                format!(
                    "Port {port} is already in use: another program is listening on it — \
                     perhaps Probe is already running. Stop that, or choose a different port."
                )
            );
            assert!(bench.state().child.lock().unwrap().is_none());
            assert_eq!(status.port, port);

            // The poll keeps saying so…
            let polled = get_status(bench.handle(), bench.state()).unwrap();
            assert_eq!(polled.failure, Some(f));
            // …until the operator changes something.
            bench.use_port(port);
            assert_eq!(
                get_status(bench.handle(), bench.state()).unwrap().failure,
                None
            );
        }

        #[test]
        fn a_server_that_dies_on_start_is_quoted_with_its_last_lines() {
            let bench = Bench::new("die", "die");
            let port = free_port();
            bench.use_port(port);

            let status = start_server(bench.handle(), bench.state()).unwrap();
            assert!(!status.running);
            let f = status.failure.expect("a failure");
            assert_eq!(
                f.message,
                "The Probe server exited right after starting (exit code 1). Its last output is below."
            );
            assert!(!f.port_busy);
            // stdout and stderr are two pipes on two threads, so two lines
            // written a microsecond apart may be kept in either order.
            let mut lines: Vec<&str> = f.detail.lines().collect();
            lines.sort_unstable();
            assert_eq!(
                lines,
                vec![
                    format!("2026-09-17T20:00:00Z ERROR could not bind 0.0.0.0:{port}: Address already in use (os error 48)"),
                    format!("probe starting on 0.0.0.0:{port}"),
                ]
            );
            assert!(bench.state().child.lock().unwrap().is_none());
        }

        #[test]
        fn a_server_that_dies_later_is_reported_by_the_poll_until_stop() {
            let bench = Bench::new("linger", "linger");
            let port = free_port();
            bench.use_port(port);

            // Alive but not listening: the watch runs out the grace period
            // and calls it running, as the old code always did.
            let status = start_server(bench.handle(), bench.state()).unwrap();
            assert!(status.running, "{:?}", status.failure);
            assert_eq!(status.failure, None);

            let pid = bench
                .state()
                .child
                .lock()
                .unwrap()
                .as_ref()
                .map(|s| s.child.id())
                .expect("a supervised child");
            let killed = Command::new("kill")
                .args(["-9", &pid.to_string()])
                .status()
                .unwrap();
            assert!(killed.success());
            thread::sleep(Duration::from_millis(100));

            let polled = get_status(bench.handle(), bench.state()).unwrap();
            assert!(!polled.running);
            let f = polled.failure.expect("the poll reports the death");
            assert!(
                f.message
                    .starts_with("The Probe server stopped on its own (killed by signal 9"),
                "{}",
                f.message
            );
            assert!(
                f.message.ends_with("It printed nothing to say why."),
                "{}",
                f.message
            );
            assert!(bench.state().child.lock().unwrap().is_none());

            // Stop is the operator acknowledging it.
            let stopped = stop_server(bench.handle(), bench.state()).unwrap();
            assert!(!stopped.running);
            assert_eq!(stopped.failure, None);
        }

        #[test]
        fn a_server_that_listens_is_running_and_stop_frees_its_port() {
            if !have_python() {
                eprintln!("python3 not found; skipping");
                return;
            }
            let bench = Bench::new("serve", "serve");
            let port = free_port();
            bench.use_port(port);

            let started = Instant::now();
            let status = start_server(bench.handle(), bench.state()).unwrap();
            assert!(status.running, "{:?}", status.failure);
            assert_eq!(status.failure, None);
            assert!(
                started.elapsed() < STARTUP_GRACE + Duration::from_secs(3),
                "took {:?}",
                started.elapsed()
            );
            assert!(
                TcpStream::connect(("127.0.0.1", port)).is_ok(),
                "nothing answers"
            );

            let stopped = stop_server(bench.handle(), bench.state()).unwrap();
            assert!(!stopped.running);
            assert!(
                TcpListener::bind(("0.0.0.0", port)).is_ok(),
                "port still held"
            );
        }
    }
}
