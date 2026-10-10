// The split OpenCV assets (#252 part 5): the emitted wasm is byte for byte
// the module the unmodified package instantiates, and the glue with a
// compiled Module behaves like the package.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { existsSync } from 'node:fs';
import {
  assertOpenCvSimdGlue, extractOpenCvAssets, openCvAssetNames, openCvPackagePath, opencvAssetsPlugin, openCvSimdPaths, patchOpenCvSimdGlue,
  OPENCV_SIMD_ASSETS, OPENCV_VIRTUAL_ID
} from '../../../scripts/opencv-assets.mjs';
import { loadOpenCvSimd } from '../../../scripts/opencv-node.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const packagePath = openCvPackagePath();
const source = readFileSync(packagePath, 'utf8');
const assets = extractOpenCvAssets(source);

// What the package itself decodes and hands to WebAssembly.instantiate.
const instantiate = WebAssembly.instantiate;
let captured = null;
WebAssembly.instantiate = function (binary, imports) {
  if (!captured && ArrayBuffer.isView(binary)) captured = new Uint8Array(binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength));
  return instantiate.call(this, binary, imports);
};
const original = await createRequire(import.meta.url)(packagePath);
WebAssembly.instantiate = instantiate;
assert.ok(original?.Mat, 'the package initialises');
assert.ok(captured, 'the package instantiated its embedded module');
assert.equal(assets.wasm.length, captured.length, 'same wasm length');
assert.equal(sha256(assets.wasm), sha256(captured), 'the emitted wasm is the package\'s embedded module');
assert.equal(assets.wasmHash, sha256(captured).slice(0, 8));
assert.equal(openCvAssetNames(assets).wasm, `opencv-${assets.wasmHash}.wasm`);

// The glue: small, without the literal, calling the factory with the hook argument.
const glueBytes = Buffer.byteLength(assets.glue);
assert.ok(glueBytes <= 200 * 1024, `glue is ${glueBytes} bytes`);
assert.ok(source.length - assets.glue.length > 12_000_000, 'the literal is gone');
assert.ok(assets.glue.includes("function findWasmBinary(){return binaryDecode('')}"));
assert.ok(assets.glue.trimEnd().endsWith('return cv(globalThis.__opencvModuleArg || {});\n}));'));
assert.equal(assets.glue.match(/var Module = \{\};/g), null, 'the shadowing var is gone');
// Everything but the literal and the tail is the package's text.
const head = source.indexOf("binaryDecode('") + "binaryDecode('".length;
assert.equal(assets.glue.slice(0, head), source.slice(0, head));

// A layout this patch was not written for fails loudly.
assert.throws(() => extractOpenCvAssets(source.replace('function findWasmBinary(){return binaryDecode(', 'function findWasmBinary(){return decode(')), /one embedded wasm literal/);
assert.throws(() => extractOpenCvAssets(source.replace('return cv(Module);', 'return cv(Module2);')), /UMD tail/);

// A realm with a compiled Module: the hook instantiates it, and the result
// computes exactly what the package computes.
const module = await WebAssembly.compile(assets.wasm);
let hooked = 0;
globalThis.__opencvModuleArg = {
  instantiateWasm(imports, done) {
    hooked++;
    WebAssembly.instantiate(module, imports).then(instance => done(instance, module));
    return {};
  }
};
const started = performance.now();
// Node runs the glue as CommonJS (the page and the workers import it as a script or module).
const glueModule = { exports: {} };
vm.runInThisContext(`(function (require, module, exports, __filename, __dirname) {${assets.glue}\n})`, { filename: 'opencv-glue.js' })(
  createRequire(import.meta.url), glueModule, glueModule.exports, packagePath, packagePath.replace(/[\\/][^\\/]*$/, ''));
const glued = await glueModule.exports;
const readyMs = performance.now() - started;
delete globalThis.__opencvModuleArg;
assert.equal(hooked, 1, 'the glue instantiates through the hook');
assert.ok(glued?.Mat && glued !== original);

