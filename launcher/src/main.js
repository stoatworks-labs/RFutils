// Launcher panel controller.
//
// Talks to the Rust backend via Tauri's global `invoke`. In a plain browser it
// falls back to mock data (with per-app themes) so the panel — and its theming
// — can be previewed and screenshotted without the native app.

const hasTauri = !!(window.__TAURI__ && window.__TAURI__.core);
const invoke = hasTauri ? window.__TAURI__.core.invoke : mockInvoke;

const el = (id) => document.getElementById(id);
const ui = {
  mark: el("mark"),
  name: el("app-name"),
  sub: el("app-sub"),
  card: el("server-card"),
  state: el("state"),
  url: el("url"),
  cfields: el("custom-fields"),
  iface: el("iface"),
  port: el("port"),
  toggle: el("toggle"),
  launch: el("launch"),
  hide: el("hide"),
  quit: el("quit"),
  gear: el("gear"),
  msg: el("msg"),
};

let running = false;
let pollTimer = null;
// key -> the rendered <input>/<select> for each custom field ([[field]] in the config)
const fieldInputs = {};

// Render the app's custom fields (e.g. a switcher IP, a model selector) above
// the interface/port controls. Each field's value is substituted into the
// server's launch args as {key}.
function renderFields(specs, values) {
  ui.cfields.innerHTML = "";
  for (const k of Object.keys(fieldInputs)) delete fieldInputs[k];
  for (const f of specs || []) {
    const wrap = document.createElement("div");
    wrap.className = "field";
    const label = document.createElement("label");
    label.setAttribute("for", `f-${f.key}`);
    label.textContent = f.label;
    wrap.appendChild(label);

    const cur = values && values[f.key] != null && values[f.key] !== "" ? values[f.key] : f.default || "";
    let input;
    if (f.type === "select") {
      const sw = document.createElement("div");
      sw.className = "select-wrap";
      input = document.createElement("select");
      for (const o of f.options || []) {
        const value = typeof o === "string" ? o : o.value;
        const text = typeof o === "string" ? o : o.label;
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = text;
        if (value === cur) opt.selected = true;
        input.appendChild(opt);
      }
      sw.appendChild(input);
      wrap.appendChild(sw);
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.placeholder = f.placeholder || "";
      input.value = cur;
      input.autocomplete = "off";
      input.spellcheck = false;
      wrap.appendChild(input);
    }
    input.id = `f-${f.key}`;
    input.addEventListener("change", persist);
    fieldInputs[f.key] = input;
    ui.cfields.appendChild(wrap);
  }
}

function collectFields() {
  const out = {};
  for (const [key, input] of Object.entries(fieldInputs)) out[key] = input.value.trim();
  return out;
}

function flash(text, isError = false) {
  ui.msg.textContent = text || "";
  ui.msg.classList.toggle("error", isError);
}

function applyTheme(theme) {
  if (!theme) return;
  for (const [k, v] of Object.entries(theme)) {
    document.documentElement.style.setProperty(`--${k}`, v);
  }
}

function renderStatus(status) {
  running = status.running;
  ui.state.textContent = status.running ? "Running" : "Stopped";
  ui.url.textContent = status.url || "not running";
  ui.url.href = status.url || "#";
  ui.card.classList.toggle("running", status.running);

  ui.toggle.textContent = status.running ? "Stop server" : "Start server";
  ui.toggle.classList.toggle("is-running", status.running);
  ui.iface.disabled = status.running;
  ui.port.disabled = status.running;
  for (const input of Object.values(fieldInputs)) input.disabled = status.running;
  ui.launch.disabled = !status.running;

  if (status.message && status.message !== "Running" && status.message !== "Stopped") {
    flash(status.message);
  } else {
    flash("");
  }
}

