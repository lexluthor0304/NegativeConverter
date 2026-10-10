#!/usr/bin/env bash
# OpenCV.js with WASM SIMD (#292): the same OpenCV tag, module list and
# build recipe as the shipped @techstark/opencv-js package, plus `--simd`.
#
# The package (5.0.0-release.1) is TechStark/opencv-js's build-opencv-js.yml:
# opencv/opencv at tag 5.0.0, `emcmake python3 platforms/js/build_js.py
# build_js --cmake_option="-DCMAKE_CXX_STANDARD=17"` (no --simd, no --threads,
# the default module whitelist), the UMD output patched with
# dist/opencv.js.patch (this -> globalThis, `var Module`). This script runs
# the same recipe with `--simd` (-msimd128 and CV_ENABLE_INTRINSICS=ON) and
# `--disable_single_file` (the app serves the wasm as its own file anyway),
# then scripts/opencv-simd-assets.mjs applies the package's two patches and
# the app's hook patch to the glue and writes, under
# negative2positive/public/codecs/:
#   opencv-simd.wasm, opencv-simd-glue.js, opencv-simd-build-info.txt,
#   opencv-LICENSE.txt (OpenCV's Apache-2.0 licence from the checkout)
# Threads stay out: the macOS app has no SharedArrayBuffer
# (docs/cross-origin-isolation.md).
#
# Pinned: OpenCV 5.0.0, Emscripten 6.0.4 (as LensfunWasm; the package used
# 4.0.20). Needs emcc/emcmake/em-config in PATH, cmake, make, python3, git,
# node. About 1.5 GB of disk in the build directory and 20-60 min at -j4.
#
#   scripts/build-opencv-js.sh [--build-dir DIR] [--jobs N] [--from PHASE] [--clean]
#     --build-dir DIR  where the source checkout and build tree go
#                      (default $OPENCV_JS_BUILD_DIR or ./.opencv-js-build)
#     --jobs N         make -j (default $OPENCV_JS_JOBS or the core count)
#     --from PHASE     resume at source | configure | build | package
#     --clean          remove the build tree first (keeps the checkout)
#   OPENCV_JS_ALLOW_EMCC=1 accepts another Emscripten version (not for a
#   committed build).
set -euo pipefail

OPENCV_TAG="${OPENCV_TAG:-5.0.0}"
OPENCV_REPO="${OPENCV_REPO:-https://github.com/opencv/opencv.git}"
EMSCRIPTEN_VERSION="${EMSCRIPTEN_VERSION:-6.0.4}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${OPENCV_JS_BUILD_DIR:-$REPO_ROOT/.opencv-js-build}"
JOBS="${OPENCV_JS_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"
FROM=source
CLEAN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --build-dir) BUILD_DIR="$2"; shift 2 ;;
    --jobs) JOBS="$2"; shift 2 ;;
    --from) FROM="$2"; shift 2 ;;
    --clean) CLEAN=1; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
case "$FROM" in source|configure|build|package) ;; *) echo "--from must be source|configure|build|package" >&2; exit 2 ;; esac
phase_at_or_after() { # phase_at_or_after PHASE: true when PHASE is not before --from
  local order="source configure build package" a b
  a=$(echo "$order" | tr ' ' '\n' | grep -nx "$FROM" | cut -d: -f1)
  b=$(echo "$order" | tr ' ' '\n' | grep -nx "$1" | cut -d: -f1)
  [ "$b" -ge "$a" ]
}

log() { printf '[build-opencv-js %s] %s\n' "$(date +%H:%M:%S)" "$*"; }
started=$SECONDS

# ---- toolchain --------------------------------------------------------------
for tool in emcc emcmake em-config cmake make python3 git node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool" >&2; exit 1; }
done
EMCC_VERSION_LINE="$(emcc --version | head -n 1)"
EMCC_VERSION="$(printf '%s' "$EMCC_VERSION_LINE" | sed -E 's/.* ([0-9]+\.[0-9]+\.[0-9]+)(-git)?.*/\1/')"
if [ "$EMCC_VERSION" != "$EMSCRIPTEN_VERSION" ] && [ "${OPENCV_JS_ALLOW_EMCC:-0}" != 1 ]; then
  echo "emcc is $EMCC_VERSION, this build pins Emscripten $EMSCRIPTEN_VERSION (OPENCV_JS_ALLOW_EMCC=1 overrides)" >&2
  exit 1
