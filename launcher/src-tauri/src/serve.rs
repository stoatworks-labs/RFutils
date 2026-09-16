//! Serving a static site in-process — the `[serve] mode = "static"` launcher.
//!
//! The fleet's browser tools are static pages: `dist/` out of a Vite build, or
//! a committed `web/`. Shipping one as a tray app means something has to serve
//! that directory on the chosen interface and port, and the launcher's other
//! modes all supervise a *child process*. A child static-server binary would be
//! exactly the shape AGENTS §5 warns about: an unsigned helper inside a `.app`
//! is quarantined with the bundle and SIGKILLed on a clean Mac, silently. So
//! this serves from inside the launcher's own process instead. Nothing is
//! spawned, nothing needs an execute bit, and the same panel — interface, port,
//! Start/Stop, Open — drives it.
//!
//! # What it does and does not do
//!
//! - GET and HEAD, for files under one directory, checked after percent
//!   decoding and canonicalisation so `%2e%2e%2f` cannot walk out of it.
//! - The site's Cloudflare `_headers` file is honoured, so the offline copy
//!   sends the same CSP and cache headers as the hosted one — and never serves
//!   that file itself.
//! - A directory means its index; a missing path is a 404, or the index when
//!   the site is a single-page application (`not_found = "spa"`).
//! - No ranges, no compression, no keep-alive. A browser tool is a few hundred
//!   kilobytes on a LAN, and every one of those would be code with nothing to
//!   earn its place.

use std::net::{SocketAddr, TcpListener};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// One rule from a `_headers` file: a path pattern and the headers it sets
/// (or, with a leading `!`, removes).
#[derive(Debug, Clone, PartialEq)]
struct HeaderRule {
    pattern: String,
    headers: Vec<(String, Option<String>)>,
}

/// The parsed `_headers` file, applied in order — a later matching rule
/// overrides an earlier one for the same header name, which is Cloudflare's
/// own behaviour.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct HeaderRules {
    rules: Vec<HeaderRule>,
}

/// The headers every response carries when the site ships no `_headers` file,
/// and the starting point when it does. The same three the fleet's nginx
/// images fall back to.
const BASELINE: &[(&str, &str)] = &[
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "DENY"),
    ("Referrer-Policy", "strict-origin-when-cross-origin"),
];

impl HeaderRules {
    /// Parse the Cloudflare Pages `_headers` format: a line starting with `/`
    /// opens a rule, indented `Name: value` lines belong to it, `! Name`
    /// removes a header, `#` comments and blank lines are ignored.
    pub fn parse(text: &str) -> Self {
        let mut rules: Vec<HeaderRule> = Vec::new();
        for raw in text.lines() {
            let line = raw.trim_end();
            let trimmed = line.trim_start();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if !line.starts_with(' ') && !line.starts_with('\t') && trimmed.starts_with('/') {
                rules.push(HeaderRule {
                    pattern: trimmed.to_string(),
                    headers: Vec::new(),
                });
                continue;
            }
            let Some(rule) = rules.last_mut() else {
                continue; // a header line before any pattern: nothing to attach it to
            };
            if let Some(name) = trimmed.strip_prefix('!') {
                rule.headers.push((name.trim().to_string(), None));
            } else if let Some((name, value)) = trimmed.split_once(':') {
                rule.headers
                    .push((name.trim().to_string(), Some(value.trim().to_string())));
            }
        }
        Self { rules }
    }

    /// The response headers for one request path.
    pub fn for_path(&self, path: &str) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = BASELINE
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        for rule in &self.rules {
            if !pattern_matches(&rule.pattern, path) {
                continue;
            }
            for (name, value) in &rule.headers {
                out.retain(|(k, _)| !k.eq_ignore_ascii_case(name));
                if let Some(v) = value {
                    out.push((name.clone(), v.clone()));
                }
            }
        }
        out
    }
}

/// Cloudflare's path patterns: `*` matches any run of characters (including
/// `/`), and `:name` matches one path segment. Everything else is literal.
fn pattern_matches(pattern: &str, path: &str) -> bool {
    fn go(p: &[char], s: &[char]) -> bool {
        match p.split_first() {
            None => s.is_empty(),
            Some(('*', rest)) => (0..=s.len()).any(|i| go(rest, &s[i..])),
            Some((':', rest)) => {
                // Skip the placeholder's name, then match one segment.
                let name_len = rest.iter().take_while(|c| **c != '/').count();
                let after = &rest[name_len..];
                let seg_len = s.iter().take_while(|c| **c != '/').count();
                seg_len > 0 && go(after, &s[seg_len..])
            }
            Some((c, rest)) => s.first() == Some(c) && go(rest, &s[1..]),
        }
    }
    let p: Vec<char> = pattern.chars().collect();
    let s: Vec<char> = path.chars().collect();
    go(&p, &s)
}

