import assert from 'node:assert/strict';
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
console.log('desktop import: bounded chunks, grant session, cancellation and incomplete reads passed');
