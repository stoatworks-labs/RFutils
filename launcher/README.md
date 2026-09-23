# RFutils — desktop app

A small menu-bar desktop app for RFutils: pick a network interface + port,
Start/Stop the server, open the web UI, and run it from the macOS menu bar.
Built with [Tauri v2](https://tauri.app).

![panel](docs/panel.png)

Download the `.dmg` from
[Releases](https://github.com/stoatworks-labs/RFutils/releases).

> **Fully self-contained.** Because RFutils is a Node app, this bundle embeds a
> Node runtime **and** the whole app (server + PMSE templates + built web UI).
> Nothing needs to be installed — no Node, no separate RFutils checkout. Just
> download and run.

> **Unsigned build.** On first launch macOS Gatekeeper will block it —
> right-click the app → **Open** → **Open**, once.

## What it does

- **Network interface** — every bindable IPv4 interface, plus "All interfaces (0.0.0.0)".
- **Port** — persisted between runs (RFutils default 8420).
- **Start / Stop** — supervises the embedded Node server process.
- **Open** — opens `http://<host>:<port>/` (Convert + Monitor UI) in your browser.
- **Hide** to the menu bar; **Quit** stops the server and exits.

The panel is themed to match RFutils' own web UI. Host:port is injected as
`RFUTILS_SERVER_PORT` / `RFUTILS_HOST` environment variables.

## How the embedding works

Unlike the fleet's Rust apps (a single native binary), a Node app needs a
runtime plus its files on disk. `scripts/prepare.sh`:

1. builds RFutils (`npm run build`),
2. esbuilds the server into one ESM file,
3. downloads a self-contained official Node runtime, and
4. lays it out mirroring the repo's `packages/{server,web}/dist` structure so the
   server's `import.meta.url`-relative paths (PMSE templates, the web UI) resolve
   unchanged.

All of that is bundled as app resources; `launcher.toml` points the launcher at
`{resource}/node` running `{resource}/rfutils-app/.../index.mjs`.

## Building from source

```bash
cd launcher
./scripts/prepare.sh          # build RFutils + esbuild server + fetch Node runtime
npm install
npm run tauri build           # -> src-tauri/target/release/bundle/{macos,dmg}/
```

The panel/tray shell is a copy of the reusable
[av-launcher](https://github.com/stoatworks-labs/av-launcher) (`src/`,
`src-tauri/src/`, `src-tauri/crates/`, `Cargo.lock`), taken file for file at
av-launcher `804555c`; only `src-tauri/launcher.toml` (config + theme),
`tauri.conf.json`, `Info.plist`, the icon and the embedded runtime are
app-specific. Refresh the shell by copying those files from a newer
av-launcher checkout, not by editing them here.