/// What to do with a path that names nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotFound {
    /// A plain 404.
    None,
    /// Serve the index with a 200 — a single-page application routes client-side.
    Spa,
}

impl NotFound {
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "none" | "" => Ok(Self::None),
            "spa" => Ok(Self::Spa),
            other => Err(format!(
                "unknown serve.not_found: {other} (expected none or spa)"
            )),
        }
    }
}

/// Everything the server needs to answer a request, fixed at start.
#[derive(Debug, Clone)]
pub struct Site {
    pub root: PathBuf,
    pub index: String,
    pub not_found: NotFound,
    pub headers: HeaderRules,
}

/// A running static server. Dropping it without calling [`stop`] leaves the
/// thread serving until the process exits, which is what a tray app that is
/// quitting wants anyway.
///
/// [`stop`]: StaticServer::stop
pub struct StaticServer {
    /// The address actually bound — the port is the one asked for, unless that
    /// was 0. Kept whole rather than as a bare port because [`stop`] has to
    /// bind it again to know the listener has gone.
    ///
    /// [`stop`]: StaticServer::stop
    addr: SocketAddr,
    server: Arc<tiny_http::Server>,
    alive: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl StaticServer {
    /// Bind and start serving. Returns once the listener is accepting.
    pub fn start(site: Site, bind_host: &str, port: u16) -> Result<StaticServer, String> {
        if !site.root.is_dir() {
            return Err(format!(
                "the site directory does not exist: {}",
                site.root.display()
            ));
        }
        let addr: SocketAddr = format!("{bind_host}:{port}")
            .parse()
            .map_err(|e| format!("bad bind address {bind_host}:{port}: {e}"))?;
        let listener =
            TcpListener::bind(addr).map_err(|e| format!("could not bind {addr}: {e}"))?;
        let addr = listener.local_addr().map_err(|e| e.to_string())?;
        let server = Arc::new(
            tiny_http::Server::from_listener(listener, None)
                .map_err(|e| format!("could not start the server: {e}"))?,
        );

        let alive = Arc::new(AtomicBool::new(true));
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread_server = server.clone();
        let thread_alive = alive.clone();
        let thread = thread::Builder::new()
            .name("av-launcher-static".into())
            .spawn(move || {
                let _ = ready_tx.send(());
                for request in thread_server.incoming_requests() {
                    respond(request, &site);
                }
                thread_alive.store(false, Ordering::SeqCst);
            })
            .map_err(|e| format!("could not start the server thread: {e}"))?;
        let _ = ready_rx.recv();

        Ok(StaticServer {
            addr,
            server,
            alive,
            thread: Some(thread),
        })
    }

    /// The port actually bound. Read by the tests; the panel takes the port
    /// from its own settings.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn port(&self) -> u16 {
        self.addr.port()
    }

