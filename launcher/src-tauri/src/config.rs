//! Reusable, app-agnostic launcher configuration.
//!
//! The launcher itself knows nothing about any particular server. Each app it
//! supervises is described by a small `launcher.toml`, which says how to start
//! the server binary and — crucially — *how to inject the chosen host:port*.
//! Three injection modes cover the whole fleet:
//!
//! * `configfile` — patch a key in the app's own TOML config (srt-router's
//!   `[web] bind`), then pass that rendered file via `--config`.
//! * `env` — set environment variables (RFutils' `RFUTILS_SERVER_PORT`).
//! * `args` — the `{host}`/`{port}` placeholders are already in `[app].args`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Top-level `launcher.toml` schema.
#[derive(Debug, Clone, Deserialize)]
pub struct LauncherConfig {
    pub app: AppSpec,
    /// How the chosen host:port reaches a supervised child. Optional since the
    /// `[serve]` mode arrived — a static site has no child to inject into.
    /// Every shipped child-process config spells it out.
    #[serde(default)]
    pub inject: InjectSpec,
    /// Serve a directory from inside this process instead of supervising a
    /// child. When present, `[app].command` and `[inject]` are not used.
    #[serde(default)]
    pub serve: Option<ServeSpec>,
    /// Optional extra inputs the panel collects (e.g. a device IP, a model
    /// selector). Each becomes a `{key}` placeholder usable anywhere `{host}`
    /// is — args, env values, config-file values. `[[field]]` in TOML.
    #[serde(default)]
    pub field: Vec<FieldSpec>,
}

/// `[serve]` — a static site served in-process. The fleet's browser tools are
/// static pages, and a tray app for one has nothing to spawn: bundling a
/// static-server binary beside the site would be the unsigned-helper shape
/// that macOS quarantines and kills silently (AGENTS §5). So the launcher
/// serves the directory itself, on the interface and port from the panel.
#[derive(Debug, Clone, Deserialize)]
pub struct ServeSpec {
    /// Only `static` today.
    pub mode: String,
    /// The directory to serve. `{resource}` resolves to the bundle's resource
    /// dir, and a relative path is taken against it, so a shipped config says
    /// `{resource}/site` and a dev config an absolute `dist/`.
    pub dir: String,
    /// A Cloudflare `_headers` file to honour, so the offline copy sends the
    /// same CSP and cache headers as the hosted one. Defaults to `_headers`
    /// inside `dir` when that exists; the file itself is never served.
    #[serde(default)]
    pub headers: Option<String>,
    /// The file a directory request serves.
    #[serde(default = "default_index")]
    pub index: String,
    /// `none` for a plain 404, `spa` to serve the index for any unknown path —
    /// the same two answers as the fleet's `not_found_handling`.
    #[serde(default = "default_not_found")]
    pub not_found: String,
}

fn default_index() -> String {
    "index.html".into()
}
fn default_not_found() -> String {
    "none".into()
}

/// Everything the static server needs, resolved from a [`ServeSpec`]: the
/// directory and the headers file as native paths under the resource dir.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServePaths {
    pub dir: PathBuf,
    pub headers: Option<PathBuf>,
}

/// Resolve a `[serve]` block's paths against the bundle's resource dir.
pub fn resolve_serve(spec: &ServeSpec, resource_dir: Option<&Path>) -> Result<ServePaths, String> {
    if spec.mode != "static" {
        return Err(format!(
            "unknown serve.mode: {} (only \"static\" exists)",
            spec.mode
        ));
    }
    let res_str = resource_dir.map(|p| native_path(&p.to_string_lossy()));
    let res = res_str.as_deref();
    let empty = BTreeMap::new();
    let dir = PathBuf::from(resolve_against(
        &subst(&spec.dir, "", 0, None, res, &empty),
        resource_dir,
    ));
    let headers = match &spec.headers {
        Some(h) => Some(PathBuf::from(resolve_against(
            &subst(h, "", 0, None, res, &empty),
            resource_dir,
        ))),
        None => {
            let inside = dir.join("_headers");
            inside.is_file().then_some(inside)
        }
    };
    Ok(ServePaths { dir, headers })
}

