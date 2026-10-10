// Packaging step of scripts/build-opencv-js.sh (#292): turns a
// `--disable_single_file --simd` OpenCV.js build (bin/opencv.js, the UMD
// glue, and bin/opencv_js.wasm) into the committed SIMD variant under
// negative2positive/public/codecs/:
//
// - opencv-simd.wasm: the build's module, byte for byte;
// - opencv-simd-glue.js: the glue with the package's two UMD patches and the
//   app's hook tail (patchOpenCvSimdGlue in opencv-assets.mjs);
// - opencv-simd-build-info.txt: what was built from what (OpenCV tag and
//   commit, Emscripten, CMake, the command), the SHA-256 of both files, the
//   SIMD evidence (functions using v128 instructions, counted on wasm-dis
//   output) and cv.getBuildInformation() of the built module.
//
// Before writing, the module is loaded in Node through the same hook the app
// installs and must report -msimd128 and expose cv.Mat.
//
//   node scripts/opencv-simd-assets.mjs --build-dir build_js --out-dir negative2positive/public/codecs
//     --opencv-tag 5.0.0 --opencv-commit SHA --emcc "emcc ... 6.0.4" [--cmake ...] [--python ...]
//     [--cmake-options "..."] [--jobs N] [--wasm-opt PATH]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { hostname, release, type as osType, arch } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import vm from 'node:vm';
import { OPENCV_SIMD_ASSETS, assertOpenCvSimdGlue, extractOpenCvAssets, openCvPackagePath, patchOpenCvSimdGlue } from './opencv-assets.mjs';

function argValue(name, fallback = null) {
  const at = process.argv.indexOf(name);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}
const buildDir = argValue('--build-dir');
const outDir = argValue('--out-dir');
if (!buildDir || !outDir) {
  console.error('usage: node scripts/opencv-simd-assets.mjs --build-dir build_js --out-dir negative2positive/public/codecs --opencv-tag TAG --opencv-commit SHA --emcc "..."');
  process.exit(2);
}
const provenance = {
  opencvTag: argValue('--opencv-tag', 'unknown'),
  opencvCommit: argValue('--opencv-commit', 'unknown'),
  emcc: argValue('--emcc', 'unknown'),
  cmake: argValue('--cmake', 'unknown'),
  python: argValue('--python', 'unknown'),
  cmakeOptions: argValue('--cmake-options', '-DCMAKE_CXX_STANDARD=17'),
  jobs: argValue('--jobs', '?')
};
const wasmOpt = argValue('--wasm-opt', '');
const wasmDis = wasmOpt ? join(dirname(wasmOpt), 'wasm-dis') : '';
// OpenCV's LICENSE (Apache-2.0) from the checkout, kept next to the files as
// libheif's is.
const licensePath = argValue('--license', '');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const gluePath = join(buildDir, 'bin', 'opencv.js');
const wasmPath = join(buildDir, 'bin', 'opencv_js.wasm');
for (const path of [gluePath, wasmPath]) {
  if (!existsSync(path)) { console.error(`missing build output: ${path}`); process.exit(1); }
}
const wasm = new Uint8Array(readFileSync(wasmPath));
if (!(wasm[0] === 0 && wasm[1] === 0x61 && wasm[2] === 0x73 && wasm[3] === 0x6d)) throw new Error(`${wasmPath} is not a wasm module`);
const wasmName = basename(OPENCV_SIMD_ASSETS.wasm);
const glue = patchOpenCvSimdGlue(readFileSync(gluePath, 'utf8'), { wasmName });
assertOpenCvSimdGlue(glue);

// ---- Load the module as the app does: the hook instantiates a compiled Module.
if (!WebAssembly.validate(wasm)) throw new Error('this Node cannot validate the module (no WASM SIMD?)');
const module = await WebAssembly.compile(wasm);
let hooked = 0;
globalThis.__opencvModuleArg = {
  instantiateWasm(imports, done) {
    hooked += 1;
    WebAssembly.instantiate(module, imports).then(instance => done(instance, module));
    return {};
  }
};
const glueModule = { exports: {} };
vm.runInThisContext(`(function (require, module, exports, __filename, __dirname) {${glue}\n})`, { filename: 'opencv-simd-glue.js' })(
  createRequire(import.meta.url), glueModule, glueModule.exports, gluePath, dirname(gluePath));
const cv = await glueModule.exports;
delete globalThis.__opencvModuleArg;
if (hooked !== 1) throw new Error(`the glue did not instantiate through the hook (${hooked})`);
if (!cv?.Mat) throw new Error('the built module initialised without the Mat API');
const buildInformation = cv.getBuildInformation();
if (!/-msimd128/.test(buildInformation)) throw new Error('the build information does not mention -msimd128: not a SIMD build');
if (!/CV_ENABLE_INTRINSICS|Baseline:/.test(buildInformation)) console.warn('build information has no CPU feature line');