    /// Whether the serving thread is still accepting. False once it has
    /// stopped for any reason, so the panel never claims a server that is not
    /// there.
    pub fn is_running(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Stop accepting, wait for the serving thread, and wait for the listening
    /// socket to actually close.
    ///
    /// That last part is not ceremony. `tiny_http` moves the `TcpListener`
    /// into a detached accept thread of its own and never joins it; its `Drop`
    /// sets a flag and makes a throwaway connection to wake that thread up.
    /// So releasing the last `Arc<Server>` *starts* the teardown and returns —
    /// the port stays bound until the accept thread is next scheduled, which
    /// on a loaded machine has been measured at tens of milliseconds. Stopping
    /// and starting again on the same fixed port, which is exactly what the
    /// panel's Stop then Start does, would otherwise fail to bind for reasons
    /// that look like nothing the user did.
    pub fn stop(mut self) {
        let addr = self.addr;
        self.server.unblock();
        self.alive.store(false, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        drop(self); // the last Arc — this is what begins tiny_http's teardown
        wait_until_bindable(addr);
    }
}

/// Block until `addr` can be bound again, or until the wait has gone on long
/// enough to be someone else's problem.
///
/// Binding is the question worth asking: it is precisely what the next
/// `start` will do, and it answers itself, because a `bind` refused with
/// `EADDRINUSE` is the accept thread still holding the listener.
fn wait_until_bindable(addr: SocketAddr) {
    // Comfortably clear of the tens of milliseconds seen on a box running four
    // times as many busy threads as it has cores, and short enough that a
    // socket that somehow never comes back cannot hold up quitting the app.
    const LIMIT: Duration = Duration::from_secs(1);
    let deadline = Instant::now() + LIMIT;
    loop {
        match TcpListener::bind(addr) {
            Ok(_probe) => return,
            Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(1)),
            Err(e) => {
                eprintln!("av-launcher: {addr} still bound {LIMIT:?} after stopping: {e}");
                return;
            }
        }
    }
}

/// Answer one request.
fn respond(request: tiny_http::Request, site: &Site) {
    let method = request.method().as_str().to_ascii_uppercase();
    let head_only = method == "HEAD";
    if method != "GET" && !head_only {
        let _ = request.respond(
            tiny_http::Response::from_string("method not allowed")
                .with_status_code(405)
                .with_header(header("Allow", "GET, HEAD")),
        );
        return;
    }

    let url = request.url().to_string();
    let path_only = url.split(['?', '#']).next().unwrap_or("/");

    let file = resolve(&site.root, &site.index, path_only).or_else(|| match site.not_found {
        NotFound::Spa => resolve(&site.root, &site.index, "/"),
        NotFound::None => None,
    });

    // A file that resolves but cannot be read is reported as missing rather
    // than as a server error: the cause is the same kind of thing (a bundle
    // with a file it cannot open) and a 404 is what the page can act on.
    let found = file
        .as_deref()
        .and_then(|f| std::fs::read(f).ok().map(|bytes| (bytes, mime_for(f))));
    let (status, body, mime) = match found {
        Some((bytes, mime)) => (200, bytes, mime),
        None => (404, b"not found".to_vec(), "text/plain; charset=utf-8"),
    };

    // Headers are chosen by the *requested* path, so `/assets/x.js` gets the
    // immutable cache policy whether or not it exists, and an SPA fallback for
    // `/some/route` gets the rules for that route rather than for the index.
    let mut response =
        tiny_http::Response::from_data(if head_only { Vec::new() } else { body.clone() })
            .with_status_code(status)
            .with_header(header("Content-Type", mime));
    for (k, v) in site.headers.for_path(path_only) {
        if let Ok(h) = tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()) {
            response = response.with_header(h);
        }
    }
    if head_only {
        response = response.with_header(header("Content-Length", &body.len().to_string()));
    }
    let _ = request.respond(response);
}

/// The files that document or configure a site rather than being part of it.
fn is_not_for_serving(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    name == "_headers" || name == "_redirects" || name == ".assetsignore"
}

/// Resolve a request path to a file inside the root, or refuse it.
///
/// Percent-decoding happens *first* — otherwise `%2e%2e%2f` walks straight
/// past a check performed on the raw string. Then the assembled path is
/// canonicalised and confirmed to still be under the root, which catches
/// anything the textual rules missed.
fn resolve(root: &Path, index: &str, request_path: &str) -> Option<PathBuf> {
    let decoded = percent_decode(request_path)?;
    let mut path = root.to_path_buf();
    for part in decoded.split('/').filter(|s| !s.is_empty()) {
        if part == "." || part == ".." || part.contains('\0') {
            return None;
        }
        path.push(part);
    }
    if path.is_dir() {
        path.push(index);
    }
    let canonical = path.canonicalize().ok()?;
    let root_canonical = root.canonicalize().ok()?;
    if !canonical.starts_with(&root_canonical) {
        return None;
    }
    if std::fs::symlink_metadata(&canonical)
        .ok()?
        .file_type()
        .is_symlink()
    {
        return None;
    }
    if canonical
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return None;
    }
    if is_not_for_serving(&canonical) {
        return None;
    }
    canonical.is_file().then_some(canonical)
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let hex = bytes.get(i + 1..i + 3)?;
                let v = u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?;
                out.push(v);
                i += 3;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        // Must be a JavaScript type or the browser refuses the module script
        // and the page silently renders nothing.
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "webmanifest" => "application/manifest+json",
        "txt" | "md" => "text/plain; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

