# AGENTS.md — bringing an LLM up to speed on RFutils

Orientation for an AI assistant (or a new human) picking this project up cold. `CLAUDE.md`
holds the short command reference; this file explains the model and the traps.

---

## 1. What this is

A browser-based **RF-coordination and wireless-mic suite** that unifies three previously
separate tools into one package, with room to grow into full frequency coordination,
allocation and deployment services.

| Merged tool | What it did | Where it lives now |
|---|---|---|
| `wsm-wwb-bridge` | Move coordination data between Shure Wireless Workbench and Sennheiser Wireless Systems Manager, plus any CSV | **Convert** |
| `pmse-to-wwb` | Convert an Ofcom PMSE licence schedule PDF into WWB import files | **Convert** (same drop zone — `classifyUpload` routes a PDF by its bytes) |
| `MicWizard` | Discover networked Shure/Sennheiser/AES67 receivers, monitor audio/battery/RF | **Monitor** |

Node/TypeScript, npm-workspaces monorepo. Public repo (github.com/stoatworks-labs/RFutils).

## 2. The thing to understand before touching a parser

**Most of these formats are reverse-engineered from real exports and vendor gear, not from
published schemas.** Neither Shure nor Sennheiser publishes full specifications for most of
them.

Two consequences:

- **Never "clean up" a parser to match what the format *ought* to look like.** The oddities
  are usually real observations from real files.
- The PMSE PDF parser has been **validated against a real Ofcom licence**, and the parsers
  ported from wsm-wwb-bridge were **byte-verified** against the Python originals. Preserve
  that standard: verify against a real artefact, not against your model of the format.

**RFutils is now canonical.** MicWizard, `wsm-wwb-bridge` and `pmse-to-wwb` were retired in its
favour in October 2026; their repos stay up, archived on 11 October, and new work happens here. The bridge's Python
parsers are pinned by `packages/server/test/bridgeGolden.test.ts` (its own output on its published
samples, byte for byte, in `test/bridge-golden/`) and `bridgeParity.test.ts` (its unit tests,
ported). A deliberate divergence from the bridge means updating those fixtures and saying why —
never regenerating them to make a failure go away. MicWizard's tests live on as `sap`, `aes67`,
`levels`, `companionConfig`, `aes67Pipeline`, `sennheiser` and `shureDiscovery`.

## 2a. The RF data is sourced, and every number says where it came from

`packages/shared/src/rf/` holds the real tuning ranges, occupied bandwidths and required
spacings for Shure, Sennheiser, Lectrosonics, Wisycom and AKG, quoted from vendor documentation
with a URL and a retrieval date on each figure. It replaced a catalog in which **every**
product claimed a flat 200 kHz occupied bandwidth, a 25 kHz raster and a hand-picked
spacing. Three things that catalog got wrong, and that you must not reintroduce:

- **Occupied bandwidth is not required spacing.** A Shure PSM 1000 occupies ~175 kHz but
  Shure's own compatible-frequency count implies ~1.85 MHz of practical separation. Both
  numbers are carried; they are not interchangeable.
- **Tuning raster is per-band, not per-product.** Shure SLX-D is 25 kHz everywhere except
  the JB band, which is 125 kHz. Wisycom is 5 kHz throughout.
- **Required spacing is per-mode.** Axient Digital is 350 kHz standard / 125 kHz HD;
  EW-DX is 600 / 300; Digital 6000 is 400 (LR) / 200 (LD).

Two further structural points:

- **`BandVariant.ranges` is a list because bands really are discontiguous.** Axient Digital
  G55/G57/K53/K54 carry the 608–614 MHz gap, K54 carries a second at 616–653, P55 is three
  segments, and every Wisycom MCR54 version is three segments. Flattening a variant to one
  start/end pair hands out frequencies the radio cannot tune.
- **Sennheiser digital gear does not IM-search — it uses an equidistant grid**, which is why
  those modes carry `strategy: 'equidistant'` and the engine has a grid path. An equidistant
  set has no third-order product landing on a member; that is the whole point of the
  published "min. frequency spacing for equidistant grid" figure.

