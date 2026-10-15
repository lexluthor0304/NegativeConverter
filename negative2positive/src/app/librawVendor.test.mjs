// The vendored LibRaw-Wasm (#302): every file of its dist is the one
// BUILD-INFO.txt names, the build script pins the same commit, and the page's
// LIBRAW_WASM_VERSION is the vendored package's version.
// Run with: node negative2positive/src/app/librawVendor.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { LIBRAW_WASM_VERSION } from './nativeRawDecoder.js';

const vendor = new URL('../../vendor/libraw-wasm/', import.meta.url);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const info = readFileSync(new URL('BUILD-INFO.txt', vendor), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('package.json', vendor), 'utf8'));

const listed = new Map([...info.matchAll(/^(dist\/\S+)\s+([0-9a-f]{64})$/gm)].map((m) => [m[1], m[2]]));
const present = readdirSync(new URL('dist/', vendor)).map((name) => `dist/${name}`).sort();
assert.deepEqual(present, [...listed.keys()].sort(), 'dist holds exactly the files BUILD-INFO.txt lists');
for (const [file, hash] of listed) {
  assert.equal(sha256(readFileSync(new URL(file, vendor))), hash, `${file} is the built file`);
}
for (const module of ['dist/libraw.wasm', 'dist/libraw-threaded.wasm']) assert.ok(listed.has(module), `${module} is vendored`);

const script = readFileSync(new URL('../../../scripts/build-libraw-wasm.sh', import.meta.url), 'utf8');
const commit = script.match(/^COMMIT=([0-9a-f]{40})$/m)?.[1];
assert.ok(commit, 'the build script pins a commit');
assert.equal(pkg.gitHead, commit, 'package.json names the pinned commit');
assert.ok(info.includes(commit), 'BUILD-INFO.txt names the pinned commit');
assert.equal(pkg.name, 'libraw-wasm');
assert.equal(pkg.version, `1.6.0-deterministic.${commit.slice(0, 7)}`);
assert.equal(LIBRAW_WASM_VERSION, pkg.version, 'the page names the vendored version');

console.log('librawVendor.test.mjs passed');
