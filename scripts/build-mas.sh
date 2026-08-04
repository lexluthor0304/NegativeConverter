#!/usr/bin/env bash
# Build a Mac App Store package (.pkg) ready for upload via Transporter.
#
# Prerequisites (one-time):
#   - "Apple Distribution: NEO ANALOG LABO K.K. (X93Y44J36C)" in login keychain
#   - "3rd Party Mac Developer Installer: NEO ANALOG LABO K.K. (X93Y44J36C)" in login keychain
#   - src-tauri/embedded.provisionprofile (Mac App Store provisioning profile)
#   - rustup targets: aarch64-apple-darwin + x86_64-apple-darwin
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="Negative Converter"
TARGET_DIR="src-tauri/target/universal-apple-darwin/release/bundle/macos"
APP_PATH="$TARGET_DIR/$APP_NAME.app"
PKG_PATH="$TARGET_DIR/NegativeConverter-appstore.pkg"
SIGN_PKG="${APPLE_INSTALLER_SIGNING_IDENTITY:-3rd Party Mac Developer Installer: NEO ANALOG LABO K.K. (X93Y44J36C)}"

if [ ! -f src-tauri/embedded.provisionprofile ]; then
  echo "error: src-tauri/embedded.provisionprofile not found." >&2
  echo "Download the Mac App Store provisioning profile from developer.apple.com and place it there." >&2
  exit 1
fi

echo "==> Ensuring rust targets for universal build"
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null

echo "==> Building web assets"
npm run build:web

echo "==> Building universal .app with App Store config"
npx tauri build --bundles app --target universal-apple-darwin \
  --config src-tauri/tauri.appstore.conf.json

echo "==> Verifying bundle"
test -f "$APP_PATH/Contents/embedded.provisionprofile" \
  || { echo "error: embedded.provisionprofile missing from bundle" >&2; exit 1; }
codesign --verify --deep --strict "$APP_PATH"
codesign -d --entitlements :- "$APP_PATH" 2>/dev/null | grep -q "com.apple.security.app-sandbox" \
  || { echo "error: app-sandbox entitlement missing" >&2; exit 1; }

echo "==> Building signed installer package"
xcrun productbuild --sign "$SIGN_PKG" \
  --component "$APP_PATH" /Applications "$PKG_PATH"

echo ""
echo "Done: $PKG_PATH"
echo "Upload it with the Transporter app (Mac App Store) after creating the app record in App Store Connect."
echo "Remember: bump \"version\" in src-tauri/tauri.conf.json before each new upload."