function lines(cv) {
  const size = 96;
  const mat = new cv.Mat(size, size, cv.CV_8UC1);
  let seed = 7;
  for (let i = 0; i < size * size; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const x = i % size, y = Math.floor(i / size);
    mat.data[i] = (Math.abs(x - y) < 3 || Math.abs(x + y - 60) < 2 ? 220 : 40) + (seed >>> 28);
  }
  const blurred = new cv.Mat(), edges = new cv.Mat(), found = new cv.Mat();
  cv.GaussianBlur(mat, blurred, new cv.Size(5, 5), 0);
  cv.Canny(blurred, edges, 50, 150);
  cv.HoughLines(edges, found, 1, Math.PI / 180, 20);
  const out = [Array.from(blurred.data), Array.from(edges.data), Array.from(found.data32F)];
  for (const m of [mat, blurred, edges, found]) m.delete();
  return out;
}
assert.deepEqual(lines(glued), lines(original), 'the glued realm computes what the package computes');
// The plugin: a build emits both files into assets/ and resolves them
// against the importing chunk; the dev server serves them from memory.
{
  const names = openCvAssetNames(assets);
  const build = opencvAssetsPlugin({ packagePath });
  build.configResolved({ command: 'build' });
  const resolved = build.resolveId(OPENCV_VIRTUAL_ID);
  assert.equal(build.resolveId('other'), null);
  const emitted = [];
  const code = build.load.call({ emitFile: file => { emitted.push(file); return file.fileName; } }, resolved);
  assert.deepEqual(emitted.map(file => file.fileName), [`assets/${names.wasm}`, `assets/${names.glue}`]);
  assert.equal(sha256(emitted[0].source), sha256(captured));
  assert.equal(emitted[1].source, assets.glue);
  assert.match(code, /new URL\(wasmName, import\.meta\.url\)/);
  assert.ok(code.includes(JSON.stringify(names.wasm)) && code.includes(JSON.stringify(names.glue)));
  assert.equal(build.load.call({ emitFile() { throw new Error('no'); } }, 'other'), null);

  const dev = opencvAssetsPlugin({ packagePath });
  dev.configResolved({ command: 'serve' });
  const devCode = dev.load.call({ emitFile() { throw new Error('the dev server emits nothing'); } }, resolved);
  assert.ok(devCode.includes(`/@opencv-assets/${names.wasm}`) && devCode.includes(`/@opencv-assets/${names.glue}`));
  let middleware;
  dev.configureServer({ middlewares: { use: fn => { middleware = fn; } } });
  const serve = url => new Promise((resolve) => {
    const response = { headers: {}, statusCode: 200, setHeader(key, value) { this.headers[key] = value; }, end(body) { resolve({ ...this, body }); } };
    middleware({ url }, response, () => resolve({ next: true }));
  });
  const wasmReply = await serve(`/@opencv-assets/${names.wasm}?t=1`);
  assert.equal(wasmReply.headers['Content-Type'], 'application/wasm');
  assert.equal(sha256(wasmReply.body), sha256(captured));
  const glueReply = await serve(`/@opencv-assets/${names.glue}`);
  assert.equal(glueReply.headers['Content-Type'], 'text/javascript');
  assert.equal(glueReply.body, assets.glue);
  assert.equal((await serve('/@opencv-assets/opencv-00000000.wasm')).statusCode, 404);
  assert.equal((await serve('/src/app/main.js')).next, true);

  // Both variants' URLs: the scalar files next to the chunks, the SIMD files
  // in public/codecs one directory up; a build without the SIMD files fails.
  assert.ok(code.includes('"../codecs/opencv-simd.wasm"') && code.includes('"../codecs/opencv-simd-glue.js"'));
  assert.match(code, /export const opencvSimdWasmUrl = new URL\(simdWasmName, import\.meta\.url\)/);
  assert.match(code, /export const opencvSimdGlueUrl = new URL\(simdGlueName, import\.meta\.url\)/);
  assert.ok(devCode.includes('"/codecs/opencv-simd.wasm"') && devCode.includes('"/codecs/opencv-simd-glue.js"'));
  const without = opencvAssetsPlugin({ packagePath, publicDir: '/nonexistent/public' });
  without.configResolved({ command: 'build' });
  assert.throws(() => without.load.call({ emitFile() {} }, resolved), /OpenCV SIMD asset missing/);
}

