# RFutils API reference

The RFutils server exposes a JSON HTTP API under `/api`, plus two WebSocket endpoints.

**Base URL:** `http://<host>:8420` by default. The port comes from
`RFUTILS_SERVER_PORT`, falling back to `PORT`, falling back to `8420`. The bind address
comes from `RFUTILS_HOST` (default `0.0.0.0`).

**There is no authentication.** The server binds `0.0.0.0` by default, so on an untrusted
network anyone who can reach the port can read your inventory and — via `/api/program` —
send commands to real receivers. Bind to `127.0.0.1` or firewall the port outside a trusted
production network.

Request bodies are JSON (limit 10 MB) unless marked *multipart*. Uploads use field name
`file`, limit 25 MB.

---

## Health

### `GET /health`
Liveness check. Note this is at the root, **not** under `/api`.

```json
{ "status": "ok" }
```

---

## File conversion

### `POST /api/convert` *(multipart)*
Parse an uploaded coordination file (WSM, WWB or generic CSV) into the internal model.

| Field | Type | Notes |
|---|---|---|
| `file` | file | **Required.** UTF-8 text; a leading BOM is stripped. |
| `mapping` | string (JSON) | Optional column mapping for generic CSV. |

For generic CSV the response also carries the detected header and a suggested column
mapping, so the UI can offer a column-map dialog. When none of the headers can be guessed
and no `mapping` was supplied, the list comes back empty rather than as an error — the
dialog is how the caller gets out of that — while a `mapping` that maps neither a name nor
a frequency column fails with `422`.

`400` if no file was uploaded under the field name `file`; `415` if the file is a PDF
(recognised by content, not by name) — those go to `/api/pmse/convert`.

### `POST /api/detect` *(multipart)*
Identify a file's format without fully parsing it.

```json
{ "format": "<detected format>" }
```

A PDF is reported as `pmse-pdf` from its bytes (the `%PDF-` header within the first KiB);
every other format is detected from the decoded text. `400` if no file was uploaded.

### `POST /api/export`
Render a coordination list into one of the supported export formats.

```json
{ "list": { /* CoordinationList */ }, "format": "<ExportFormat>" }
```

Valid values for `format` are the members of `EXPORT_FORMATS` in `@rfutils/shared`. `400`
if `list` or `format` is missing or the format is unknown.

### `POST /api/pmse/convert` *(multipart)*
Convert an Ofcom PMSE licence schedule PDF into importable frequency data. The upload is
accepted as a PDF if its bytes say so, or failing that if its MIME type or `.pdf` name does —
a licence with no extension is fine.

`400` for a missing file or one that is not a PDF by any of those tests; **`422` when the PDF
parses but isn't a recognisable PMSE licence schedule** — that distinction matters, since it
separates "you sent nothing" from "this isn't the document you think it is".

---

## Coordination

### `POST /api/coordinate`
Calculate a set of intermodulation-clean frequencies.

```json
{ "count": 12, "params": { /* CoordinationParams */ }, "names": ["Lead vocal", "..."] }
```

`names` is optional. `400` for a missing/invalid `count` or `params`; `500` if the
coordination engine fails.

### `POST /api/analyze`
Analyse an existing set of frequencies rather than generating one — for checking a
coordination you already hold.

```json
{ "frequencies": [606.125, 610.500], "params": { /* CoordinationParams */ } }
```

---

## Reference data

### `GET /api/profiles`
The device-profile catalog.

### `GET /api/plugins`
```json
{ "plugins": [ /* ... */ ] }
```

---

## Inventory

### `GET /api/inventory`
The stored inventory.

### `PUT /api/inventory`
Replace the inventory. **This is a whole-collection replace, not a merge** — omitted items
are deleted.

```json
{ "items": [ /* InventoryItem[] */ ] }
```

---

## Programming real receivers

### `POST /api/program`
Push frequency assignments to physical receivers.

```json
{ "targets": [ /* ... */ ], "dryRun": true }
```

> **`dryRun` defaults to `true`.** The check is `req.body?.dryRun !== false`, so the only
> way to actually transmit is to send `"dryRun": false` explicitly. Anything else —
> omitted, `true`, `null`, `"false"` as a string — is treated as a dry run.
>
> This is deliberate: `dryRun: false` sends commands to hardware that may be in use on a
> live show. Keep the default that way.

Transport is inferred from each device-channel id's vendor prefix: `shure` →
`shure-command-strings`, `lectrosonics` → `lectrosonics-net`, anything else → `none`.

---

## Monitoring

### `GET /api/devices`
Snapshot of currently discovered devices.

```json
{ "devices": [ /* ... */ ] }
```

### `GET /api/audio/mode`
```json
{ "mode": "<audio mode>", "cueBusConfigured": true }
```

---

## Companion / crosspoint control

### `GET /api/companion/status`
### `POST /api/companion/make-crosspoint`
### `POST /api/companion/clear-crosspoint`

Both `POST`s take a `CrosspointRequest` body and return `{ "ok": true }` on success, `400`
on a malformed request.

---

## WebSocket endpoints

Two WebSocket endpoints share the single HTTP server, with upgrades routed by path:

| Path | Purpose |
|---|---|
| `/ws` | Server-to-client events (`ServerToClientEvent`) — device state, discovery updates |
| `/ws/audio` | Audio streaming (`AudioClientMessage` / `AudioServerMessage`) |

They are wired with a single `WebSocketServer({ noServer: true })` and manual upgrade
routing. This is deliberate and worth preserving: **passing `{ server, path }` to two
separate `WebSocketServer` instances makes each reject the other's upgrades with a 400.**

`/ws` broadcasts to all connected clients.

---

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `RFUTILS_SERVER_PORT` | `8420` | Server port (checked before `PORT`) |
| `PORT` | — | Fallback port |
| `RFUTILS_HOST` | `0.0.0.0` | Bind address |
| `RFUTILS_DISABLE_MONITOR` | unset | Set to `1` to disable device monitoring |
| `RFUTILS_MOCK_DEVICES` | unset | Set to `1` for simulated devices |
| `RFUTILS_CAPTURE_CMD` | — | External audio capture command |

## Static hosting

In production the server serves the built web UI from `packages/web/dist` if present, with
an SPA catch-all. In development Vite serves the UI and proxies to the server instead.
