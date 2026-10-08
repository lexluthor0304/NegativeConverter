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
// There is no rebuilt or slimmed OpenCV and no version change: the emitted
// wasm is the package's module (opencvAssets.test.mjs pins its SHA-256 to
// what the unmodified package instantiates), and Node tests keep importing
// the original file. The app imports the two URLs from the virtual module
// `virtual:opencv-assets`.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

export const OPENCV_VIRTUAL_ID = 'virtual:opencv-assets';
const RESOLVED_ID = '\0' + OPENCV_VIRTUAL_ID;
const DEV_PREFIX = '/@opencv-assets/';

const LITERAL_HEAD = 'function findWasmBinary(){return binaryDecode(';
const ORIGINAL_TAIL = /\n\s*if \(typeof Module === 'undefined'\)\n\s*var Module = \{\};\n\s*return cv\(Module\);\n\}\)\);\s*$/;
const PATCHED_TAIL = '\n  return cv(globalThis.__opencvModuleArg || {});\n}));\n';

export function openCvPackagePath() {
  return createRequire(import.meta.url).resolve('@techstark/opencv-js/dist/opencv.js');
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
 * The Vite plugin. `virtual:opencv-assets` exports `opencvWasmUrl` and
 * `opencvGlueUrl`. In a build both files are emitted next to the chunks
 * (assets/) and resolved against the importing chunk's URL; the dev server
 * serves them from memory. Register it for the page and for worker bundles.
 */
export function opencvAssetsPlugin({ packagePath = openCvPackagePath() } = {}) {
  let assets = null;
  const load = () => (assets ||= extractOpenCvAssets(readFileSync(packagePath, 'utf8')));
  let serve = false;
  return {
    name: 'nc-opencv-assets',
    configResolved(config) { serve = config.command === 'serve'; },
    resolveId(id) {
      return id === OPENCV_VIRTUAL_ID ? RESOLVED_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_ID) return null;
      const extracted = load();
      const names = openCvAssetNames(extracted);
      if (serve) {
        return `export const opencvWasmUrl = new URL(${JSON.stringify(DEV_PREFIX + names.wasm)}, self.location.href).href;\n`
          + `export const opencvGlueUrl = new URL(${JSON.stringify(DEV_PREFIX + names.glue)}, self.location.href).href;\n`;
      }
      // Both land in assets/, as every chunk does, so a URL relative to the
      // importing chunk finds them. The names go through variables so no
      // bundler rewrites the `new URL(..., import.meta.url)` pattern.
      for (const [name, source] of [[names.wasm, extracted.wasm], [names.glue, extracted.glue]]) {
        this.emitFile({ type: 'asset', fileName: `assets/${name}`, source });
      }
      return `const wasmName = ${JSON.stringify(names.wasm)};\nconst glueName = ${JSON.stringify(names.glue)};\n`
        + 'export const opencvWasmUrl = new URL(wasmName, import.meta.url).href;\n'
        + 'export const opencvGlueUrl = new URL(glueName, import.meta.url).href;\n';
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