// ---- The SIMD variant (#292) ----
// The glue patcher, on the shape make_umd.py and Emscripten emit for a
// --disable_single_file build: the package's two UMD patches, the hook tail
// and the committed wasm name; anything else fails loudly.
{
  const built = [
    '(function (root, factory) {',
    "  if (typeof define === 'function' && define.amd) {",
    '    define(function () { return (root.cv = factory()); });',
    "  } else if (typeof module === 'object' && module.exports) {",
    '    module.exports = factory();',
    '  } else {',
    '    root.cv = factory();',
    '  }',
    '}(this, function () {',
    "  var cv = (() => { var _scriptName = typeof document != 'undefined' ? document.currentScript?.src : undefined;",
    "  return async function(moduleArg = {}) { var Module = moduleArg; function findWasmBinary() { return locateFile('opencv_js.wasm'); }",
    '  var ___cxa_throw=(ptr,type,destructor)=>{var info=new ExceptionInfo(ptr);info.init(type,destructor);uncaughtExceptionCount++;abort()};var syscallGetVarargI=()=>1;',
    '  return Module; } })();',
    "  if (typeof Module === 'undefined')",
    '    Module = {};',
    '  return cv(Module);',
    '}));',
    ''
  ].join('\n');
  const patched = patchOpenCvSimdGlue(built);
  assert.ok(patched.includes('}(globalThis, function () {'));
  assert.ok(patched.trimEnd().endsWith('return cv(globalThis.__opencvModuleArg || {});\n}));'));
  assert.ok(patched.includes("locateFile('opencv-simd.wasm')") && !patched.includes('opencv_js.wasm'));
  assert.equal(patched.match(/Module = \{\};/g), null);
  // Emscripten 6 aborts in __cxa_throw with exception catching off; the
  // package's Emscripten 4.0.20 glue threw the pointer cv.exceptionFromPtr reads.
  assert.ok(patched.includes('uncaughtExceptionCount++;throw ptr};var syscallGetVarargI') && !patched.includes('uncaughtExceptionCount++;abort()'));
  assertOpenCvSimdGlue(patched);
  assert.throws(() => patchOpenCvSimdGlue(built.replace('}(this, function () {', '}(window, function () {')), /UMD root call/);
  assert.throws(() => patchOpenCvSimdGlue(built.replace('return cv(Module);', 'return cv(Module2);')), /UMD tail/);
  assert.throws(() => patchOpenCvSimdGlue(built.replace("locateFile('opencv_js.wasm')", "binaryDecode('')")), /embedded/);
  assert.throws(() => patchOpenCvSimdGlue(built.replace("'opencv_js.wasm'", "'x.wasm'")), /opencv_js\.wasm/);
  assert.throws(() => patchOpenCvSimdGlue(built.replace('uncaughtExceptionCount++;abort()', 'uncaughtExceptionCount++;abort("x")')), /__cxa_throw/);
  assert.throws(() => assertOpenCvSimdGlue(built), /globalThis/);
  assert.throws(() => assertOpenCvSimdGlue(patched.replace("locateFile('opencv-simd.wasm')", "locateFile('opencv_js.wasm')")), /opencv_js\.wasm/);
  assert.throws(() => assertOpenCvSimdGlue(patched.replace('throw ptr}', 'abort()}')), /exception pointer/);
}

