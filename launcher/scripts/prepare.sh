#!/usr/bin/env bash
# Assemble the embedded RFutils app for the desktop bundle:
#   - build RFutils (shared + server + web)
#   - esbuild the server into a single ESM file
#   - download a self-contained official Node runtime
#   - lay it all out mirroring packages/{server,web}/dist so the server's
#     import.meta.url-relative paths (templates, web UI) resolve unchanged
#
# Produces src-tauri/node and src-tauri/rfutils-app/ (both git-ignored; they
# ship inside the .app / Release). Run before `npm run tauri build`.
set -euo pipefail

NODE_VERSION="v22.23.1"          # official, links only system frameworks

# Which Node runtime gets embedded.
#
# This used to be hardcoded to darwin-arm64 while the release workflow was
# carefully exporting NODE_PLATFORM per target — which nothing here read. Every
# build except macOS arm64 therefore shipped an Apple Silicon *macOS* binary:
# the published v0.4.3 Linux .deb carried a Mach-O arm64 as usr/lib/RFutils/node,
# and the macOS x86_64 .dmg carried an arm64 node next to an x86_64 app. Those
# builds launch and then cannot start their server at all.
#
# "darwin-universal" fetches BOTH macOS runtimes and lipos them, which is what
# the single universal macOS bundle needs. Falling back to the host keeps a
# plain `bash scripts/prepare.sh` working for local builds.
detect_platform() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    MINGW*|MSYS*|CYGWIN*) os="win" ;;
    *) os="linux" ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    *) arch="x64" ;;
  esac
  echo "${os}-${arch}"
}
ARCH="${NODE_PLATFORM:-$(detect_platform)}"

HERE="$(cd "$(dirname "$0")/.." && pwd)"     # launcher/
REPO="$(cd "$HERE/.." && pwd)"               # RFutils repo root
TAURI="$HERE/src-tauri"
APP="$TAURI/rfutils-app"

echo "==> building RFutils"
( cd "$REPO" && npm install && npm run build )

echo "==> esbuilding server -> single ESM bundle"
BANNER='import{createRequire as __cr}from "module";const require=__cr(import.meta.url);import{fileURLToPath as __f}from "url";import{dirname as __d}from "path";const __filename=__f(import.meta.url);const __dirname=__d(__filename);'
mkdir -p "$APP/packages/web/dist"
( cd "$REPO" && npx --yes esbuild@0.24.0 packages/server/src/index.ts \
    --bundle --platform=node --format=esm --target=node18 \
    --banner:js="$BANNER" \
    --outfile="$APP/packages/server/dist/index.mjs" )

# The .shw templates are NOT copied: gen-templates.mjs inlines them into
# templates.generated.ts at build time, so showGenerator reads no files and the
# bundle needs none. (This used to copy them from packages/server/src/pmse —
# a path that stopped existing when the parsers moved to packages/shared.)
echo "==> copying built web UI"
cp -R "$REPO"/packages/web/dist/. "$APP/packages/web/dist/"

echo "==> fetching self-contained Node $NODE_VERSION for $ARCH"

# Fetch one platform's runtime to an explicit destination. Windows ships a .zip
# holding node.exe; everything else a .tar.gz holding bin/node.
fetch_node() {   # fetch_node <node-platform> <dest>
  local plat="$1" dest="$2" tarball="node-$NODE_VERSION-$1"
  case "$plat" in
    win-*)
      curl -sL "https://nodejs.org/dist/$NODE_VERSION/$tarball.zip" -o "$TAURI/node.zip"
      ( cd "$TAURI" && unzip -qo node.zip )
      cp "$TAURI/$tarball/node.exe" "$dest"
      rm -rf "$TAURI/$tarball" "$TAURI/node.zip"
      ;;
    *)
      curl -sL "https://nodejs.org/dist/$NODE_VERSION/$tarball.tar.gz" -o "$TAURI/node.tar.gz"
      tar xzf "$TAURI/node.tar.gz" -C "$TAURI"
      cp "$TAURI/$tarball/bin/node" "$dest"
      rm -rf "$TAURI/$tarball" "$TAURI/node.tar.gz"
      ;;
  esac
  chmod +x "$dest"
}

# tauri.conf.json bundles resources by the glob "node*", so any intermediate
# left lying about here gets shipped inside the app. Both slices are removed.
if [ "$ARCH" = "darwin-universal" ]; then
  fetch_node darwin-arm64 "$TAURI/node.arm64"
  fetch_node darwin-x64   "$TAURI/node.x64"
  lipo -create "$TAURI/node.arm64" "$TAURI/node.x64" -output "$TAURI/node"
  rm -f "$TAURI/node.arm64" "$TAURI/node.x64"
  chmod +x "$TAURI/node"
  __archs="$( lipo -archs "$TAURI/node" )"
  echo "    embedded node: $__archs"
  case "$__archs" in
    *arm64*) ;;
    *) echo "embedded node has no arm64 slice: $__archs" >&2; exit 1 ;;
  esac
  case "$__archs" in
    *x86_64*) ;;
    *) echo "embedded node has no x86_64 slice: $__archs" >&2; exit 1 ;;
  esac
else
  ext=""
  case "$ARCH" in win-*) ext=".exe" ;; esac
  fetch_node "$ARCH" "$TAURI/node$ext"
  echo "    embedded node: $(file -b "$TAURI/node$ext" 2>/dev/null | head -1)"
fi

echo "prepared: $TAURI/node + $APP (server bundle, templates, web UI)"
