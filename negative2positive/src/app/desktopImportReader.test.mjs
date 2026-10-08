import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readDesktopImportFile, IMPORT_CHUNK_BYTES } from './desktopImportReader.js';
const arrival = { size: IMPORT_CHUNK_BYTES + 10, path: '/picked/a.heic', name: 'a.heic', modified: '1000000', session: 'one' };
const calls = [];
const file = await readDesktopImportFile(arrival, async (command, args) => {
 calls.push({command,args}); return new Uint8Array(Math.min(IMPORT_CHUNK_BYTES, arrival.size - args.offset)).fill(args.offset ? 2 : 1).buffer;
});
assert.equal(file.size, arrival.size); assert.equal(file.name, 'a.heic'); assert.equal(calls.length, 2);
assert.equal(calls[1].args.offset, IMPORT_CHUNK_BYTES); assert.equal(calls[0].args.session, 'one');
await assert.rejects(readDesktopImportFile(arrival, async () => new Uint8Array(0)), /Incomplete/);
await assert.rejects(readDesktopImportFile(arrival, async () => null, () => false), /stopped/);
// The JS chunk and the Rust read length change together.
{
  const rust = readFileSync(new URL('../../../src-tauri/src/import_folder.rs', import.meta.url), 'utf8');
  const match = /const IMPORT_CHUNK_LIMIT: u64 = ([\d\s*]+);/.exec(rust);
  assert.ok(match, 'IMPORT_CHUNK_LIMIT is declared in import_folder.rs');
  assert.equal(match[1].split('*').reduce((product, factor) => product * Number(factor.trim()), 1), IMPORT_CHUNK_BYTES);
  assert.equal(IMPORT_CHUNK_BYTES, 8 * 1024 * 1024);
}
// A 90 MB hot-folder DNG takes at most 12 read_import_file calls.
{
  const big = { ...arrival, size: 90 * 1000 * 1000 };
  let reads = 0;
  const file = await readDesktopImportFile(big, async (command, args) => {
    assert.equal(command, 'read_import_file');
    reads++;
    return new ArrayBuffer(Math.min(IMPORT_CHUNK_BYTES, big.size - args.offset));
  });
  assert.equal(file.size, big.size);
  assert.ok(reads <= 12, `${reads} reads`);
}
console.log('desktop import: bounded chunks, grant session, cancellation and incomplete reads passed');
