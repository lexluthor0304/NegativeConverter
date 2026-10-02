// The release that turns cross-origin isolation on (#264) must not serve a
// worker script at a URL a browser may still hold from before (#229 review
// R2-041). /assets/ was sent `immutable` for a year and without COEP, so a
// returning browser reuses its copy without asking, and the isolated page
// refuses a dedicated worker whose own response lacks COEP: RAW files would
// open as their 8-bit embedded JPEG, and ONNX Runtime's pthreads would not
// start. The build therefore names every script `[name]-[hash]-coi.js`
// (scripts/cross-origin-isolation.mjs).
//
// This fails when a build's assets/ still holds a script name that the
// production site served at 1703835, the last release without COEP (every
// script reachable from its pages, read from the site on 2026-10-02), or when
// a worker script served from outside assets/ is byte-identical to 1703835's.
// Those are revalidated, but Vercel answers with a 304 that carries none of
// vercel.json's headers, so an unchanged file keeps the headers of the copy
// the browser cached before.
//
//   npm run build:web && node scripts/check-dist-asset-names.mjs [--dist <dir>]...
//   node scripts/check-dist-asset-names.mjs --self-test     (npm test)
//
// Without --dist it checks negative2positive/dist (what Vercel and the
// desktop bundle serve) and dist/ (its copy), whichever exist.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ISOLATED_SCRIPT_SUFFIX, isolatedOutputNames } from './cross-origin-isolation.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = /\.m?js$/i;

// The scripts under /assets/ on https://negative-converter.tokugai.com at
// 1703835 (build 2026-09-23T09-19-40-354Z), all served `immutable` without COEP.
export const PRE_ISOLATION_SCRIPT_NAMES = Object.freeze([
  'FilmPresets-Ba5bg8mZ.js',
  'FilmPresets-DBVfqoJM.js',
  'aiInpaintWorker-D4IaW5j0.js',
  'analytics-BDH7RKzG.js',
  'autoFrameAnalyzer-mGa7MsML.js',
  'autoFrameWorker-BR5AY8xF.js',
  'conversionWorker-una0aVCa.js',
  'dustWorker-Rp7qVs7K.js',
  'dxFilmTable-Dm29ud--.js',
  'esm-BGCATzR3.js',
  'exportImageEncoders-DUtWnv0g.js',
  'exportWorker-W7ue5ffn.js',
  'gainMapJpeg-51zx1XHN.js',
  'heifLoader-CmP0IKgf.js',
  'inferenceRuntimeAssets-Bhw04HG5.js',
  'lensfun-core-CWJocukJ.js',
  'lensfun-core-DDgnU7tR.js',
  'lensfun-core-Exi_sccU.js',
  'libraw-CqyP3sBn.js',
  'main-NZq53VDB.js',
  'opencv-AjJB4fSW.js',
  'ort.bundle.min-CTCUQ4a2.js',
  'ort.bundle.min-jVUVoJFl.js',
  'ort.webgpu.bundle.min-BlTrWFO-.js',
  'ort.webgpu.bundle.min-Checg7Av.js',
  'pngFileLoader-QazG1mC-.js',
  'rawFileLoader-BSaQq-cT.js',
  'recipeQrImage-CJryxrdl.js',
  'rolldown-runtime-BX6QyPe0.js',
  'scanDecodeClient-TN7g3b3s.js',
  'scanDecodeWorker-8iSGUuH-.js',
  'semanticWorker-j1J-tosT.js',
  'sensorDefectsWorker-2XnXO7_6.js',
  'worker-BpdlSnKn.js',
]);

