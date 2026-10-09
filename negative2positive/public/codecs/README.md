# Local codecs and engines

## HEIF decoder

libheif-js **1.19.8**, from https://github.com/catdad-experiments/libheif-js
(npm tarball at https://registry.npmjs.org/libheif-js/-/libheif-js-1.19.8.tgz).
The unmodified `libheif.js` and `libheif.wasm` are separately loaded, replaceable
LGPL-3.0 components. The full licence and upstream notices are in
`libheif-LICENSE.txt`. Source and build scripts: the upstream repository, tag
v1.19.8. Replace these two assets together to relink the application with a
modified decoder; no application bundle change is needed.

`heif-worker.js` decodes the primary image only, in a disposable worker. Browser
native decoding is attempted first. All runtime requests are to local assets;
there is no CDN or image upload.

## OpenCV.js, WASM SIMD build (#292)

`opencv-simd.wasm` and `opencv-simd-glue.js` are OpenCV **5.0.0**
(https://github.com/opencv/opencv, tag 5.0.0, Apache-2.0: `opencv-LICENSE.txt`)
built with Emscripten 6.0.4 and `-msimd128`, by `scripts/build-opencv-js.sh`
at the repository root. The recipe is the one that produced the
`@techstark/opencv-js` 5.0.0-release.1 package the app also ships (the
scalar build, split into `assets/opencv-<hash>.wasm` and
`assets/opencv-glue-<hash>.js` at build time by `scripts/opencv-assets.mjs`):
`platforms/js/build_js.py` with the default module whitelist and
`-DCMAKE_CXX_STANDARD=17`, plus `--simd` and `--disable_single_file`, the
package's two UMD patches on the glue and the app's hook tail
(`return cv(globalThis.__opencvModuleArg || {})`). No threads: the macOS app
has no SharedArrayBuffer. `opencv-simd-build-info.txt` records the OpenCV
commit, the toolchain, the command, both files' SHA-256, how many functions
use v128 instructions, and `cv.getBuildInformation()` of the module;
`src/app/opencvAssets.test.mjs` holds the files to it.

Which build a page runs is decided once by `src/app/opencvRuntime.js`
(`chooseOpenCvVariant`): the SIMD build where `WebAssembly.validate` accepts a
v128 module, the scalar build elsewhere or with `?opencvSimd=0`; the page
compiles the module once and hands it, with the variant, to every OpenCV
worker. Replace the three OpenCV files together (rebuild with the script);
`check-dist-asset-names.mjs` does not cover them, and their names are fixed,
so a rebuilt module is picked up by returning browsers at the next
revalidation like the HEIF files.