Every figure carries a `Provenance` with `basis: 'vendor-doc' | 'derived' | 'assumed'`.
`verified` on a plugin/profile is now **derived from that** — it is true exactly when the
default mode's spacing came straight from the manufacturer. Do not set it by hand, and do
not upgrade a `derived` or `assumed` basis without a source to point at. `UNSOURCED_PRODUCTS`
lists the products that still carry placeholders, so the gap stays visible.

Coverage is Shure, Sennheiser, Lectrosonics, Wisycom and AKG. The rest of the catalog is
untouched placeholder data and says so.

## 3. Layout

```
packages/
  shared   Types + ALL the pure logic. Must be built first.
             formats/       WSM / WWB / CSV parsers + writers   -> @rfutils/shared/formats
             pmse/          PMSE PDF parser, exporters, .shw    -> @rfutils/shared/pmse
             coordination/  frequency coordination engine       -> @rfutils/shared/coordination
             rf/            sourced band variants + RF modes    -> @rfutils/shared/rf
  server   Backend (@rfutils/server) - HTTP/WS + the sockets a browser can't open
  web      Frontend (@rfutils/web) - React, tab-per-tool
docs/      BRANDS.md, PLUGINS.md, plugins/, screenshots/
```

**`shared` must be built before `server` or `web`.** Every dev and build script does this
first (`npm run build:shared`). If you see phantom type errors, that's usually why.

### The environment rule for `shared`

**Nothing in `packages/shared` may import a Node builtin** (`node:fs`, `node:crypto`,
`node:path`, …) or use `Buffer`/`process`. That is not a style preference — it is the only
reason the static build works. `packages/web/src/localApi.ts` runs these exact modules in the
browser, so one `readFileSync` added to a parser silently breaks the hosted app while every
test still passes (the tests run under Node, where it works fine).

Two consequences already baked in:

- The `.shw` XML templates are **inlined** into `templates.generated.ts` by
  `packages/shared/scripts/gen-templates.mjs` (run by `build`/`typecheck`; the output is
  gitignored). The `.tpl` files under `src/pmse/templates/` remain the source of truth — the
  generator copies their bytes verbatim and escapes only what a template literal requires.
- `showGenerator` uses Web Crypto, not `node:crypto`.

Things that legitimately need Node stay in `server/`: `inventory/store.ts`, `profiles/catalog.ts`,
`plugins/registry.ts` (all read `~/.rfutils`) and `programming/*` (raw TCP).

### The two web builds

`npm run build` targets the server; `npm run build:static` (`VITE_RFUTILS_STATIC=1`) produces the
browser-only bundle. `.github/workflows/deploy.yml` builds it on a push to main (`npm ci`,
`npm test`, `npm run build:static`, output `packages/web/dist-static`) and `wrangler deploy`
uploads it to the `rfutils` Worker, which serves it at the root of its own
domain — so the static build targets a root base path, not a `/RFutils/` subdirectory.

`src/buildMode.ts` exports the `staticBuild` flag, and it lives alone in that file on purpose: it
has to be a bare compile-time constant so Vite can eliminate the `if (staticBuild)` branches in
`api.ts` and `App.tsx` from the server build.

**Keeping localApi, and pdfjs with it, out of the server build does not rest on that
elimination.** The only `import('./localApi.js')` is in `src/loadLocalApi.ts`, and the server
build swaps that module for `src/loadLocalApi.server.ts`, a stand-in that throws (`resolve.alias`
in `vite.config.ts`). localApi is never in the server build's module graph at all. Load it only
through `loadLocalApi.js`; a direct import anywhere else brings it back.

Dead-code elimination alone stopped being enough at Vite 8. Rolldown does drop the dead branches,
but it still emits a chunk for every dynamic import it found before dropping them. From
Dependabot's PR #12 (a5bcb51, 2026-08-11, Vite 6 → 8; the root `overrides` has forced `^8.1.5`
since) until v0.5.2, the server build carried six chunks nothing ever loaded (localApi, pdfjs,
the parsers, the coordination engine) plus a rolldown runtime chunk the entry fetched to share
code with them: 975 kB of JS in eight chunks, where the fixed build has one of 315 kB, and 1.1 M
of `dist` against 468 K.

**`npm run build` now checks this itself:** the `rfutils-single-server-chunk` plugin in
`vite.config.ts` fails the server build if it emits more than one JS chunk, and names them. So a
Vite bump, or a new dynamic import, that brings it back fails CI instead of shipping. To look by
hand:

```bash
npm run build && ls packages/web/dist/assets   # one JS chunk + CSS, no pdf-*.js
```

Similarly, pdfjs's worker is copied in by the `rfutils-pdf-worker` plugin in `vite.config.ts`
rather than imported with `?url`: a `?url` import emits the 2.3 MB worker into *both* builds.

**When you add an API call**, add it to `api.ts` and decide explicitly: can it run in the browser
(implement it in `localApi.ts`) or does it need the server (`noServer(...)`, and make sure no
static-build tab reaches it)?

## 4. Commands (from repo root)

```bash
npm run dev          # server (port 8420) + web
npm run dev:demo     # with mock devices - no hardware needed
npm run dev:verify   # monitor disabled
npm run build
npm run build:static # browser-only bundle (the rfutils Worker)
npm run typecheck    # runs across shared, server and web
npm test             # server package
```

`dev:demo` is the one to reach for: device discovery and monitoring can be exercised with no
receivers on the network.

## 5. UI structure

`packages/web/src/App.tsx` imports its six tabs **directly** — there is no dynamic import,
no lazy loading and no string-keyed tab registry. If you add a tab, wire it into `App.tsx`
explicitly, and mark it `needsServer: true` if it can't work without the local server (the
static build filters those out).

(A `PlaceholderTab` component previously rendered "Planned" stubs for the coordination,
allocation and deployment tabs. Those three now have real implementations, so it was removed
as dead code. Don't reintroduce the pattern — add the real tab.)

## 6. Status and honesty requirements

The README carries an explicit warning that must not be softened: several formats and
protocols are reverse-engineered, and users are told to **verify every export against their
own WWB/WSM install before relying on it for a live show**.

When you write user-facing text for this project, keep that posture. "Experimental output"
means experimental.

## 7. Conventions

- Ships as its own desktop app via **av-launcher**, which for this project **embeds a Node
  runtime**. Note the macOS Gatekeeper trap common to all av-launcher apps: for an unsigned
  `.app` bundling helper binaries, approving the app does *not* unquarantine the payload —
  helpers are SIGKILLed silently.
- Multi-platform release CI; cross-compile macOS x86_64 on `macos-14`, never `macos-13`.
- Public repo. "Commit" means commit **and** push.

### Cutting a release: the version lives in six places

`npm version <v> --workspaces --include-workspace-root` covers the root and
`packages/{shared,server,web}`. It does **not** reach the launcher, and Tauri takes the app
version from its own files:

```
launcher/package.json
launcher/src-tauri/Cargo.toml          (and the av-launcher entry in Cargo.lock)
launcher/src-tauri/tauri.conf.json     ← this one names the .dmg
```

v0.3.0 shipped a `.dmg` labelled `0.2.0` because only the first four were bumped; v0.3.1 then
bumped the launcher but left the three workspaces behind. Check all six.

### Regenerating package-lock.json: delete node_modules too

```bash
rm -rf node_modules package-lock.json && npm install    # correct
rm -f package-lock.json && npm install                  # breaks Linux CI
```

With `node_modules` still present npm builds the lock from what is on disk — this machine —
and silently drops the `optionalDependencies` for every other platform. Linux CI then dies on
`Cannot find module @rollup/rollup-linux-x64-gnu` (npm/cli#4828; that was on Vite 6, which
bundled with rollup). A good lock has 15 `@rolldown/binding-*` entries
(it was ~25 `@rollup/rollup-*` on Vite 6) and the matching `@esbuild/*` ones; grep for
`@rolldown/binding-linux-x64-gnu` before committing.

## Diagnostics

Log via `log` (structured: `log.warn({ device }, 'reconnecting')`) or `say` (console-shaped,
for existing call sites) from the vendored `diag` module — never `console`. Anything written
to stdout corrupts `--collect-diagnostics`, whose stdout is a path. File writes are
synchronous on purpose: an async stream loses the crashing run's log.
See [docs/diagnostics.md](docs/diagnostics.md).

## Notes

`docs/NOTES.md` carries this repo's working notes — current status, decisions
already made, and the traps that have actually bitten. Read it before changing
anything non-obvious. Cross-cutting fleet knowledge lives in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).
