# Developing RFutils

How to set up, build, test and extend RFutils. For the architectural *why* and the traps
that bite, read [`AGENTS.md`](../AGENTS.md) as well.

---

## Prerequisites

Node.js with npm workspaces support (Node 22.13+). No other services or databases.

```bash
git clone https://github.com/stoatworks-labs/RFutils
cd RFutils
npm install
```

---

## The one thing that will confuse you first

**`packages/shared` must be built before `server` or `web` will typecheck or run.**

Every dev and build script does this for you (`npm run build:shared` runs first). But if you
run `tsc` directly in `server` or `web`, or open the repo in an editor before a first build,
you'll see a wall of phantom type errors from missing `@rfutils/shared` types.

The fix is always the same:
```bash
npm run build:shared
```

---

## Commands

All from the repo root.

| Command | What it does |
|---|---|
| `npm run dev` | Server (port 8420) + web, both watching |
| `npm run dev:demo` | **Usually what you want** — as above, with mock devices |
| `npm run dev:verify` | Monitoring disabled — deterministic, no network traffic |
| `npm run dev:capture-demo` | Mock devices plus a synthetic audio source via `sox` |
| `npm run dev:server` / `dev:web` | One side only |
| `npm run build` | Build shared, then server, then web |
| `npm run typecheck` | **Covers all three packages** — the check that matters |
| `npm run lint` | ESLint over `packages` |
| `npm test` | Server test suite |

**Develop against `dev:demo`.** Real receivers are expensive, not always to hand, and — for
anything touching programming — carry real risk. The mock path exercises discovery,
monitoring and the full UI without hardware.

`dev:verify` is the one to use when you need a deterministic run with no discovery traffic
in the way.

---

## Layout

```
packages/
  shared/   Types + parsers (WSM, WWB, PMSE). Built first; consumed by both others.
    formats/        Coordination file read/write + format detection
    pmse/           Ofcom PMSE PDF conversion
    coordination/   The coordination and analysis engine
  server/   Express + ws backend
    index.ts        Bootstrap, static hosting, WebSocket upgrade routing
    routes.ts       The /api router
    inventory/      Inventory persistence
    profiles/       Device profile catalog
    plugins/        Plugin registry
    programming/    Shure and Lectrosonics programmers
    monitor/        Device discovery and monitoring
  web/      React frontend
    src/App.tsx     Imports all six tabs DIRECTLY - see below
    src/tabs/
```

---

## How to make common changes

### Add a tab
`App.tsx` imports its tabs **directly**. There is no lazy loading, no dynamic import and no
string-keyed registry — so a new tab must be wired into `App.tsx` explicitly. (A generic
`PlaceholderTab` used to exist for unbuilt tabs; it was removed once the real ones landed.
Add the real tab rather than reintroducing a stub.)

### Add an API endpoint
Add it to `createApiRouter` in `packages/server/src/routes.ts`, and document it in
[`API.md`](API.md).

**Wrap async handlers in `wrap()`.** Express 4 does not forward rejected promises to its
error handler, so an unwrapped async handler turns a normal failure into an unhandled
rejection.

### Add or change a parser
**These are now the canonical parsers.** The originals are Python, in the standalone
[`wsm-wwb-bridge`](https://github.com/stoatworks-labs/wsm-wwb-bridge) repo, which is retired in
favour of RFutils (October 2026). The TypeScript versions here are held to the bridge's output by
`packages/server/test/bridgeGolden.test.ts` — every reader and writer against what the bridge's
own Python produced for its published sample files, in `test/bridge-golden/` — and
`bridgeParity.test.ts`, its unit tests ported assertion for assertion. Change behaviour here on
purpose and update the fixtures with a note; do not regenerate them away.

Then: **don't tidy a parser to match what the format "ought" to look like.** These formats
are reverse-engineered from real exports. The awkward branches usually encode a real
observation. Where you change parsing behaviour, add a test with a real sample file.

### Add a device transport
Transport is inferred from the device-channel id's vendor prefix in `inferTransport()`.
Programmers live in `packages/server/src/programming/`.

**Preserve the dry-run default.** `POST /api/program` only transmits when `dryRun` is
*explicitly* `false` (`req.body?.dryRun !== false`). That guard is the last thing standing
between a typo and retuning a receiver mid-show.

---

## Testing

```bash
npm test          # server package
npm run typecheck # all three packages
```

The standard to hold: **verify against a real artefact, not against your model of the
format.** The PMSE parser was validated against a real Ofcom licence; the ported parsers
were byte-verified against the Python originals. A test written from the same assumption as
the code proves nothing.

---

## Gotchas worth knowing

- **Two WebSocket endpoints share one HTTP server** via two
  `WebSocketServer({ noServer: true })` instances and one manual upgrade router by pathname. Passing
  `{ server, path }` to two separate `WebSocketServer` instances makes each reject the
  other's upgrades with a 400. Don't "simplify" it.
- **Uploads strip a leading BOM** before parsing — exports from Windows tools frequently
  carry one.
- **`PUT /api/inventory` replaces the entire collection.** There's no partial update.
- **`POST /api/pmse/convert` distinguishes 400 from 422**: 400 means no file, 422 means the
  PDF parsed but isn't a PMSE licence schedule. Keep that distinction — it's the difference
  between two very different user mistakes.

---

## Releasing

Multi-platform release CI. **Cross-compile macOS x86_64 on `macos-15`, never `macos-13`** —
those Intel runners are retired and the job will simply fail.

RFutils ships as its own desktop app via **av-launcher**, embedding a Node runtime. Note the
macOS Gatekeeper behaviour: for an unsigned `.app` bundling helper binaries, approving the
app does **not** unquarantine its payload, and the helpers are SIGKILLed silently. It
presents as "the app opens but the server never starts".

Public repo. "Commit" means commit **and** push.
