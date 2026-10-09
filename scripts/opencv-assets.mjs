// OpenCV.js as a separate wasm file and a small glue script (#252 part 5).
//
// @techstark/opencv-js ships one 13 MB script: a ~128 KB Emscripten glue with
// the 12 MB wasm module embedded as a string literal that the glue decodes
// (`binaryDecode`) and instantiates. Every realm that imported it (the page,
// each OpenCV worker) parsed, decoded and compiled all of it again. This
// plugin splits the installed package, byte for byte, at dev and build time:
//
// - `opencv-<hash>.wasm`: the embedded literal decoded once with the
//   package's own `binaryDecode` (so a realm can compile it with
//   WebAssembly.compileStreaming, or instantiate a Module another realm
//   compiled, see app/opencvModule.js);
// - `opencv-glue-<hash>.js`: the package script without the literal, its
//   UMD tail patched to call the factory with `globalThis.__opencvModuleArg`,
//   whose `instantiateWasm` hook the package already honours. The hoisted
//   `var Module` of the original tail shadowed any outer Module, so the hook
//   was unreachable without this one-line patch.
//
// There is no rebuilt or slimmed OpenCV and no version change for this
// scalar variant: the emitted wasm is the package's module
// (opencvAssets.test.mjs pins its SHA-256 to what the unmodified package
// instantiates), and Node tests keep importing the original file.
//
// The SIMD variant (#292) is the same OpenCV built with -msimd128
// (scripts/build-opencv-js.sh), committed under public/codecs/ as
// opencv-simd.wasm + opencv-simd-glue.js (its glue patched the same way,
// scripts/opencv-simd-assets.mjs) next to its build information. It is
// served from there as the HEIF codec is; the page picks the variant once
// (app/opencvRuntime.js chooseOpenCvVariant) and tells the workers. The app
// imports the four URLs from the virtual module `virtual:opencv-assets`.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

export const OPENCV_VIRTUAL_ID = 'virtual:opencv-assets';
const RESOLVED_ID = '\0' + OPENCV_VIRTUAL_ID;
const DEV_PREFIX = '/@opencv-assets/';

const LITERAL_HEAD = 'function findWasmBinary(){return binaryDecode(';
const ORIGINAL_TAIL = /\n\s*if \(typeof Module === 'undefined'\)\n\s*var Module = \{\};\n\s*return cv\(Module\);\n\}\)\);\s*$/;
const PATCHED_TAIL = '\n  return cv(globalThis.__opencvModuleArg || {});\n}));\n';

// The SIMD variant's files, relative to negative2positive/public (served at
// <base>/codecs/...). The names are fixed: a rebuild replaces the files.
export const OPENCV_SIMD_ASSETS = Object.freeze({
  wasm: 'codecs/opencv-simd.wasm',
  glue: 'codecs/opencv-simd-glue.js',
  buildInfo: 'codecs/opencv-simd-build-info.txt'
});

export function openCvPackagePath() {
  return createRequire(import.meta.url).resolve('@techstark/opencv-js/dist/opencv.js');
}

/** Absolute paths of the committed SIMD files under `publicDir`. */
export function openCvSimdPaths(publicDir = fileURLToPath(new URL('../negative2positive/public', import.meta.url))) {
  return {
    wasm: resolve(publicDir, OPENCV_SIMD_ASSETS.wasm),
    glue: resolve(publicDir, OPENCV_SIMD_ASSETS.glue),
    buildInfo: resolve(publicDir, OPENCV_SIMD_ASSETS.buildInfo)
  };
}

