#!/usr/bin/env bash
# Builds the deterministic LibRaw-Wasm with its optional multi-threaded module
# (#302): the branch of ybouane/LibRaw-Wasm#30 at a pinned commit, vendored as
# negative2positive/vendor/libraw-wasm. The app imports that directory as
# `libraw-wasm` (package.json: "file:negative2positive/vendor/libraw-wasm").
# Upstream has not released the branch on npm; once a release decodes to the
# same bytes, the dependency goes back to the npm package.
#
#   bash scripts/build-libraw-wasm.sh
#
# Needs Emscripten 6.0.4 (the version the PR pins), git, node and npm,
# autotools (autoreconf, and libtoolize or glibtoolize) and network access:
# the commit below, then LibRaw 0.22.1 and Little-CMS 2.19.1, which
# compileLibraw.sh clones. It writes dist/, package.json and BUILD-INFO.txt;
# commit them together. Rebuilding the same commit gives the same bytes
# (the PR's build is deterministic; BUILD-INFO.txt has the hashes to compare).
set -euo pipefail

REPO=https://github.com/lexluthor0304/LibRaw-Wasm.git
COMMIT=45b40c07e08f46a3330a7aa2945f5d389daf592a
EMSCRIPTEN=6.0.4
VERSION="1.6.0-deterministic.${COMMIT:0:7}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/negative2positive/vendor/libraw-wasm"

if ! emcc --version 2>/dev/null | head -1 | grep -q " ${EMSCRIPTEN}"; then
  echo "Emscripten ${EMSCRIPTEN} is required (emcc --version: $(emcc --version 2>/dev/null | head -1))" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git clone --quiet --filter=blob:none "$REPO" "$WORK/src"
git -C "$WORK/src" checkout --quiet "$COMMIT"
(
  cd "$WORK/src"
  npm ci --ignore-scripts --no-audit --no-fund
  FORCE_LIBS=1 bash compileLibraw.sh
  node build.js
)

rm -rf "$OUT/dist"
mkdir -p "$OUT/dist"
cp "$WORK/src"/dist/* "$OUT/dist/"

node --input-type=module - "$WORK/src/package.json" "$OUT/package.json" "$VERSION" "$COMMIT" "$REPO" <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs';
const [from, to, version, commit, repo] = process.argv.slice(2);
const upstream = JSON.parse(readFileSync(from, 'utf8'));
const pkg = {
  name: upstream.name,
  version,
  description: `${upstream.description || 'LibRaw compiled to WebAssembly'} (deterministic build with the optional multi-threaded module; ybouane/LibRaw-Wasm#30 at ${commit.slice(0, 7)}, built by scripts/build-libraw-wasm.sh)`,
  type: upstream.type,
  main: upstream.main,
  types: upstream.types,
  license: upstream.license,
  repository: { type: 'git', url: repo },
  gitHead: commit,
  files: upstream.files,
};
writeFileSync(to, JSON.stringify(pkg, null, 2) + '\n');
EOF

{
  echo "libraw-wasm ${VERSION} (#302)"
  echo "source:     ${REPO} @ ${COMMIT} (ybouane/LibRaw-Wasm#30)"
  echo "            LibRaw 0.22.1, Little-CMS 2.19.1, libjpeg 9f (Emscripten port), musl 1.2.6 math (portable-math/)"
  echo "toolchain:  $(emcc --version | head -1)"
  echo "            node $(node --version), esbuild from the commit's package-lock.json"
  echo "built by:   scripts/build-libraw-wasm.sh (FORCE_LIBS=1 bash compileLibraw.sh && node build.js)"
  echo
  echo "file                          sha256"
  (cd "$OUT" && for f in dist/*; do printf '%-29s %s\n' "$f" "$(shasum -a 256 "$f" | cut -d' ' -f1)"; done)
} > "$OUT/BUILD-INFO.txt"

cat "$OUT/BUILD-INFO.txt"
