#!/usr/bin/env bash
# Rebuild the static OpenMP runtime the macOS desktop app links for its native
# LibRaw decoder (#264 part C): LLVM libomp as a universal static archive,
# x86_64 for macOS 10.15 (tauri.conf.json minimumSystemVersion) and arm64 for
# macOS 11.0 (the first arm64 release). The result is committed under
# src-tauri/vendor/libomp/macos; src-tauri/native/build_libraw.rs links it.
#
#   scripts/build-libomp-macos.sh            # download, verify, build, install
#   LLVM_TARBALL=/path/llvm-project-22.1.8.src.tar.xz scripts/build-libomp-macos.sh
#
# Needs cmake and python3 (Homebrew or Xcode), no network with LLVM_TARBALL.
set -euo pipefail
cd "$(dirname "$0")/.."

LLVM_VERSION=22.1.8
LLVM_SHA256=922f1817a0df7b1489272d18134ee0087a8b068828f87ac63b9861b1a9965888
DEST=src-tauri/vendor/libomp/macos
TMP_ROOT="${TMPDIR:-/tmp}"
WORK="${TMP_ROOT%/}/nc-libomp-$LLVM_VERSION"
TARBALL="${LLVM_TARBALL:-$WORK/llvm-project-$LLVM_VERSION.src.tar.xz}"

mkdir -p "$WORK"
if [ ! -f "$TARBALL" ]; then
  echo "==> Downloading llvm-project $LLVM_VERSION source"
  curl -fL -o "$TARBALL" \
    "https://github.com/llvm/llvm-project/releases/download/llvmorg-$LLVM_VERSION/llvm-project-$LLVM_VERSION.src.tar.xz"
fi
echo "$LLVM_SHA256  $TARBALL" | shasum -a 256 -c -

SRC="$WORK/llvm-project-$LLVM_VERSION.src"
if [ ! -d "$SRC/openmp" ]; then
  echo "==> Extracting openmp and cmake"
  tar -xJf "$TARBALL" -C "$WORK" \
    "llvm-project-$LLVM_VERSION.src/openmp" \
    "llvm-project-$LLVM_VERSION.src/cmake" \
    "llvm-project-$LLVM_VERSION.src/LICENSE.TXT"
fi

build_arch() {
  local arch="$1" minos="$2"
  echo "==> Building libomp for $arch (macOS $minos)"
  ZERO_AR_DATE=1 cmake -S "$SRC/openmp" -B "$WORK/build-$arch" -G "Unix Makefiles" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_ARCHITECTURES="$arch" \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$minos" \
    -DCMAKE_C_FLAGS="-ffile-prefix-map=$WORK=." \
    -DCMAKE_CXX_FLAGS="-ffile-prefix-map=$WORK=." \
    -DCMAKE_ASM_FLAGS="-ffile-prefix-map=$WORK=." \
    -DLIBOMP_ENABLE_SHARED=OFF \
    -DOPENMP_ENABLE_LIBOMPTARGET=OFF \
    -DLIBOMP_OMPT_SUPPORT=OFF \
    -DLIBOMP_OMPD_SUPPORT=OFF \
    -DLIBOMP_USE_HWLOC=OFF \
    -DLIBOMP_INSTALL_ALIASES=OFF \
    -DOPENMP_ENABLE_OMPT_TOOLS=OFF \
    -DLIBOMP_FORTRAN_MODULES=OFF \
    -DOPENMP_ENABLE_WERROR=OFF >/dev/null
  ZERO_AR_DATE=1 cmake --build "$WORK/build-$arch" --target omp -j "$(sysctl -n hw.ncpu)" >/dev/null
}

build_arch x86_64 10.15
build_arch arm64 11.0

mkdir -p "$DEST/lib" "$DEST/include"
lipo -create "$WORK/build-x86_64/runtime/src/libomp.a" "$WORK/build-arm64/runtime/src/libomp.a" \
  -output "$DEST/lib/libomp.a"
cp "$WORK/build-arm64/runtime/src/omp.h" "$DEST/include/omp.h"
cp "$SRC/openmp/LICENSE.TXT" "$DEST/LICENSE.TXT"

lipo -info "$DEST/lib/libomp.a"
shasum -a 256 "$DEST/lib/libomp.a" "$DEST/include/omp.h"
echo "Record the hashes above in src-tauri/vendor/README.md."