// What build_js.py's make_umd.py wraps the SIMD build in, before the two
// patches the package applies (dist/opencv.js.patch: `this` -> `globalThis`
// for ESM pages, `var Module` for strict-mode bundlers) and the app's hook
// patch above. The wasm file name is the build's: the glue only reads it
// when no instantiateWasm hook is installed.
const UMD_ROOT_CALL = '}(this, function () {';
const UMD_ROOT_CALL_PATCHED = '}(globalThis, function () {';
const BUILD_TAIL = /\n\s*if \(typeof Module === 'undefined'\)\n\s*Module = \{\};\n\s*return cv\(Module\);\n\}\)\);\s*$/;
const BUILD_WASM_NAME = /(['"])opencv_js\.wasm\1/g;

/**
 * Patches a `--disable_single_file` build's `bin/opencv.js` (the UMD glue)
 * into the app's SIMD glue: the package's two UMD patches, the hook tail
 * and the committed wasm file name. Throws when the glue is not the shape
 * make_umd.py and Emscripten produced for this recipe.
 */
export function patchOpenCvSimdGlue(source, { wasmName = 'opencv-simd.wasm' } = {}) {
  const root = source.indexOf(UMD_ROOT_CALL);
  if (root < 0 || source.indexOf(UMD_ROOT_CALL, root + 1) >= 0) throw new Error('opencv-simd glue: expected one UMD root call `}(this, function () {`');
  if (!BUILD_TAIL.test(source)) throw new Error('opencv-simd glue: unexpected UMD tail');
  if (/binaryDecode\(/.test(source)) throw new Error('opencv-simd glue: the wasm is embedded (built without --disable_single_file)');
  const names = source.match(BUILD_WASM_NAME);
  if (!names || names.length < 1) throw new Error('opencv-simd glue: the wasm file name opencv_js.wasm is not referenced');
  return source.slice(0, root) + UMD_ROOT_CALL_PATCHED + source.slice(root + UMD_ROOT_CALL.length)
    .replace(BUILD_TAIL, PATCHED_TAIL)
    .replace(BUILD_WASM_NAME, `'${wasmName}'`);
}

/** The SIMD glue's shape the app relies on (both patches and the hook tail). */
export function assertOpenCvSimdGlue(glue) {
  if (!glue.includes(UMD_ROOT_CALL_PATCHED)) throw new Error('opencv-simd glue: UMD root call not patched to globalThis');
  if (!glue.trimEnd().endsWith(PATCHED_TAIL.trim())) throw new Error('opencv-simd glue: hook tail missing');
  if (/\bvar Module = \{\};/.test(glue) || /\n\s*Module = \{\};/.test(glue)) throw new Error('opencv-simd glue: the shadowing Module is still there');
  if (BUILD_WASM_NAME.test(glue)) throw new Error('opencv-simd glue: still names opencv_js.wasm');
  BUILD_WASM_NAME.lastIndex = 0;
}

// The end of the single-quoted literal that starts at `start` (its opening
// quote), honouring backslash escapes.
function literalEnd(source, start) {
  for (let i = start + 1; i < source.length; i++) {
    const c = source.charCodeAt(i);
    if (c === 0x5c) { i++; continue; }
    if (c === 0x27) return i;
  }
  throw new Error('opencv.js: unterminated wasm literal');
}

/**
 * Splits the package script. Returns `{ wasm: Uint8Array, glue: string,
 * wasmHash, glueHash }` (hashes: the first 8 hex digits of the SHA-256).
 * Throws when the package layout is not the one this patch was written for,
 * so an OpenCV update fails the build instead of shipping a broken glue.
 */
export function extractOpenCvAssets(source) {
  const head = source.indexOf(LITERAL_HEAD);
  if (head < 0 || source.indexOf(LITERAL_HEAD, head + 1) >= 0) throw new Error('opencv.js: expected one embedded wasm literal');
  const open = head + LITERAL_HEAD.length;
  if (source[open] !== "'") throw new Error('opencv.js: the wasm literal is not a single-quoted string');
  const close = literalEnd(source, open);
  if (source.slice(close + 1, close + 3) !== ')}') throw new Error('opencv.js: unexpected findWasmBinary shape');
  // The package's own decoder, and the literal's value as the JS parser reads it.
  const decoderSource = /function binaryDecode\(bin\)\{[^}]*\}return o\}/.exec(source)?.[0];
  if (!decoderSource) throw new Error('opencv.js: binaryDecode not found');
  const binaryDecode = vm.runInNewContext(`(${decoderSource})`);
  const text = vm.runInNewContext(source.slice(open, close + 1));
  const wasm = new Uint8Array(binaryDecode(text));
  if (wasm[0] !== 0 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d) throw new Error('opencv.js: the decoded literal is not a wasm module');
  const stripped = source.slice(0, open) + "''" + source.slice(close + 1);
  if (!ORIGINAL_TAIL.test(stripped)) throw new Error('opencv.js: unexpected UMD tail');
  const glue = stripped.replace(ORIGINAL_TAIL, PATCHED_TAIL);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 8);
  return { wasm, glue, wasmHash: hash(wasm), glueHash: hash(glue) };
}

