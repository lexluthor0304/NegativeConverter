// The build-derived hashes of stored display proxies (#249): every listed
// module exists, and a change to the decoder or to any of them changes a hash.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayProxyBuildHashes, DISPLAY_PROXY_CODE_FILES, DISPLAY_PROXY_DECODER_FILES } from '../../../scripts/display-proxy-hashes.mjs';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
for (const file of DISPLAY_PROXY_CODE_FILES) assert.ok(existsSync(join(appRoot, 'src', file)), `hashed module exists: ${file}`);
const real = displayProxyBuildHashes(appRoot);
assert.match(real.code, /^[0-9a-f]{64}$/);
assert.match(real.decoder, /^[0-9a-f]{64}$/);
assert.deepEqual(displayProxyBuildHashes(appRoot), real, 'stable');

// A copy of the listed files: editing one, or the decoder, changes the key.
const scratch = mkdtempSync(join(tmpdir(), 'nc-proxy-hashes-'));
try {
  const app = join(scratch, 'app');
  for (const file of DISPLAY_PROXY_CODE_FILES) {
    mkdirSync(dirname(join(app, 'src', file)), { recursive: true });
    cpSync(join(appRoot, 'src', file), join(app, 'src', file));
  }
  const dist = join(scratch, 'node_modules', 'libraw-wasm', 'dist');
  mkdirSync(dist, { recursive: true });
  for (const file of DISPLAY_PROXY_DECODER_FILES) writeFileSync(join(dist, file), `decoder ${file}`);
  const before = displayProxyBuildHashes(app);
  assert.equal(before.code, real.code, 'the code hash depends on the files only');
  appendFileSync(join(app, 'src', 'app', 'displayPreview.js'), '\n// changed\n');
  const afterCode = displayProxyBuildHashes(app);
  assert.notEqual(afterCode.code, before.code, 'a change to the display resize is a miss');
  assert.equal(afterCode.decoder, before.decoder);
  writeFileSync(join(dist, 'libraw.wasm'), 'another decoder');
  const afterDecoder = displayProxyBuildHashes(app).decoder;
  assert.notEqual(afterDecoder, before.decoder, 'another libraw.wasm is a miss');
  // #264: the threaded build's files, and a dist the dev server resolves
  // instead of the installed one (LIBRAW_WASM_DIST), are the decoder too.
  writeFileSync(join(dist, 'libraw-threaded.wasm'), 'a threaded build');
  assert.notEqual(displayProxyBuildHashes(app).decoder, afterDecoder, 'a threaded build is part of the decoder');
  const local = join(scratch, 'local-dist');
  mkdirSync(local, { recursive: true });
  for (const file of DISPLAY_PROXY_DECODER_FILES) writeFileSync(join(local, file), `local ${file}`);
  const localHashes = displayProxyBuildHashes(app, { librawDist: local });
  assert.notEqual(localHashes.decoder, displayProxyBuildHashes(app).decoder, 'a local libraw-wasm dist is another decoder');
  assert.equal(localHashes.code, displayProxyBuildHashes(app).code);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log('displayProxyHashes: listed modules exist; code and decoder changes change the store key');
