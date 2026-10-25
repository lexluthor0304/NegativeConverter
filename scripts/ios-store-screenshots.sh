#!/usr/bin/env bash
# App Store screenshots from the iOS Simulator (ios-ci.yml "Store screenshots").
#
# Needs a *self-test* simulator build: NC_P0_FIXTURES=1 for both `npm run
# build:web` and `tauri ios build`, with negative2positive/public/p0-fixtures/
# holding the fixture negative and a plan.json that sets "screenshot": true
# (p0SelfTest.js). For each required family it boots a simulator, captures the
# import screen, relaunches with NC_P0_SELFTEST=1 so the self-test imports and
# converts the fixture, waits for its `screenshot-ready` event, captures the
# editor, strips the alpha channel (scripts/png-to-rgb.mjs) and checks the
# pixel size App Store Connect expects (fastlane/ios/screenshots/README.md).
#
#   APP=<path to the .app> OUT=output/ios-store-screenshots bash scripts/ios-store-screenshots.sh
set -euo pipefail

APP="${APP:?path to the simulator .app}"
OUT="${OUT:-output/ios-store-screenshots}"
BUNDLE="${BUNDLE:-com.neoanaloglab.negativeconverter}"
WAIT_SECONDS="${WAIT_SECONDS:-300}"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"

# pick_device <label> <device name>...: the UDID of the first available
# simulator with one of the names, else one created from that device type.
pick_device() {
  local label="$1" name udid
  shift
  for name in "$@"; do
    udid="$(xcrun simctl list devices available -j \
      | jq -r --arg n "$name" '.devices | to_entries[] | select(.key | contains("iOS")) | .value[] | select(.name == $n) | .udid' \
      | head -n 1)"
    if [ -n "$udid" ]; then
      echo "$udid"
      return 0
    fi
  done
  for name in "$@"; do
    if udid="$(xcrun simctl create "nc-$label" "$name" 2>/dev/null)"; then
      echo "$udid"
      return 0
    fi
  done
  echo "no simulator available for: $*" >&2
  xcrun simctl list devices available >&2 || true
  return 1
}

# capture <family> <udid> <WxH>: <family>-01-editor.png and <family>-02-import.png
capture() {
  local family="$1" udid="$2" expected="$3"
  local container log shot raw base size waited=0
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b
  xcrun simctl ui "$udid" appearance dark || true
  xcrun simctl status_bar "$udid" override --time "9:41" --dataNetwork wifi --wifiMode active --wifiBars 3 \
    --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100 || true
  xcrun simctl uninstall "$udid" "$BUNDLE" 2>/dev/null || true
  xcrun simctl install "$udid" "$APP"

  # The import screen: a plain launch, no self-test.
  xcrun simctl launch "$udid" "$BUNDLE" >/dev/null
  sleep "${IMPORT_SCREEN_SECONDS:-15}"
  xcrun simctl io "$udid" screenshot --type png "$OUT/$family-02-import.raw.png"
  xcrun simctl terminate "$udid" "$BUNDLE" || true
  sleep 2

  # The editor with the converted fixture: the self-test imports it and logs
  # screenshot-ready (p0SelfTest.js) to Documents/p0-diagnostics.log (lib.rs).
  container="$(xcrun simctl get_app_container "$udid" "$BUNDLE" data)"
  log="$container/Documents/p0-diagnostics.log"
  rm -f "$log"
  SIMCTL_CHILD_NC_P0_SELFTEST=1 xcrun simctl launch "$udid" "$BUNDLE" >/dev/null
  until [ -f "$log" ] && grep -q '"event":"screenshot-ready"' "$log"; do
    if [ -f "$log" ] && grep -q -E '"event":"(fatal|import-failed)"' "$log"; then
      echo "self-test failed on $family:" >&2
      tail -n 30 "$log" >&2
      return 1
    fi
    if [ "$waited" -ge "$WAIT_SECONDS" ]; then
      echo "timed out after ${WAIT_SECONDS}s waiting for the $family editor" >&2
      [ -f "$log" ] && tail -n 30 "$log" >&2
      return 1
    fi
    sleep 2
    waited=$((waited + 2))
  done
  sleep 2
  xcrun simctl io "$udid" screenshot --type png "$OUT/$family-01-editor.raw.png"
  cp "$log" "$OUT/$family-self-test.log" || true
  xcrun simctl terminate "$udid" "$BUNDLE" || true
  xcrun simctl shutdown "$udid" || true

  for raw in "$OUT/$family-"*.raw.png; do
    base="${raw%.raw.png}.png"
    node "$HERE/png-to-rgb.mjs" "$raw" "$base"
    rm -f "$raw"
    size="$(sips -g pixelWidth -g pixelHeight "$base" | awk '/pixelWidth/ {w=$2} /pixelHeight/ {h=$2} END {print w "x" h}')"
    if [ "$size" != "$expected" ]; then
      echo "$base is ${size}, expected ${expected} for ${family}" >&2
      return 1
    fi
  done
}

IPHONE="$(pick_device iphone "iPhone 17 Pro" "iPhone 16 Pro")"
IPAD="$(pick_device ipad "iPad Pro 13-inch (M5)" "iPad Pro 13-inch (M4)")"
capture iphone-medium "$IPHONE" 1206x2622
capture ipad13 "$IPAD" 2064x2752
ls -la "$OUT"
