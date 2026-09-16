# Signing & notarizing the RFutils desktop app

**Released builds are signed and notarized — there is nothing to do.** CI
builds the launcher for every platform ([`release-desktop.yml`](../.github/workflows/release-desktop.yml))
and publishes the macOS `.dmg` and `.pkg` ad-hoc signed; within minutes the
maintainer's Mac signs them with the Developer ID Application identity,
notarizes them with Apple, staples the ticket and re-uploads them in place.
The Developer ID key never leaves that machine, so no signing secret exists
in this repository and none is needed to cut a release. A downloaded release
opens with a normal double-click; `spctl -a -vv -t install <file>` reports
`Notarized Developer ID`.

The rest of this page is only about a copy **you build yourself**.

## A self-built copy is unsigned

`npm run tauri build` on your own machine produces an ad-hoc signed `.app`.
macOS Gatekeeper asks you to right-click → **Open** the first time, and the
app runs — but its **embedded Node runtime does not**. Approving an unsigned
`.app` does not unquarantine the binaries nested inside it, and Gatekeeper
kills those silently, so a self-built RFutils launches and then cannot start
its server. Either clear the quarantine flag after copying it into
`/Applications`:

```bash
xattr -dr com.apple.quarantine "/Applications/RFutils.app"
```

or sign it properly, below.

## Building a signed copy locally

You need a **paid Apple Developer Program** membership and a **Developer ID
Application** certificate in your keychain (the certificate type for
distributing apps *outside* the App Store), plus an app-specific password for
notarization (appleid.apple.com → Sign-In & Security → App-Specific Passwords —
**not** your real Apple ID password).

```bash
cd launcher
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="TEAMID"
npm ci
bash scripts/prepare.sh          # build RFutils + esbuild the server + fetch Node
bash scripts/sign-embedded.sh    # sign the embedded Node with the hardened runtime
npm run tauri build
```

[`scripts/sign-embedded.sh`](scripts/sign-embedded.sh) signs the nested Node
binary with the hardened runtime and
[`src-tauri/entitlements.plist`](src-tauri/entitlements.plist) — a nested
Mach-O that must be signed before the bundle can notarize. `tauri build` then
signs the `.app`, submits it to Apple when the notarization variables are set,
and staples the ticket. The signed `.dmg` lands in
`src-tauri/target/release/bundle/dmg/`.

Find your identity's exact name with `security find-identity -v -p codesigning`.
