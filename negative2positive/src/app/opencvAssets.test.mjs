// The split OpenCV assets (#252 part 5): the emitted wasm is byte for byte
// the module the unmodified package instantiates, and the glue with a
// compiled Module behaves like the package.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { extractOpenCvAssets, openCvAssetNames, openCvPackagePath, opencvAssetsPlugin, OPENCV_VIRTUAL_ID } from '../../../scripts/opencv-assets.mjs';

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
}

console.log(`opencvAssets: wasm ${assets.wasm.length} bytes (${assets.wasmHash}), glue ${glueBytes} bytes, glued realm ready in ${readyMs.toFixed(0)} ms`);
console.log('ok opencvAssets');