// Worker scripts served from outside /assets/ (public/), by their SHA-256 at 1703835.
export const PRE_ISOLATION_PUBLIC_WORKERS = Object.freeze({
  'codecs/heif-worker.js': '4af1fdd2c2221a8c8ba7af4bc3a4d24681fd90848019a5b1e28caac52b54af22',
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * `{ problems, scripts, unsuffixed }` for the builds in `distDirs` (each
 * holding assets/). A list with no build in it is a problem, not a pass.
 */
export function checkDistAssetNames(distDirs, {
  scriptNames = PRE_ISOLATION_SCRIPT_NAMES,
  publicWorkers = PRE_ISOLATION_PUBLIC_WORKERS,
} = {}) {
  const old = new Set(scriptNames);
  const problems = [];
  const scripts = [];
  const unsuffixed = [];
  let builds = 0;
  for (const dist of distDirs) {
    const assets = join(dist, 'assets');
    if (!existsSync(assets)) continue;
    builds += 1;
    const names = readdirSync(assets).filter((name) => SCRIPT.test(name)).sort();
    if (!names.length) problems.push(`${assets}: no scripts; is this a build?`);
    for (const name of names) {
      scripts.push(name);
      if (old.has(name)) problems.push(`${assets}/${name}: 1703835 served this name without COEP; a browser that cached it reuses that copy`);
      if (!name.replace(SCRIPT, '').endsWith(ISOLATED_SCRIPT_SUFFIX)) unsuffixed.push(name);
    }
    for (const [path, hash] of Object.entries(publicWorkers)) {
      const file = join(dist, path);
      if (existsSync(file) && sha256(readFileSync(file)) === hash) {
        problems.push(`${file}: byte-identical to 1703835's, so its revalidation keeps the cached copy's headers (no COEP)`);
      }
    }
  }
  if (!builds) problems.push(`no build: none of ${distDirs.join(', ')} has an assets/ directory (run \`npm run build:web\` first)`);
  return { problems, scripts, unsuffixed };
}

function report({ problems, scripts, unsuffixed }, distDirs) {
  if (problems.length) {
    console.error(`dist asset names: ${problems.length} problem(s)`);
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log(`dist asset names: ${scripts.length} scripts in ${distDirs.join(', ')}, none from before cross-origin isolation`
    + (unsuffixed.length ? ` (without the ${ISOLATED_SCRIPT_SUFFIX} suffix: ${[...new Set(unsuffixed)].join(', ')})` : ''));
  return 0;
}

// The checker itself on fake builds, the names vite.config.js gives, and the
// public worker scripts in the source tree (copied into a build as they are).
function selfTest() {
  const root = mkdtempSync(join(tmpdir(), 'nc-dist-names-'));
  try {
    const build = (name, files) => {
      const dist = join(root, name);
      for (const [path, body] of Object.entries(files)) {
        mkdirSync(dirname(join(dist, path)), { recursive: true });
        writeFileSync(join(dist, path), body);
      }
      return dist;
    };
    const binary = { 'assets/libraw-CKnqEbQ6.wasm': 'wasm', 'assets/main-DopvhVuv.css': 'css' };

    // A script 1703835 served, left in a build: fails, by name.
    const stale = build('stale', { ...binary, 'assets/worker-BpdlSnKn.js': 'worker', 'assets/main-Q1w2E3r4-coi.js': 'main' });
    const staleResult = checkDistAssetNames([stale]);
    assert.equal(staleResult.problems.length, 1, JSON.stringify(staleResult.problems));
    assert.match(staleResult.problems[0], /worker-BpdlSnKn\.js: 1703835 served this name/);

    // The same build with every script renamed passes; binary assets keep their names.
    const renamed = build('renamed', { ...binary, 'assets/worker-BpdlSnKn-coi.js': 'worker', 'assets/main-Q1w2E3r4-coi.js': 'main' });
    assert.deepEqual(checkDistAssetNames([renamed]), {
      problems: [], scripts: ['main-Q1w2E3r4-coi.js', 'worker-BpdlSnKn-coi.js'], unsuffixed: []
    });

    // Nothing to check is no pass.
    assert.match(checkDistAssetNames([join(root, 'missing')]).problems[0], /no build/);
    assert.match(checkDistAssetNames([build('empty', binary)]).problems[0], /no scripts/);

    // A public worker script byte-identical to its pre-isolation copy fails.
    const publicWorkers = { 'codecs/heif-worker.js': sha256('old worker') };
    const unchanged = build('unchanged', { ...binary, 'assets/main-Q1w2E3r4-coi.js': 'main', 'codecs/heif-worker.js': 'old worker' });
    assert.match(checkDistAssetNames([unchanged], { publicWorkers }).problems[0], /heif-worker\.js: byte-identical to 1703835's/);
    const changed = build('changed', { ...binary, 'assets/main-Q1w2E3r4-coi.js': 'main', 'codecs/heif-worker.js': 'new worker' });
    assert.deepEqual(checkDistAssetNames([changed], { publicWorkers }).problems, []);

    // The command line: exit status 1 on the stale build, 0 on the renamed one.
    const cli = (dist) => spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--dist', dist], { encoding: 'utf8' });
    assert.equal(cli(stale).status, 1);
    assert.equal(cli(renamed).status, 0, cli(renamed).stderr);

    // vite.config.js's names: every script carries the suffix, so none of
    // 1703835's comes back whatever its hash; other assets keep Vite's own.
    const names = isolatedOutputNames();
    const render = (pattern, name, hash, ext = 'js') => pattern.replace('[name]', name).replace('[hash]', hash).replace('[ext]', ext);
    const asset = (fileName) => ({ type: 'asset', names: [fileName], originalFileNames: [], source: '' });
    for (const old of PRE_ISOLATION_SCRIPT_NAMES) {
      const [, name, hash] = /^(.+)-([\w-]{8})\.js$/.exec(old);
      for (const pattern of [names.entryFileNames, names.chunkFileNames, names.assetFileNames(asset(`${name}.js`))]) {
        const emitted = render(pattern, name, hash);
        assert.equal(emitted, `assets/${name}-${hash}${ISOLATED_SCRIPT_SUFFIX}.js`);
        assert.ok(!PRE_ISOLATION_SCRIPT_NAMES.includes(emitted.slice('assets/'.length)));
      }
    }
    assert.equal(render(names.assetFileNames(asset('ort.bundle.min.mjs')), 'ort.bundle.min', 'Ab12Cd34', 'mjs'), `assets/ort.bundle.min-Ab12Cd34${ISOLATED_SCRIPT_SUFFIX}.mjs`);
    assert.equal(render(names.assetFileNames(asset('libraw.wasm')), 'libraw', 'CKnqEbQ6', 'wasm'), 'assets/libraw-CKnqEbQ6.wasm');
    assert.equal(render(names.assetFileNames(asset('main.css')), 'main', 'DopvhVuv', 'css'), 'assets/main-DopvhVuv.css');

    // The public worker scripts a build copies as they are.
    for (const [path, hash] of Object.entries(PRE_ISOLATION_PUBLIC_WORKERS)) {
      assert.notEqual(sha256(readFileSync(join(repoRoot, 'negative2positive', 'public', path))), hash,
        `public/${path} is byte-identical to 1703835's: Vercel's 304 would keep a cached copy's headers`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log('dist asset names self-test passed');
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
  selfTest();
} else {
  const distDirs = args.flatMap((arg, i) => (args[i - 1] === '--dist' ? [arg] : []));
  const dirs = distDirs.length ? distDirs : [join(repoRoot, 'negative2positive', 'dist'), join(repoRoot, 'dist')];
  process.exitCode = report(checkDistAssetNames(dirs), dirs.filter((dir) => existsSync(join(dir, 'assets'))));
}