/// A custom input rendered in the panel above the interface/port controls.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FieldSpec {
    /// Placeholder name — `{key}` is substituted with the entered value.
    pub key: String,
    /// Label shown in the panel.
    pub label: String,
    /// `text` (free entry) or `select` (a fixed list of `options`).
    #[serde(rename = "type", default = "default_field_type")]
    pub kind: String,
    /// Greyed hint for a text field.
    #[serde(default)]
    pub placeholder: String,
    /// Pre-filled value when nothing is remembered.
    #[serde(default)]
    pub default: String,
    /// Choices for a `select` field. A bare string is both value and label;
    /// `{ value, label }` separates the two (e.g. value `livecore`, label
    /// `LiveCore`).
    #[serde(default)]
    pub options: Vec<FieldOption>,
}

/// A `select` option — either a plain string or a `{ value, label }` table.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum FieldOption {
    Simple(String),
    Labeled { value: String, label: String },
}

fn default_field_type() -> String {
    "text".into()
}

#[derive(Debug, Clone, Deserialize)]
pub struct AppSpec {
    /// Display name shown in the panel and tray.
    pub name: String,
    /// Absolute path to the server binary (or a command on PATH). Unused, and
    /// may be omitted, when `[serve]` is present.
    #[serde(default)]
    pub command: String,
    /// Arguments; supports `{host}`, `{port}` and `{config}` placeholders.
    #[serde(default)]
    pub args: Vec<String>,
    /// URL template shown to the user, e.g. `http://{host}:{port}/`.
    #[serde(default = "default_url")]
    pub url: String,
    /// Default port pre-filled in the UI.
    #[serde(default = "default_port")]
    pub default_port: u16,
    /// Working directory for the child (so relative paths in its config
    /// resolve). Optional; defaults to the binary's directory.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Optional palette (CSS custom-property name -> value) applied to the
    /// panel so each launcher matches its app's own web UI. Keys like
    /// `bg`, `panel`, `border`, `text`, `muted`, `accent`, `accent-soft`,
    /// `good`. Anything omitted falls back to the shell's built-in defaults.
    #[serde(default)]
    pub theme: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct InjectSpec {
    /// `configfile` | `env` | `args`.
    #[serde(default = "default_inject_mode")]
    pub mode: String,
    #[serde(default)]
    pub configfile: Option<ConfigFileInject>,
    /// For `env` mode: variable name -> value template (`{host}`/`{port}`).
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConfigFileInject {
    /// Path to the app's own config file, used as a template.
    pub template: String,
    /// Dotted key to overwrite, e.g. `web.bind`.
    pub set_key: String,
    /// Value template written at `set_key`. Defaults to `{host}:{port}`.
    #[serde(default = "default_bind_value")]
    pub value: String,
}

fn default_url() -> String {
    "http://{host}:{port}/".into()
}
fn default_inject_mode() -> String {
    "args".into()
}
impl Default for InjectSpec {
    fn default() -> Self {
        Self {
            mode: default_inject_mode(),
            configfile: None,
            env: BTreeMap::new(),
        }
    }
}
fn default_port() -> u16 {
    8080
}
fn default_bind_value() -> String {
    "{host}:{port}".into()
}

/// A network interface offered in the "GUI Interface" picker.
#[derive(Debug, Clone, Serialize)]
pub struct Interface {
    /// Interface name, e.g. `en0`, or `all` for the 0.0.0.0 pseudo-entry.
    pub name: String,
    /// IPv4 address to bind to (`0.0.0.0` for the "all" entry).
    pub ip: String,
    /// Human label, e.g. `en0: 10.147.17.93`.
    pub label: String,
    pub loopback: bool,
}

/// The concrete command to spawn, after host:port injection.
#[derive(Debug, Clone)]
pub struct Launch {
    pub program: String,
    pub args: Vec<String>,
    pub envs: Vec<(String, String)>,
    pub cwd: Option<PathBuf>,
}

/// Substitute `{host}`/`{port}` (plus `{config}`/`{resource}` when provided).
/// `{resource}` is the bundle's resource dir — lets a shipped config point at
/// bundled files (e.g. an embedded Node runtime + server) by absolute path.
fn subst(
    s: &str,
    host: &str,
    port: u16,
    config: Option<&str>,
    resource: Option<&str>,
    fields: &BTreeMap<String, String>,
) -> String {
    let mut out = s
        .replace("{host}", host)
        .replace("{port}", &port.to_string());
    if let Some(r) = resource {
        out = out.replace("{resource}", r);
    }
    if let Some(c) = config {
        out = out.replace("{config}", c);
    }
    for (k, v) in fields {
        out = out.replace(&format!("{{{k}}}"), v);
    }
    out
}

/// Locate `launcher.toml`: `$AV_LAUNCHER_CONFIG`, else `./launcher.toml`
/// (the working dir — `src-tauri` under `tauri dev`), else next to the exe.
pub fn find_config_path() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("AV_LAUNCHER_CONFIG") {
        return Ok(PathBuf::from(p));
    }
    if let Ok(cwd) = std::env::current_dir() {
        let p = cwd.join("launcher.toml");
        if p.exists() {
            return Ok(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let p = dir.join("launcher.toml");
            if p.exists() {
                return Ok(p);
            }
        }
    }
    Err(
        "launcher.toml not found (set AV_LAUNCHER_CONFIG or place it in the working directory)"
            .into(),
    )
}

/// Parse the launcher configuration.
pub fn load() -> Result<LauncherConfig, String> {
    let path = find_config_path()?;
    let raw =
        std::fs::read_to_string(&path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    toml::from_str::<LauncherConfig>(&raw).map_err(|e| format!("parsing {}: {e}", path.display()))
}

/// Enumerate bindable IPv4 interfaces, with an "All interfaces" entry first.
pub fn list_interfaces() -> Vec<Interface> {
    let mut out = vec![Interface {
        name: "all".into(),
        ip: "0.0.0.0".into(),
        label: "All interfaces (0.0.0.0)".into(),
        loopback: false,
    }];
    if let Ok(addrs) = if_addrs::get_if_addrs() {
        for a in addrs {
            // IPv4 only for now — matches how these servers advertise a URL.
            if let std::net::IpAddr::V4(v4) = a.ip() {
                out.push(Interface {
                    name: a.name.clone(),
                    ip: v4.to_string(),
                    label: format!("{}: {}", a.name, v4),
                    loopback: a.is_loopback(),
                });
            }
        }
    }
    out
}

/// The first non-loopback IPv4, used as the display host for "All interfaces".
pub fn primary_ip() -> String {
    list_interfaces()
        .into_iter()
        .find(|i| i.name != "all" && !i.loopback)
        .map(|i| i.ip)
        .unwrap_or_else(|| "127.0.0.1".into())
}

/// Resolve a chosen interface name into (bind_host, display_host).
/// `bind_host` is what the server binds; `display_host` is what the URL shows.
pub fn resolve_hosts(interface: &str) -> (String, String) {
    let ifaces = list_interfaces();
    match ifaces.iter().find(|i| i.name == interface) {
        Some(i) if i.name == "all" => ("0.0.0.0".into(), primary_ip()),
        Some(i) => (i.ip.clone(), i.ip.clone()),
        // Interface vanished (cable unplugged); fall back to all-interfaces.
        None => ("0.0.0.0".into(), primary_ip()),
    }
}

/// Set a dotted key (`web.bind`) in a TOML document, creating tables as needed.
fn set_dotted(doc: &mut toml_edit::DocumentMut, dotted: &str, val: &str) {
    let parts: Vec<&str> = dotted.split('.').collect();
    let mut node = doc.as_item_mut();
    for p in &parts[..parts.len().saturating_sub(1)] {
        node = &mut node[*p];
    }
    if let Some(last) = parts.last() {
        node[*last] = toml_edit::value(val);
    }
}

/// Rewrite a Windows path into the form Win32 actually resolves: no verbatim
/// prefix, backslash separators throughout.
///
/// Tauri's `resource_dir()` is `current_exe().canonicalize()`, and on Windows
/// `canonicalize` hands back a *verbatim* path (`\\?\C:\…`). Win32 performs no
/// normalisation inside a verbatim path, so the forward slashes a
/// `launcher.toml` writes (`{resource}/node`) stop being separators: the path
/// resolves to nothing, `exists()` is false for both `node` and `node.exe`, and
/// the spawn fails on the bare, slash-separated name the config asked for.
///
/// Dropping the prefix is safe here — these are ordinary drive paths well under
/// MAX_PATH. Verbatim *device* paths (`\\?\Volume{…}`) have no non-verbatim
/// spelling, so they are returned untouched.
fn simplify_windows_path(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{}", rest.replace('/', "\\"));
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        let bytes = rest.as_bytes();
        let is_drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
        if !is_drive {
            return path.to_string();
        }
        return rest.replace('/', "\\");
    }
    path.replace('/', "\\")
}

/// [`simplify_windows_path`] on Windows, identity elsewhere. `cfg!` rather than
/// `#[cfg]` so both arms keep compiling — and the tests keep running — on every
/// platform.
fn native_path(path: &str) -> String {
    if cfg!(windows) {
        simplify_windows_path(path)
    } else {
        path.to_string()
    }
}

/// Resolve a possibly-relative path against `base` (the bundle's resource dir),
/// and hand back a path spelled the way this platform resolves it. Absolute
/// paths keep their location, so dev configs with absolute paths and shipped
/// bundles with relative (bundled-resource) paths both work.
fn resolve_against(path: &str, base: Option<&Path>) -> String {
    let p = Path::new(path);
    if p.is_absolute() {
        return native_path(path);
    }
    match base {
        Some(dir) => native_path(&dir.join(p).to_string_lossy()),
        None => native_path(path),
    }
}

/// On Windows a bundled command ships with a `.exe` extension (e.g. `node.exe`),
/// but `launcher.toml` names it without one (`node`). If the extension-less
/// program isn't present and a `.exe` sibling is, prefer that so the spawn finds
/// the executable. Relies on the path already being native — see
/// [`simplify_windows_path`]. No-op on other platforms.
#[cfg(windows)]
fn with_windows_exe(program: String) -> String {
    let p = Path::new(&program);
    if p.extension().is_none() && !p.exists() {
        let exe = format!("{program}.exe");
        if Path::new(&exe).exists() {
            return exe;
        }
    }
    program
}

#[cfg(not(windows))]
fn with_windows_exe(program: String) -> String {
    program
}

/// Build the concrete [`Launch`] for the given host/port, performing whatever
/// injection the app's `launcher.toml` calls for.
///
/// * `work_dir` — writable dir for the rendered config and the default cwd
///   (the launcher's app-config directory).
/// * `resource_dir` — the bundle's resource dir; relative `command`/`template`
///   paths resolve against it, so a shipped `.app` can carry its server binary
///   and config template as bundled resources. `None` in dev (absolute paths).
pub fn build_launch(
    cfg: &LauncherConfig,
    bind_host: &str,
    port: u16,
    fields: &BTreeMap<String, String>,
    work_dir: &Path,
    resource_dir: Option<&Path>,
) -> Result<Launch, String> {
    let mut envs: Vec<(String, String)> = Vec::new();
    let mut rendered_config: Option<String> = None;
    let res_str = resource_dir.map(|p| native_path(&p.to_string_lossy()));
    let res = res_str.as_deref();

    match cfg.inject.mode.as_str() {
        "configfile" => {
            let ci = cfg
                .inject
                .configfile
                .as_ref()
                .ok_or("inject.mode = \"configfile\" but [inject.configfile] is missing")?;
            let template = resolve_against(&ci.template, resource_dir);
            let raw = std::fs::read_to_string(&template)
                .map_err(|e| format!("reading template {template}: {e}"))?;
            let mut doc = raw
                .parse::<toml_edit::DocumentMut>()
                .map_err(|e| format!("parsing template {template}: {e}"))?;
            let value = subst(&ci.value, bind_host, port, None, res, fields);
            set_dotted(&mut doc, &ci.set_key, &value);

            std::fs::create_dir_all(work_dir).map_err(|e| format!("creating work dir: {e}"))?;
            let out = work_dir.join("rendered-config.toml");
            std::fs::write(&out, doc.to_string())
                .map_err(|e| format!("writing rendered config: {e}"))?;
            rendered_config = Some(native_path(&out.to_string_lossy()));
        }
        "env" => {
            for (k, v) in &cfg.inject.env {
                envs.push((k.clone(), subst(v, bind_host, port, None, res, fields)));
            }
        }
        "args" => { /* host/port/fields already substituted into args below */ }
        other => return Err(format!("unknown inject.mode: {other}")),
    }

    // `{resource}` and `{config}` only ever stand in for filesystem paths, so
    // an arg built from one is respelled for the platform. Everything else —
    // URLs, flags, bare values — is passed through exactly as written.
    let args = cfg
        .app
        .args
        .iter()
        .map(|a| {
            let is_path = a.contains("{resource}") || a.contains("{config}");
            let out = subst(a, bind_host, port, rendered_config.as_deref(), res, fields);
            if is_path {
                native_path(&out)
            } else {
                out
            }
        })
        .collect();

    // Substitute {resource} in the command, then resolve any remaining relative
    // path against the resource dir (covers both `{resource}/node` and `bin/x`).
    let program = with_windows_exe(resolve_against(
        &subst(&cfg.app.command, bind_host, port, None, res, fields),
        resource_dir,
    ));

    // Prefer an explicit cwd; otherwise run from the writable work dir so a
    // bundled server can persist state (it can't write inside a read-only .app).
    let cwd = cfg
        .app
        .cwd
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| work_dir.to_path_buf());

    Ok(Launch {
        program,
        args,
        envs,
        cwd: Some(cwd),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(toml: &str) -> LauncherConfig {
        toml::from_str(toml).expect("valid launcher config")
    }

    /// A `[serve]` config needs no command and no `[inject]`, and its paths
    /// resolve against the resource dir the way a bundled command does.
    #[test]
    fn static_site_config_needs_no_child() {
        let cfg = parse(
            r#"
            [app]
            name = "Aspect Calc"
            default_port = 8520
            [serve]
            mode = "static"
            dir = "{resource}/site"
            not_found = "spa"
            "#,
        );
        assert!(cfg.app.command.is_empty());
        assert_eq!(cfg.inject.mode, "args");
        let spec = cfg.serve.as_ref().expect("[serve] parsed");
        assert_eq!(spec.index, "index.html");
        assert_eq!(spec.not_found, "spa");

        let tmp = std::env::temp_dir().join("av-launcher-test-serve");
        std::fs::create_dir_all(tmp.join("site")).unwrap();
        std::fs::write(tmp.join("site/_headers"), "/*\n  X-Test: 1\n").unwrap();
        let paths = resolve_serve(spec, Some(&tmp)).unwrap();
        assert_eq!(
            paths.dir,
            PathBuf::from(native_path(&tmp.join("site").to_string_lossy()))
        );
        // The headers file is found inside the directory when not named.
        assert_eq!(paths.headers, Some(paths.dir.join("_headers")));

        // A relative dir resolves against the resource dir too.
        let cfg = parse("[app]\nname = \"x\"\n[serve]\nmode = \"static\"\ndir = \"site\"\n");
        let paths = resolve_serve(cfg.serve.as_ref().unwrap(), Some(&tmp)).unwrap();
        assert!(paths.dir.ends_with("site"));

        // Any other mode is refused rather than served as something else.
        let cfg = parse("[app]\nname = \"x\"\n[serve]\nmode = \"proxy\"\ndir = \"site\"\n");
        assert!(resolve_serve(cfg.serve.as_ref().unwrap(), None).is_err());
    }

    /// flock: config-file injection into a TOP-LEVEL `bind` key, config passed
    /// as a positional arg. Regression guard for flock's shape vs srt-router's.
    #[test]
    fn flock_configfile_toplevel_bind() {
        let tmp = std::env::temp_dir().join("av-launcher-test-flock");
        std::fs::create_dir_all(&tmp).unwrap();
        let template = tmp.join("flock.example.toml");
        std::fs::write(
            &template,
            "bind = \"0.0.0.0:8080\"\nregistry_path = \"data/registry.json\"\n",
        )
        .unwrap();

        let cfg = parse(&format!(
            r#"
            [app]
            name = "flock"
            command = "/bin/flock"
            args = ["{{config}}"]
            [inject]
            mode = "configfile"
            [inject.configfile]
            template = '{}'
            set_key = "bind"
            value = "{{host}}:{{port}}"
            "#,
            template.display()
        ));

        let launch = build_launch(
            &cfg,
            "10.0.0.5",
            9000,
            &std::collections::BTreeMap::new(),
            &tmp,
            None,
        )
        .unwrap();
        // The single positional arg is the rendered config path.
        assert_eq!(launch.args.len(), 1);
        let rendered = std::fs::read_to_string(&launch.args[0]).unwrap();
        assert!(
            rendered.contains("bind = \"10.0.0.5:9000\""),
            "top-level bind not patched: {rendered}"
        );
        // Untouched keys are preserved.
        assert!(rendered.contains("registry_path = \"data/registry.json\""));
    }

    /// srt-router: config-file injection into a NESTED `web.bind` key.
    #[test]
    fn srt_router_configfile_nested_bind() {
        let tmp = std::env::temp_dir().join("av-launcher-test-srt");
        std::fs::create_dir_all(&tmp).unwrap();
        let template = tmp.join("srt.example.toml");
        std::fs::write(&template, "[web]\nbind = \"0.0.0.0:8080\"\n").unwrap();

        let cfg = parse(&format!(
            r#"
            [app]
            name = "SRT Router"
            command = "/bin/srtrouter"
            args = ["--config", "{{config}}"]
            [inject]
            mode = "configfile"
            [inject.configfile]
            template = '{}'
            set_key = "web.bind"
            value = "{{host}}:{{port}}"
            "#,
            template.display()
        ));

        let launch = build_launch(
            &cfg,
            "0.0.0.0",
            8080,
            &std::collections::BTreeMap::new(),
            &tmp,
            None,
        )
        .unwrap();
        assert_eq!(launch.args[0], "--config");
        let rendered = std::fs::read_to_string(&launch.args[1]).unwrap();
        assert!(
            rendered.contains("bind = \"0.0.0.0:8080\""),
            "nested web.bind not patched: {rendered}"
        );
    }

    /// RFutils: env injection, no config file touched.
    #[test]
    fn rfutils_env_injection() {
        let tmp = std::env::temp_dir().join("av-launcher-test-env");
        let cfg = parse(
            r#"
            [app]
            name = "RFutils"
            command = "node"
            args = ["server.js"]
            [inject]
            mode = "env"
            [inject.env]
            RFUTILS_SERVER_PORT = "{port}"
            RFUTILS_HOST = "{host}"
            "#,
        );

        let launch = build_launch(
            &cfg,
            "192.168.1.20",
            8420,
            &std::collections::BTreeMap::new(),
            &tmp,
            None,
        )
        .unwrap();
        assert!(launch
            .envs
            .contains(&("RFUTILS_SERVER_PORT".into(), "8420".into())));
        assert!(launch
            .envs
            .contains(&("RFUTILS_HOST".into(), "192.168.1.20".into())));
    }

    /// {resource} in command + args resolves to the bundle resource dir
    /// (how the RFutils bundle points at its embedded Node + server).
    #[test]
    fn resource_placeholder_in_command_and_args() {
        let res = std::env::temp_dir().join("av-launcher-test-resph");
        let work = std::env::temp_dir().join("av-launcher-test-resph-work");
        let cfg = parse(
            r#"
            [app]
            name = "RFutils"
            command = "{resource}/node"
            args = ["{resource}/app/server.mjs"]
            [inject]
            mode = "env"
            [inject.env]
            PORT = "{port}"
            "#,
        );
        let launch = build_launch(
            &cfg,
            "0.0.0.0",
            8420,
            &std::collections::BTreeMap::new(),
            &work,
            Some(&res),
        )
        .unwrap();
        assert_eq!(launch.program, format!("{}/node", res.to_string_lossy()));
        assert_eq!(
            launch.args,
            vec![format!("{}/app/server.mjs", res.to_string_lossy())]
        );
        assert!(launch.envs.contains(&("PORT".into(), "8420".into())));
    }

    /// args mode: {host}/{port} substituted directly into argv.
    #[test]
    fn args_injection() {
        let tmp = std::env::temp_dir().join("av-launcher-test-args");
        let cfg = parse(
            r#"
            [app]
            name = "Plain"
            command = "server"
            args = ["--host", "{host}", "--port", "{port}"]
            [inject]
            mode = "args"
            "#,
        );
        let launch = build_launch(
            &cfg,
            "127.0.0.1",
            7000,
            &std::collections::BTreeMap::new(),
            &tmp,
            None,
        )
        .unwrap();
        assert_eq!(launch.args, vec!["--host", "127.0.0.1", "--port", "7000"]);
    }

    /// Custom [[field]] values substitute as {key} in args (openrcs' switcher IP
    /// and model reach the server as {device}/{platform}).
    #[test]
    fn custom_fields_in_args() {
        let tmp = std::env::temp_dir().join("av-launcher-test-fields");
        let cfg = parse(
            r#"
            [app]
            name = "openrcs"
            command = "openrcs-server"
            args = ["--device", "{device}:10500", "--platform", "{platform}", "--listen", "{host}:{port}"]
            [inject]
            mode = "args"
            [[field]]
            key = "device"
            label = "Switcher IP"
            [[field]]
            key = "platform"
            label = "Model"
            type = "select"
            "#,
        );
        let mut fields = std::collections::BTreeMap::new();
        fields.insert("device".to_string(), "192.168.1.42".to_string());
        fields.insert("platform".to_string(), "livecore".to_string());
        let launch = build_launch(&cfg, "0.0.0.0", 8730, &fields, &tmp, None).unwrap();
        assert_eq!(
            launch.args,
            vec![
                "--device",
                "192.168.1.42:10500",
                "--platform",
                "livecore",
                "--listen",
                "0.0.0.0:8730"
            ]
        );
    }

    /// Shipped bundle: a relative `command` + `template` resolve against the
    /// resource dir, and cwd defaults to the writable work dir.
    #[test]
    fn bundled_relative_paths_resolve_against_resource_dir() {
        let res = std::env::temp_dir().join("av-launcher-test-res");
        let work = std::env::temp_dir().join("av-launcher-test-res-work");
        std::fs::create_dir_all(&res).unwrap();
        std::fs::write(res.join("server-config.toml"), "bind = \"0.0.0.0:8080\"\n").unwrap();

        let cfg = parse(
            r#"
            [app]
            name = "flock"
            command = "flock"
            args = ["{config}"]
            [inject]
            mode = "configfile"
            [inject.configfile]
            template = "server-config.toml"
            set_key = "bind"
            value = "{host}:{port}"
            "#,
        );
        let launch = build_launch(
            &cfg,
            "0.0.0.0",
            8080,
            &std::collections::BTreeMap::new(),
            &work,
            Some(&res),
        )
        .unwrap();
        assert_eq!(launch.program, res.join("flock").to_string_lossy());
        assert_eq!(launch.cwd, Some(work.clone()));
        let rendered = std::fs::read_to_string(&launch.args[0]).unwrap();
        assert!(rendered.contains("bind = \"0.0.0.0:8080\""));
    }

    /// The trap that broke every bundled launcher on Windows: Tauri's
    /// `resource_dir()` canonicalizes, which yields a verbatim path, and a
    /// verbatim path does no separator translation — so `{resource}/node`
    /// resolved to nothing at all.
    #[test]
    fn verbatim_resource_dir_is_simplified() {
        assert_eq!(
            simplify_windows_path(r"\\?\C:\Program Files\App/node"),
            r"C:\Program Files\App\node"
        );
    }

    #[test]
    fn verbatim_unc_becomes_a_plain_unc_path() {
        assert_eq!(
            simplify_windows_path(r"\\?\UNC\nas\share\app/node"),
            r"\\nas\share\app\node"
        );
    }

    /// A device path has no non-verbatim spelling, so stripping the prefix
    /// would break it. Leave it exactly as it came.
    #[test]
    fn verbatim_device_path_is_left_alone() {
        let device = r"\\?\Volume{4c1b02c1-d990-11dc-99ae-806e6f6e6963}\node";
        assert_eq!(simplify_windows_path(device), device);
    }

    #[test]
    fn forward_slashes_become_backslashes() {
        assert_eq!(simplify_windows_path("C:/tools/node"), r"C:\tools\node");
    }

    /// Windows only: neither the program nor a path argument may carry a
    /// verbatim prefix or a forward slash, or CreateProcess cannot find the
    /// binary and Node cannot find its entry script. Non-path args are left
    /// exactly as written.
    #[cfg(windows)]
    #[test]
    fn windows_launch_paths_are_native() {
        let res = std::path::PathBuf::from(r"\\?\C:\Program Files\App");
        let work = std::env::temp_dir();
        let cfg = parse(
            r#"
            [app]
            name = "App"
            command = "{resource}/node"
            args = ["{resource}/app/index.js", "--url", "http://{host}:{port}/"]
            [inject]
            mode = "args"
            "#,
        );
        let launch = build_launch(&cfg, "0.0.0.0", 8080, &work, Some(&res)).unwrap();
        assert_eq!(launch.program, r"C:\Program Files\App\node");
        assert_eq!(launch.args[0], r"C:\Program Files\App\app\index.js");
        assert_eq!(launch.args[2], "http://0.0.0.0:8080/");
    }
}