async function refreshStatus() {
  try {
    renderStatus(await invoke("get_status"));
  } catch (e) {
    flash(String(e), true);
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(refreshStatus, 2000);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function persist() {
  const port = parseInt(ui.port.value, 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    flash("Port must be 1–65535", true);
    return;
  }
  try {
    await invoke("save_settings", { port, interface: ui.iface.value, fields: collectFields() });
    await refreshStatus();
  } catch (e) {
    flash(String(e), true);
  }
}

/** Filled in from get_app_info; shown by the gear button. */
let configDir = "";

async function init() {
  try {
    const info = await invoke("get_app_info");
    configDir = info.config_dir;
    applyTheme(info.theme);
    ui.name.textContent = info.name;
    ui.mark.textContent = (info.name.trim()[0] || "◆").toUpperCase();
    document.title = `${info.name} Launcher`;

    const ifaces = await invoke("list_interfaces");
    const settings = await invoke("get_settings");
    renderFields(info.fields, settings.fields || {});
    ui.iface.innerHTML = "";
    for (const i of ifaces) {
      const opt = document.createElement("option");
      opt.value = i.name;
      opt.textContent = i.label;
      if (i.name === settings.interface) opt.selected = true;
      ui.iface.appendChild(opt);
    }
    ui.port.value = settings.port;

    await refreshStatus();
    startPolling();
  } catch (e) {
    flash(String(e), true);
  }
}

// --- Wiring ---
ui.iface.addEventListener("change", persist);
ui.port.addEventListener("change", persist);

ui.toggle.addEventListener("click", async () => {
  ui.toggle.disabled = true;
  try {
    renderStatus(await invoke(running ? "stop_server" : "start_server"));
  } catch (e) {
    flash(String(e), true);
  } finally {
    ui.toggle.disabled = false;
  }
});

ui.launch.addEventListener("click", () => invoke("open_gui").catch((e) => flash(String(e), true)));
ui.hide.addEventListener("click", () => invoke("hide_window").catch(() => {}));
ui.quit.addEventListener("click", () => invoke("quit_app").catch(() => {}));
ui.gear.addEventListener("click", () =>
  flash("Config: " + (configDir || "unknown"))
);

window.addEventListener("DOMContentLoaded", init);

// ---------- Mock backend (browser preview + screenshots only) ----------
// ?app=flock&port=8080&state=running&host=10.147.17.93 picks the app/state.
const MOCK_THEMES = {
  "SRT Router": {
    bg: "#14161a", panel: "#1a1d24", "panel-2": "#22262e", border: "#2a2d33",
    text: "#e6e6e6", muted: "#b7bfca", dim: "#6b7280",
    accent: "#9fb4ff", "accent-soft": "#1c2333", good: "#37835c",
  },
  flock: {
    bg: "#14161a", panel: "#1b1e24", "panel-2": "#21252c", border: "#2c313a",
    text: "#e6e8eb", muted: "#9aa1ac", dim: "#6b7280",
    accent: "#1fae63", "accent-soft": "#15271d", good: "#1fae63",
  },
  RFutils: {
    bg: "#12141a", panel: "#1a1d26", "panel-2": "#232733", border: "#2a2e3a",
    text: "#e8eaf0", muted: "#9aa1b2", dim: "#6b7080",
    accent: "#6ea8fe", "accent-soft": "#172138", good: "#3fae5a",
  },
  openrcs: {
    bg: "#0d1015", panel: "#151a21", "panel-2": "#1b222c", border: "#242c37",
    text: "#e6ebf2", muted: "#8b96a5", dim: "#5b6673",
    accent: "#22b8cf", "accent-soft": "#12414d", good: "#3fb950",
  },
};

// Apps that collect custom fields (mock preview only).
const MOCK_FIELDS = {
  openrcs: [
    { key: "device", label: "Switcher IP", type: "text", placeholder: "192.168.1.42", default: "" },
    {
      key: "platform", label: "Model", type: "select", default: "livecore",
      options: [
        { value: "livecore", label: "LiveCore (NeXtage / Ascender)" },
        { value: "midra", label: "Midra (Pulse2 / Eikos2)" },
      ],
    },
  ],
};

function mockInvoke(cmd, args = {}) {
  const q = new URLSearchParams(location.search);
  const host = q.get("host") || "10.147.17.93";
  const app = q.get("app") || "SRT Router";
  const s =
    mockInvoke.state ||
    (mockInvoke.state = {
      running: q.get("state") === "running",
      port: Number(q.get("port")) || 8080,
      iface: q.get("iface") || "en0",
      fields: {},
    });
  const url = () => `http://${s.iface === "lo0" ? "127.0.0.1" : host}:${s.port}/`;
  const status = () => ({
    running: s.running,
    url: url(),
    host,
    port: s.port,
    message: s.running ? "Running" : "Stopped",
  });
  switch (cmd) {
    case "get_app_info":
      return Promise.resolve({
        name: app,
        default_port: s.port,
        url_template: "http://{host}:{port}/",
        config_dir: "~/Library/Application Support/<launcher-id>",
        theme: MOCK_THEMES[app] || MOCK_THEMES["SRT Router"],
        fields: MOCK_FIELDS[app] || [],
      });
    case "list_interfaces":
      return Promise.resolve([
        { name: "all", ip: "0.0.0.0", label: "All interfaces (0.0.0.0)", loopback: false },
        { name: "en0", ip: "10.147.17.93", label: "en0: 10.147.17.93", loopback: false },
        { name: "lo0", ip: "127.0.0.1", label: "lo0: 127.0.0.1", loopback: true },
      ]);
    case "get_settings":
      return Promise.resolve({ port: s.port, interface: s.iface, fields: s.fields });
    case "save_settings":
      s.port = args.port; s.iface = args.interface; s.fields = args.fields || {}; return Promise.resolve();
    case "get_status":
      return Promise.resolve(status());
    case "start_server":
      s.running = true; return Promise.resolve(status());
    case "stop_server":
      s.running = false; return Promise.resolve(status());
    default:
      return Promise.resolve();
  }
}