fn header(name: &str, value: &str) -> tiny_http::Header {
    tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes())
        .expect("static header is well formed")
}

/// Read a whole HTTP response off a stream, for the tests.
#[cfg(test)]
fn fetch(port: u16, request: &str) -> String {
    use std::io::{Read, Write};
    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(s, "{request}").unwrap();
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).unwrap();
    String::from_utf8_lossy(&buf).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    /// Held for the whole of any test that binds a port, so that no two of
    /// this module's servers are ever live at once.
    ///
    /// These tests all bind port 0 and the harness runs them in parallel, so
    /// without this the port one test has just released can be handed straight
    /// to another test's `bind`. A test that then asks "is anything listening
    /// on the port I was using?" gets an answer about somebody else's server.
    static PORTS: Mutex<()> = Mutex::new(());

    /// A poisoned `PORTS` would turn one failing test into every later test
    /// failing too, hiding the one that actually broke — so take the lock back
    /// from a panicking test rather than unwrapping.
    fn port_lock() -> MutexGuard<'static, ()> {
        PORTS.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A server that holds [`PORTS`] for as long as the test needs it.
    struct TestServer {
        srv: StaticServer,
        lock: MutexGuard<'static, ()>,
    }

    impl std::ops::Deref for TestServer {
        type Target = StaticServer;
        fn deref(&self) -> &StaticServer {
            &self.srv
        }
    }

    impl TestServer {
        /// Stop the server; the port goes back into circulation with it.
        fn stop(self) {
            self.srv.stop();
        }

        /// Stop the server but keep holding [`PORTS`], for a test that wants to
        /// look at the port it was using rather than at whoever binds it next.
        fn stop_holding_the_port_lock(self) -> MutexGuard<'static, ()> {
            self.srv.stop();
            self.lock
        }
    }

    fn site_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("av-launcher-static-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("assets")).unwrap();
        std::fs::write(dir.join("index.html"), "<!doctype html><title>t</title>").unwrap();
        std::fs::write(dir.join("assets/app-abc123.js"), "export const x = 1;").unwrap();
        std::fs::write(
            dir.join("sw.js"),
            "self.addEventListener('fetch', () => {});",
        )
        .unwrap();
        std::fs::write(
            dir.join("_headers"),
            "/*\n  Content-Security-Policy: default-src 'self'\n\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n\n/sw.js\n  Cache-Control: no-cache\n",
        )
        .unwrap();
        dir
    }

    fn start(name: &str, not_found: NotFound) -> (TestServer, PathBuf) {
        let lock = port_lock();
        let root = site_dir(name);
        let headers = HeaderRules::parse(&std::fs::read_to_string(root.join("_headers")).unwrap());
        let site = Site {
            root: root.clone(),
            index: "index.html".into(),
            not_found,
            headers,
        };
        let srv = StaticServer::start(site, "127.0.0.1", 0).unwrap();
        (TestServer { srv, lock }, root)
    }

    fn get(port: u16, path: &str) -> String {
        fetch(
            port,
            &format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"),
        )
    }

    #[test]
    fn serves_the_index_with_the_site_headers() {
        let (srv, _) = start("index", NotFound::None);
        let r = get(srv.port(), "/");
        assert!(r.starts_with("HTTP/1.1 200"), "{r}");
        assert!(r.contains("Content-Type: text/html"), "{r}");
        assert!(
            r.contains("Content-Security-Policy: default-src 'self'"),
            "{r}"
        );
        assert!(r.contains("X-Content-Type-Options: nosniff"), "{r}");
        assert!(r.contains("<title>t</title>"), "{r}");
        srv.stop();
    }

    #[test]
    fn later_rules_override_earlier_ones_by_path() {
        let (srv, _) = start("rules", NotFound::None);
        let asset = get(srv.port(), "/assets/app-abc123.js");
        assert!(asset.contains("Content-Type: text/javascript"), "{asset}");
        assert!(
            asset.contains("Cache-Control: public, max-age=31536000, immutable"),
            "{asset}"
        );
        assert!(
            asset.contains("Content-Security-Policy"),
            "the /* rule still applies: {asset}"
        );
        let sw = get(srv.port(), "/sw.js");
        assert!(sw.contains("Cache-Control: no-cache"), "{sw}");
        srv.stop();
    }

    #[test]
    fn refuses_traversal_raw_and_percent_encoded() {
        let (srv, root) = start("traversal", NotFound::None);
        std::fs::write(
            root.parent().unwrap().join("outside-static-test.txt"),
            "secret",
        )
        .unwrap();
        for p in [
            "/../outside-static-test.txt",
            "/%2e%2e/outside-static-test.txt",
            "/assets/../../outside-static-test.txt",
        ] {
            let r = get(srv.port(), p);
            assert!(r.starts_with("HTTP/1.1 404"), "{p}: {r}");
            assert!(!r.contains("secret"), "{p} leaked: {r}");
        }
        srv.stop();
    }

    #[test]
    fn never_serves_the_headers_file() {
        let (srv, _) = start("hidden", NotFound::None);
        let r = get(srv.port(), "/_headers");
        assert!(r.starts_with("HTTP/1.1 404"), "{r}");
        srv.stop();
    }

    #[test]
    fn spa_falls_back_to_the_index_with_the_routes_headers() {
        let (srv, _) = start("spa", NotFound::Spa);
        let r = get(srv.port(), "/some/client/route");
        assert!(r.starts_with("HTTP/1.1 200"), "{r}");
        assert!(r.contains("<title>t</title>"), "{r}");
        assert!(
            !r.contains("immutable"),
            "an SPA route must not carry the asset cache policy: {r}"
        );
        srv.stop();
    }

    #[test]
    fn plain_404_when_not_spa() {
        let (srv, _) = start("404", NotFound::None);
        let r = get(srv.port(), "/nothing-here");
        assert!(r.starts_with("HTTP/1.1 404"), "{r}");
        srv.stop();
    }

    #[test]
    fn head_has_headers_and_no_body() {
        let (srv, _) = start("head", NotFound::None);
        let r = fetch(
            srv.port(),
            "HEAD / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        );
        assert!(r.starts_with("HTTP/1.1 200"), "{r}");
        assert!(r.contains("Content-Type: text/html"), "{r}");
        assert!(!r.contains("<title>"), "{r}");
        srv.stop();
    }

    #[test]
    fn only_get_and_head() {
        let (srv, _) = start("post", NotFound::None);
        let r = fetch(
            srv.port(),
            "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        assert!(r.starts_with("HTTP/1.1 405"), "{r}");
        srv.stop();
    }

    #[test]
    fn stop_releases_the_port() {
        let (srv, _) = start("stop", NotFound::None);
        let port = srv.port();
        assert!(srv.is_running());
        // Keep the lock across the checks: the point is what happened to *this*
        // port, and a port nobody else can take is the only way to ask.
        let _lock = srv.stop_holding_the_port_lock();
        assert!(
            std::net::TcpStream::connect(("127.0.0.1", port)).is_err(),
            "something is still accepting on {port} after stop()"
        );
        // And the port is free, not merely unanswered — Stop then Start on a
        // fixed port is a thing the panel does.
        assert!(
            TcpListener::bind(("127.0.0.1", port)).is_ok(),
            "{port} could not be bound again after stop()"
        );
    }

    #[test]
    fn missing_directory_is_an_error_not_a_server() {
        let site = Site {
            root: PathBuf::from("/definitely/not/a/directory"),
            index: "index.html".into(),
            not_found: NotFound::None,
            headers: HeaderRules::default(),
        };
        assert!(StaticServer::start(site, "127.0.0.1", 0).is_err());
    }

    #[test]
    fn headers_parse_removals_and_placeholders() {
        let rules = HeaderRules::parse(
            "/*\n  X-Frame-Options: SAMEORIGIN\n/api/:id\n  ! X-Frame-Options\n  X-Api: yes\n",
        );
        let root = rules.for_path("/index.html");
        assert!(root
            .iter()
            .any(|(k, v)| k == "X-Frame-Options" && v == "SAMEORIGIN"));
        let api = rules.for_path("/api/42");
        assert!(!api.iter().any(|(k, _)| k == "X-Frame-Options"), "{api:?}");
        assert!(api.iter().any(|(k, v)| k == "X-Api" && v == "yes"));
        assert!(!pattern_matches("/api/:id", "/api/42/more"));
        assert!(pattern_matches("/assets/*", "/assets/a/b.js"));
        assert!(!pattern_matches("/assets/*", "/asset.js"));
    }

    #[test]
    fn baseline_when_there_is_no_headers_file() {
        let h = HeaderRules::default().for_path("/anything");
        assert_eq!(h.len(), BASELINE.len());
    }
}
