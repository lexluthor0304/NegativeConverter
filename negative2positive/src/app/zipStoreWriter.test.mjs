// Standalone Node test for zipStoreWriter.js - run with:
// node negative2positive/src/app/zipStoreWriter.test.mjs

import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { ZipStoreWriter } from './zipStoreWriter.js';

class MemoryWritable {
  constructor() {
    this.chunks = [];
    this.closed = false;
    this.aborted = false;
  }

  async write(chunk) {
    assert.equal(this.closed, false, 'write after close');
    assert.equal(this.aborted, false, 'write after abort');
    if (chunk instanceof Uint8Array) {
      this.chunks.push(new Uint8Array(chunk));
      return;
    }
    if (chunk instanceof ArrayBuffer) {
      this.chunks.push(new Uint8Array(chunk));
      return;
    }
    if (ArrayBuffer.isView(chunk)) {
      this.chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      return;
    }
    throw new Error('Unexpected chunk type');
  }

  async close() {
    this.closed = true;
  }

  async abort() {
    this.aborted = true;
  }

  bytes() {
    const total = this.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

const writable = new MemoryWritable();
const writer = new ZipStoreWriter(writable, { now: new Date('2026-05-16T00:00:00Z') });

await writer.addBlob('alpha.txt', new Blob(['hello alpha']));
await writer.addBlob('nested/beta.bin', new Blob([new Uint8Array([0, 1, 2, 3, 255])]));
await writer.addBlob('../unsafe/gamma.txt', new Blob(['safe path']));
await writer.close();

assert.equal(writable.closed, true);
assert.equal(writable.aborted, false);
assert.ok(writable.chunks.length > 6, 'writer should stream multiple chunks');

const archive = writable.bytes();
const zip = await JSZip.loadAsync(archive, { checkCRC32: true });

assert.deepEqual(Object.keys(zip.files).sort(), [
  'alpha.txt',
  'nested/beta.bin',
  'unsafe/gamma.txt'
]);
assert.equal(await zip.file('alpha.txt').async('string'), 'hello alpha');
assert.deepEqual(
  Array.from(await zip.file('nested/beta.bin').async('uint8array')),
  [0, 1, 2, 3, 255]
);
assert.equal(await zip.file('unsafe/gamma.txt').async('string'), 'safe path');

for (const file of Object.values(zip.files)) {
  assert.equal(file.dir, false);
}

console.log('zipStoreWriter.test.mjs passed');
