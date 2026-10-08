// The build-derived hashes of stored display proxies (#249): the listed
// modules are the whole relative-import closure of what shapes a stored
// proxy, every third-party decoder it runs is hashed, and a change to the
// decoders or to any listed module changes a hash.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  displayProxyBuildHashes, DISPLAY_PROXY_ENTRY_FILES, DISPLAY_PROXY_CODE_FILES, DISPLAY_PROXY_DECODER_FILES,
  DISPLAY_PROXY_SCAN_DECODER_FILES, DISPLAY_PROXY_CODEC_FILES
} from '../../../scripts/display-proxy-hashes.mjs';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const srcRoot = join(appRoot, 'src');
for (const file of DISPLAY_PROXY_CODE_FILES) assert.ok(existsSync(join(srcRoot, file)), `hashed module exists: ${file}`);
assert.equal(new Set(DISPLAY_PROXY_CODE_FILES).size, DISPLAY_PROXY_CODE_FILES.length, 'each module is listed once');

// ---- The closure: the modules every entry file imports, statically, with
// import() or as a worker or asset (new URL(…, import.meta.url)), and
// theirs. Comments are skipped; query suffixes (?url, ?worker) dropped ----
const IMPORT_FORMS = {
  static: [/\bimport\s*(?:[^'"`();]*?\bfrom\s*)?(['"])([^'"]+)\1/g, /\bexport\s*[^'"`();]*?\bfrom\s*(['"])([^'"]+)\1/g],
  dynamic: [/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g],
  url: [/\bnew\s+URL\s*\(\s*(['"])([^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g]
};
function codeOf(file) {
  return readFileSync(join(srcRoot, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}
// { relative: [{ file, kind }], bare: [specifier] } of one module.
function importsOf(file) {
  const code = codeOf(file);
  const out = { relative: [], bare: [] };
  for (const [kind, forms] of Object.entries(IMPORT_FORMS)) {
    for (const form of forms) {
      for (const match of code.matchAll(form)) {
        const specifier = match[2].replace(/\?.*$/, '');
        if (!/^\.\.?\//.test(specifier)) { out.bare.push(specifier); continue; }
        const target = relative(srcRoot, resolve(dirname(join(srcRoot, file)), specifier));
        assert.ok(existsSync(join(srcRoot, target)), `${file} imports ${specifier}, which resolves`);
        out.relative.push({ file: target, kind });
      }
    }
  }
  return out;
}
function closureOf(entries, kinds = Object.keys(IMPORT_FORMS)) {
  const files = new Set();
  const bare = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.shift();
    if (files.has(file)) continue;
    files.add(file);
    if (!/\.m?js$/.test(file)) continue;
    const imports = importsOf(file);
    for (const specifier of imports.bare) bare.add(specifier);
    for (const edge of imports.relative) if (kinds.includes(edge.kind)) queue.push(edge.file);
  }
  return { files: [...files].sort(), bare: [...bare].sort() };
}

const closure = closureOf(DISPLAY_PROXY_ENTRY_FILES);
const missingFrom = list => closure.files.filter(file => !list.includes(file));
assert.deepEqual(missingFrom(DISPLAY_PROXY_CODE_FILES), [], 'every module that shapes a stored proxy is hashed');
// The entry files reach the decoders, the geometry pool's worker and the
// sample's producer.
for (const file of ['app/rawFileLoader.js', 'app/pngFileLoader.js', 'app/heifLoader.js', 'workers/scanDecodeWorker.js',
  'workers/geometryWorker.js', 'app/analysisRegion.js']) assert.ok(closure.files.includes(file), `the closure reaches ${file}`);
// Static imports alone miss decoders the loaders import() and workers the
// pool and the clients start: the closure follows both.
const staticOnly = closureOf(DISPLAY_PROXY_ENTRY_FILES, ['static']).files;
for (const file of ['app/rawFileLoader.js', 'app/heifLoader.js', 'workers/scanDecodeWorker.js', 'workers/geometryWorker.js']) {
  assert.ok(!staticOnly.includes(file), `${file} is reached only through a dynamic import or a worker`);
}
// A pixel-shaping module dropped from the list fails: the colour-analysis
// sample's producer, a decoder reached through import() and a worker.
for (const file of ['app/analysisRegion.js', 'app/heifLoader.js', 'workers/scanDecodeWorker.js']) {
  assert.deepEqual(missingFrom(DISPLAY_PROXY_CODE_FILES.filter(listed => listed !== file)), [file], `a list without ${file} fails`);
}

// ---- Third-party decoders: every package the closure imports is hashed
// with the decoder, but the lens database, whose corrected proxies are never
// read back from the store (expectedStoredProxyKey has no key for them) ----
const packageOf = specifier => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
const hashedPackages = ['libraw-wasm', ...Object.keys(DISPLAY_PROXY_SCAN_DECODER_FILES)];
const unhashedPackages = ['@neoanaloglabkk/lensfun-wasm'];
for (const name of new Set(closure.bare.map(packageOf))) {
  assert.ok(hashedPackages.includes(name) || unhashedPackages.includes(name), `the decoder hash covers ${name}`);
}
for (const name of hashedPackages) assert.ok(closure.bare.some(specifier => packageOf(specifier) === name), `the closure runs ${name}`);
// The scan decoders' files are the entries the bundler resolves.
const requireFromApp = createRequire(join(srcRoot, 'app', 'tiffFileLoader.js'));
for (const [name, files] of Object.entries(DISPLAY_PROXY_SCAN_DECODER_FILES)) {
  const packageJson = realpathSync(requireFromApp.resolve(`${name}/package.json`));
  const manifest = JSON.parse(readFileSync(packageJson, 'utf8'));
  for (const field of ['module', 'browser', 'exports']) assert.equal(manifest[field], undefined, `${name}: entry by "main" only`);
  const entry = relative(dirname(packageJson), realpathSync(requireFromApp.resolve(name)));
  assert.ok(files.includes(entry) && files.includes('package.json'), `${name}: its entry ${entry} and version are hashed`);
}
// The HEIF codec heifLoader.js starts from public/codecs, and what it loads.
const codecNames = new Set();
for (const file of closure.files.filter(file => /\.m?js$/.test(file))) {
  for (const match of codeOf(file).matchAll(/\bcodecs\/([\w.-]+)/g)) codecNames.add(`codecs/${match[1]}`);
}
assert.ok(codecNames.has('codecs/heif-worker.js'), 'heifLoader.js starts the served HEIF worker');
for (const file of readdirSync(join(appRoot, 'public', 'codecs')).filter(name => /\.(m?js|wasm)$/.test(name))) codecNames.add(`codecs/${file}`);
assert.deepEqual([...codecNames].sort(), [...DISPLAY_PROXY_CODEC_FILES].sort(), 'every served codec file is hashed');

// ---- The hashes ----
const real = displayProxyBuildHashes(appRoot);
assert.match(real.code, /^[0-9a-f]{64}$/);
assert.match(real.decoder, /^[0-9a-f]{64}$/);
assert.deepEqual(displayProxyBuildHashes(appRoot), real, 'stable');

// A copy of the listed files: editing one, or a decoder, changes the key.
const scratch = mkdtempSync(join(tmpdir(), 'nc-proxy-hashes-'));
try {
  const app = join(scratch, 'app');
  for (const file of DISPLAY_PROXY_CODE_FILES) {
    mkdirSync(dirname(join(app, 'src', file)), { recursive: true });
    cpSync(join(srcRoot, file), join(app, 'src', file));
  }
  const dist = join(scratch, 'node_modules', 'libraw-wasm', 'dist');
  mkdirSync(dist, { recursive: true });
  for (const file of DISPLAY_PROXY_DECODER_FILES) writeFileSync(join(dist, file), `decoder ${file}`);
  for (const [name, files] of Object.entries(DISPLAY_PROXY_SCAN_DECODER_FILES)) {
    mkdirSync(join(scratch, 'node_modules', name), { recursive: true });
    for (const file of files) writeFileSync(join(scratch, 'node_modules', name, file), `${name} ${file}`);
  }
  mkdirSync(join(app, 'public', 'codecs'), { recursive: true });
  for (const file of DISPLAY_PROXY_CODEC_FILES) writeFileSync(join(app, 'public', file), `codec ${file}`);
  const before = displayProxyBuildHashes(app);
  assert.equal(before.code, real.code, 'the code hash depends on the files only');
  let code = before.code;
  for (const [file, what] of [['app/displayPreview.js', 'the display resize'], ['app/analysisRegion.js', 'the colour-analysis sample'],
    ['app/pngFileLoader.js', 'the 16-bit PNG decoder']]) {
    appendFileSync(join(app, 'src', file), '\n// changed\n');
    const after = displayProxyBuildHashes(app);
    assert.notEqual(after.code, code, `a change to ${what} is a miss`);
    assert.equal(after.decoder, before.decoder);
    code = after.code;
  }
  let decoder = before.decoder;
  const changeDecoder = (path, what) => {
    writeFileSync(path, `another ${what}`);
    const after = displayProxyBuildHashes(app);
    assert.notEqual(after.decoder, decoder, `${what} is a miss`);
    assert.equal(after.code, code, `${what} leaves the code hash`);
    decoder = after.decoder;
  };
  changeDecoder(join(dist, 'libraw.wasm'), 'another libraw.wasm');
  // #264: the threaded build's files, and a dist the dev server resolves
  // instead of the installed one (LIBRAW_WASM_DIST), are the decoder too.
  changeDecoder(join(dist, 'libraw-threaded.wasm'), 'a threaded build');
  changeDecoder(join(scratch, 'node_modules', 'utif', 'UTIF.js'), 'another UTIF');
  changeDecoder(join(scratch, 'node_modules', 'upng-js', 'package.json'), 'another upng-js release');
  changeDecoder(join(app, 'public', 'codecs', 'libheif.wasm'), 'another libheif');
  const local = join(scratch, 'local-dist');
  mkdirSync(local, { recursive: true });
  for (const file of DISPLAY_PROXY_DECODER_FILES) writeFileSync(join(local, file), `local ${file}`);
  const localHashes = displayProxyBuildHashes(app, { librawDist: local });
  assert.notEqual(localHashes.decoder, displayProxyBuildHashes(app).decoder, 'a local libraw-wasm dist is another decoder');
  assert.equal(localHashes.code, displayProxyBuildHashes(app).code);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`displayProxyHashes: the ${closure.files.length} modules that shape a stored proxy are hashed; code, scan-decoder, codec and LibRaw changes change the store key`);