fi
EMSCRIPTEN_ROOT="$(em-config EMSCRIPTEN_ROOT)"
WASM_OPT="$EMSCRIPTEN_ROOT/binaryen/bin/wasm-opt"
[ -x "$WASM_OPT" ] || WASM_OPT="$(command -v wasm-opt || true)"
log "emcc $EMCC_VERSION ($EMSCRIPTEN_ROOT), $(cmake --version | head -n 1), $(python3 --version), node $(node --version), jobs $JOBS"
log "build dir $BUILD_DIR"

SRC="$BUILD_DIR/opencv"
OUT="$BUILD_DIR/build_js"
mkdir -p "$BUILD_DIR"
if [ "$CLEAN" = 1 ]; then log "removing $OUT"; rm -rf "$OUT"; fi

# ---- source -----------------------------------------------------------------
if phase_at_or_after source && [ ! -d "$SRC/.git" ]; then
  log "cloning opencv at tag $OPENCV_TAG"
  git clone --quiet --depth 1 --branch "$OPENCV_TAG" "$OPENCV_REPO" "$SRC"
fi
[ -d "$SRC/.git" ] || { echo "no checkout at $SRC (run without --from, or with --from source)" >&2; exit 1; }
OPENCV_COMMIT="$(git -C "$SRC" rev-parse HEAD)"
if ! git -C "$SRC" describe --tags --exact-match HEAD 2>/dev/null | grep -qx "$OPENCV_TAG"; then
  echo "the checkout at $SRC is not at tag $OPENCV_TAG" >&2; exit 1
fi
log "opencv $OPENCV_TAG = $OPENCV_COMMIT"

# ---- configure --------------------------------------------------------------
# build_js.py's own cmake line (CPU_BASELINE and CPU_DISPATCH empty, the
# module switches, BUILD_opencv_js=ON) plus, for --simd, -msimd128 and
# CV_ENABLE_INTRINSICS=ON. emcmake appends the toolchain file. C++17 as the
# package's build; CMAKE_POLICY_VERSION_MINIMUM lets CMake 4 configure the
# bundled third-party projects.
CMAKE_OPTIONS=(-DCMAKE_CXX_STANDARD=17 -DCMAKE_POLICY_VERSION_MINIMUM=3.5)
if phase_at_or_after configure; then
  log "configuring (build_js.py --simd --disable_single_file --config_only)"
  mkdir -p "$OUT"
  args=()
  for option in "${CMAKE_OPTIONS[@]}"; do args+=("--cmake_option=$option"); done
  (cd "$BUILD_DIR" && emcmake python3 "$SRC/platforms/js/build_js.py" "$OUT" \
    --opencv_dir "$SRC" --emscripten_dir "$EMSCRIPTEN_ROOT" \
    --simd --disable_single_file --config_only "${args[@]}")
fi
[ -f "$OUT/CMakeCache.txt" ] || { echo "no configured build at $OUT (run --from configure)" >&2; exit 1; }

# ---- build ------------------------------------------------------------------
if phase_at_or_after build; then
  log "building opencv.js with make -j$JOBS"
  (cd "$OUT" && make -j"$JOBS" opencv.js)
fi
[ -f "$OUT/bin/opencv.js" ] && [ -f "$OUT/bin/opencv_js.wasm" ] || { echo "no build output under $OUT/bin" >&2; exit 1; }

# ---- package ----------------------------------------------------------------
log "packaging into negative2positive/public/codecs"
node "$REPO_ROOT/scripts/opencv-simd-assets.mjs" \
  --build-dir "$OUT" \
  --out-dir "$REPO_ROOT/negative2positive/public/codecs" \
  --opencv-tag "$OPENCV_TAG" --opencv-commit "$OPENCV_COMMIT" \
  --emcc "$EMCC_VERSION_LINE" \
  --cmake "$(cmake --version | head -n 1)" --python "$(python3 --version)" \
  --cmake-options "${CMAKE_OPTIONS[*]}" \
  --jobs "$JOBS" --wasm-opt "$WASM_OPT" --license "$SRC/LICENSE"
log "done in $(( (SECONDS - started) / 60 )) min; the build tree ($BUILD_DIR) can be deleted"