// ---- SIMD evidence: functions with v128 instructions, from wasm-dis.
async function countSimd(path) {
  if (!wasmDis || !existsSync(wasmDis)) return null;
  const child = spawn(wasmDis, ['-all', path], { stdio: ['ignore', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let functions = 0, simdFunctions = 0, simdInstructions = 0, current = false;
  const simd = /\((?:v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2|f16x8)\./;
  for await (const line of lines) {
    if (line.startsWith(' (func ')) { if (current) simdFunctions += 1; current = false; functions += 1; continue; }
    if (simd.test(line)) { simdInstructions += 1; current = true; }
  }
  if (current) simdFunctions += 1;
  const code = await new Promise(resolveExit => child.on('close', resolveExit));
  if (code !== 0) throw new Error(`wasm-dis failed (${code})`);
  return { functions, simdFunctions, simdInstructions };
}
const simdStats = await countSimd(wasmPath);
if (simdStats && simdStats.simdFunctions === 0) throw new Error('no function of the built module uses v128 instructions');

// The package's scalar module, for the record.
let reference = 'unavailable';
try {
  const scalar = extractOpenCvAssets(readFileSync(openCvPackagePath(), 'utf8'));
  reference = `@techstark/opencv-js ${createRequire(import.meta.url)('@techstark/opencv-js/package.json').version}: wasm ${scalar.wasm.length} bytes, sha256 ${sha256(scalar.wasm)}`;
} catch (error) {
  reference = `unavailable (${error?.message || error})`;
}

// ---- Write.
mkdirSync(outDir, { recursive: true });
const outWasm = resolve(outDir, wasmName);
const outGlue = resolve(outDir, basename(OPENCV_SIMD_ASSETS.glue));
const outInfo = resolve(outDir, basename(OPENCV_SIMD_ASSETS.buildInfo));
writeFileSync(outWasm, wasm);
writeFileSync(outGlue, glue);
if (licensePath) {
  const license = readFileSync(licensePath, 'utf8');
  if (!/Apache License/.test(license)) throw new Error(`${licensePath} is not OpenCV's Apache-2.0 LICENSE`);
  writeFileSync(resolve(outDir, 'opencv-LICENSE.txt'), license);
}
const glueBytes = Buffer.from(glue, 'utf8');
const info = [
  'OpenCV.js WASM SIMD build (NegativeConverter #292, scripts/build-opencv-js.sh)',
  `built: ${new Date().toISOString()} on ${hostname()} (${osType()} ${release()} ${arch()}), node ${process.version}`,
  `opencv: tag ${provenance.opencvTag}, commit ${provenance.opencvCommit}, https://github.com/opencv/opencv`,
  `emscripten: ${provenance.emcc}`,
  `cmake: ${provenance.cmake}; python: ${provenance.python}`,
  `configure: emcmake python3 platforms/js/build_js.py build_js --simd --disable_single_file --config_only ${provenance.cmakeOptions.split(/\s+/).filter(Boolean).map(option => `--cmake_option=${option}`).join(' ')}`,
  `build: make -j${provenance.jobs} opencv.js`,
  'recipe: TechStark/opencv-js build-opencv-js.yml for 5.0.0-release.1 (default module whitelist, no --threads) plus --simd; --disable_single_file because the app serves the wasm as its own file',
  'glue patches: UMD root call this -> globalThis and the hook tail `return cv(globalThis.__opencvModuleArg || {})` (dist/opencv.js.patch of the package and scripts/opencv-assets.mjs), wasm file name opencv-simd.wasm, __cxa_throw throws the exception pointer (as Emscripten 4.0.20 did; 6.x aborts with exception catching off) so cv.exceptionFromPtr reads cv::Error',
  `files: ${wasmName} ${wasm.length} bytes sha256 ${sha256(wasm)}; ${basename(outGlue)} ${glueBytes.length} bytes sha256 ${sha256(glueBytes)}`,
  simdStats
    ? `simd: ${simdStats.simdFunctions} of ${simdStats.functions} functions use v128 instructions (${simdStats.simdInstructions} instructions, counted on wasm-dis -all output)`
    : 'simd: not counted (wasm-dis unavailable)',
  `scalar reference: ${reference}`,
  '',
  '--- cv.getBuildInformation() ---',
  buildInformation.trimEnd(),
  ''
].join('\n');
writeFileSync(outInfo, info);
console.log(`opencv-simd: wasm ${wasm.length} bytes (${sha256(wasm).slice(0, 8)}), glue ${glueBytes.length} bytes (${sha256(glueBytes).slice(0, 8)})`
  + (simdStats ? `, ${simdStats.simdFunctions}/${simdStats.functions} functions use v128` : '') + ` -> ${outDir}`);