// The committed files: present, the glue in the shape the app relies on,
// the wasm and glue the build information describes (SHA-256), a SIMD build
// of OpenCV 5.0.0 with Emscripten 6.0.4 whose functions use v128, loading
// through the hook like the scalar glue.
{
  const paths = openCvSimdPaths();
  for (const [key, path] of Object.entries(paths)) assert.ok(existsSync(path), `${OPENCV_SIMD_ASSETS[key]} is committed (scripts/build-opencv-js.sh)`);
  const simdWasm = new Uint8Array(readFileSync(paths.wasm));
  const simdGlue = readFileSync(paths.glue, 'utf8');
  const info = readFileSync(paths.buildInfo, 'utf8');
  assertOpenCvSimdGlue(simdGlue);
  const simdGlueBytes = Buffer.byteLength(simdGlue);
  assert.ok(simdGlueBytes <= 300 * 1024, `SIMD glue is ${simdGlueBytes} bytes`);
  const files = /files: opencv-simd\.wasm (\d+) bytes sha256 ([0-9a-f]{64}); opencv-simd-glue\.js (\d+) bytes sha256 ([0-9a-f]{64})/.exec(info);
  assert.ok(files, 'the build information lists both files');
  assert.equal(simdWasm.length, Number(files[1]));
  assert.equal(sha256(simdWasm), files[2], 'opencv-simd.wasm is the build the information describes');
  assert.equal(simdGlueBytes, Number(files[3]));
  assert.equal(sha256(Buffer.from(simdGlue, 'utf8')), files[4], 'opencv-simd-glue.js is the glue the information describes');
  assert.match(info, /^opencv: tag 5\.0\.0, commit [0-9a-f]{40}/m);
  assert.match(info, /^emscripten: .*\b6\.0\.4\b/m);
  assert.match(info, /^simd: [1-9]\d* of \d+ functions use v128 instructions/m);
  assert.match(info, /-msimd128/);
  assert.notEqual(sha256(simdWasm), sha256(assets.wasm), 'another module than the package\'s');
  assert.ok(WebAssembly.validate(simdWasm), 'this Node validates the SIMD module');
  const simdStarted = performance.now();
  const simd = await loadOpenCvSimd();
  const simdReadyMs = performance.now() - simdStarted;
  assert.ok(simd?.Mat && simd !== original && simd !== glued);
  assert.match(simd.getBuildInformation(), /-msimd128/);
  assert.doesNotMatch(original.getBuildInformation(), /-msimd128/);
  assert.match(simd.getBuildInformation(), /OpenCV 5\.0\.0/);
  // A cv::Error reaches the caller as the exception pointer, readable with
  // cv.exceptionFromPtr, in both builds (DustRemoval's heap fallback and the
  // multi-shot error classification depend on it); the realm stays usable.
  for (const [name, realm] of [['package', original], ['simd', simd]]) {
    const mat = new realm.Mat(4, 4, realm.CV_8UC1), out = new realm.Mat();
    let thrown = null;
    try { realm.cvtColor(mat, out, realm.COLOR_BGR2GRAY); } catch (error) { thrown = error; } finally { mat.delete(); out.delete(); }
    assert.equal(typeof thrown, 'number', `${name}: cv::Error is thrown as a pointer`);
    assert.match(realm.exceptionFromPtr(thrown).msg, /Invalid number of channels|scn == 3 \|\| scn == 4/, `${name}: the message is readable`);
    const again = new realm.Mat(2, 2, realm.CV_8UC1);
    assert.equal(again.rows, 2, `${name}: the realm still works after the throw`);
    again.delete();
  }
  // The integer pipeline of the smoke check above (GaussianBlur, Canny,
  // HoughLines on 8-bit) gives the package's bytes; the wider parity runs are
  // in docs/auto-frame-regression.md and docs/dust-removal.md (#292).
  assert.deepEqual(lines(simd), lines(original), 'the SIMD realm computes the smoke pipeline like the package');
  console.log(`opencvAssets: SIMD wasm ${simdWasm.length} bytes (${sha256(simdWasm).slice(0, 8)}), glue ${simdGlueBytes} bytes, realm ready in ${simdReadyMs.toFixed(0)} ms`);
}

console.log(`opencvAssets: wasm ${assets.wasm.length} bytes (${assets.wasmHash}), glue ${glueBytes} bytes, glued realm ready in ${readyMs.toFixed(0)} ms`);
console.log('ok opencvAssets');