export function openCvAssetNames({ wasmHash, glueHash }) {
  return { wasm: `opencv-${wasmHash}.wasm`, glue: `opencv-glue-${glueHash}.js` };
}

/**
 * The Vite plugin. `virtual:opencv-assets` exports the scalar variant's
 * `opencvWasmUrl` and `opencvGlueUrl` and the SIMD variant's
 * `opencvSimdWasmUrl` and `opencvSimdGlueUrl`. In a build the scalar files
 * are emitted next to the chunks (assets/) and every URL is resolved against
 * the importing chunk's URL (the SIMD files stay where Vite copies public/,
 * one directory up); the dev server serves the scalar files from memory and
 * the SIMD files from public/. Register it for the page and for worker
 * bundles. A missing SIMD file fails the build: both variants ship.
 */
export function opencvAssetsPlugin({ packagePath = openCvPackagePath(), publicDir = null } = {}) {
  let assets = null;
  const load = () => (assets ||= extractOpenCvAssets(readFileSync(packagePath, 'utf8')));
  let serve = false;
  let simdDir = publicDir;
  const checkSimdFiles = () => {
    const paths = simdDir ? openCvSimdPaths(simdDir) : openCvSimdPaths();
    for (const key of ['wasm', 'glue']) {
      if (!existsSync(paths[key])) throw new Error(`OpenCV SIMD asset missing: ${paths[key]} (scripts/build-opencv-js.sh builds it)`);
    }
    assertOpenCvSimdGlue(readFileSync(paths.glue, 'utf8'));
  };
  return {
    name: 'nc-opencv-assets',
    configResolved(config) {
      serve = config.command === 'serve';
      simdDir ||= config.publicDir || null;
    },
    resolveId(id) {
      return id === OPENCV_VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      const extracted = load();
      const names = openCvAssetNames(extracted);
      checkSimdFiles();
      if (serve) {
        return `export const opencvWasmUrl = new URL(${JSON.stringify(DEV_PREFIX + names.wasm)}, self.location.href).href;\n`
          + `export const opencvGlueUrl = new URL(${JSON.stringify(DEV_PREFIX + names.glue)}, self.location.href).href;\n`
          + `export const opencvSimdWasmUrl = new URL(${JSON.stringify('/' + OPENCV_SIMD_ASSETS.wasm)}, self.location.href).href;\n`
          + `export const opencvSimdGlueUrl = new URL(${JSON.stringify('/' + OPENCV_SIMD_ASSETS.glue)}, self.location.href).href;\n`;
      }
      // The scalar files land in assets/, as every chunk does, so a URL
      // relative to the importing chunk finds them; public/codecs/ is one
      // directory above. The names go through variables so no bundler
      // rewrites the `new URL(..., import.meta.url)` pattern.
      for (const [name, source] of [[names.wasm, extracted.wasm], [names.glue, extracted.glue]]) {
        this.emitFile({ type: 'asset', fileName: `assets/${name}`, source });
      }
      return `const wasmName = ${JSON.stringify(names.wasm)};\nconst glueName = ${JSON.stringify(names.glue)};\n`
        + `const simdWasmName = ${JSON.stringify('../' + OPENCV_SIMD_ASSETS.wasm)};\nconst simdGlueName = ${JSON.stringify('../' + OPENCV_SIMD_ASSETS.glue)};\n`
        + 'export const opencvWasmUrl = new URL(wasmName, import.meta.url).href;\n'
        + 'export const opencvGlueUrl = new URL(glueName, import.meta.url).href;\n'
        + 'export const opencvSimdWasmUrl = new URL(simdWasmName, import.meta.url).href;\n'
        + 'export const opencvSimdGlueUrl = new URL(simdGlueName, import.meta.url).href;\n';
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url || '').split('?')[0];
        if (!path.startsWith(DEV_PREFIX)) { next(); return; }
        const extracted = load();
        const names = openCvAssetNames(extracted);
        const file = path.slice(DEV_PREFIX.length);
        if (file === names.wasm) {
          response.setHeader('Content-Type', 'application/wasm');
          response.end(Buffer.from(extracted.wasm.buffer, extracted.wasm.byteOffset, extracted.wasm.byteLength));
        } else if (file === names.glue) {
          response.setHeader('Content-Type', 'text/javascript');
          response.end(extracted.glue);
        } else {
          response.statusCode = 404;
          response.end();
        }
      });
    }
  };
}
