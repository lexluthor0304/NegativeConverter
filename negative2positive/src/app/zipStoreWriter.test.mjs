// Standalone Node test for zipStoreWriter.js - run with:
// node negative2positive/src/app/zipStoreWriter.test.mjs

import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { ZipStoreWriter, createZipNameDeduper, dedupeEntryName } from './zipStoreWriter.js';

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

// --- duplicate entry names --------------------------------------------------
{
  const w = new MemoryWritable();
  const writer = new ZipStoreWriter(w, { now: new Date('2026-05-16T00:00:00Z') });

  assert.equal(await writer.addBlob('DSC_0001_converted.tif', new Blob(['roll A'])), 'DSC_0001_converted.tif');
  assert.equal(await writer.addBlob('DSC_0001_converted.tif', new Blob(['roll B'])), 'DSC_0001_converted (2).tif');
  assert.equal(await writer.addBlob('DSC_0001_CONVERTED.TIF', new Blob(['roll C'])), 'DSC_0001_CONVERTED (3).TIF');
  assert.equal(await writer.addBlob('noext', new Blob(['x'])), 'noext');
  assert.equal(await writer.addBlob('noext', new Blob(['y'])), 'noext (2)');
  await writer.close();

  const zip = await JSZip.loadAsync(w.bytes(), { checkCRC32: true });
  assert.deepEqual(Object.keys(zip.files).sort(), [
    'DSC_0001_CONVERTED (3).TIF',
    'DSC_0001_converted (2).tif',
    'DSC_0001_converted.tif',
    'noext',
    'noext (2)'
  ]);
  assert.equal(await zip.file('DSC_0001_converted.tif').async('string'), 'roll A');
  assert.equal(await zip.file('DSC_0001_converted (2).tif').async('string'), 'roll B');
  assert.equal(await zip.file('DSC_0001_CONVERTED (3).TIF').async('string'), 'roll C');
}

// --- the shared name allocator ----------------------------------------------
{
  const claim = createZipNameDeduper();
  assert.equal(claim('a.tif'), 'a.tif');
  assert.equal(claim('a.tif'), 'a (2).tif');
  assert.equal(claim('a (2).tif'), 'a (2) (2).tif');
  assert.equal(dedupeEntryName('roll/frame.png', new Set(['roll/frame.png'])), 'roll/frame (2).png');
  assert.equal(dedupeEntryName('frame.png', new Set()), 'frame.png');
}

// --- ZIP64: entries past the 4 GB ZIP32 ceiling stay readable ---------------
{
  const w = new MemoryWritable();
  const writer = new ZipStoreWriter(w, { now: new Date('2026-05-16T00:00:00Z'), forceZip64: true });
  await writer.addBlob('big-one.tif', new Blob(['first entry']));
  await writer.addBlob('big-two.tif', new Blob([new Uint8Array([9, 8, 7])]));
  await writer.close();

  const archive = w.bytes();
  // ZIP64 end-of-central-directory + locator signatures must both be present.
  const hex = Buffer.from(archive).toString('hex');
  assert.ok(hex.includes('504b0606'), 'zip64 end of central directory record');
  assert.ok(hex.includes('504b0607'), 'zip64 end of central directory locator');

  const zip = await JSZip.loadAsync(archive, { checkCRC32: true });
  assert.deepEqual(Object.keys(zip.files).sort(), ['big-one.tif', 'big-two.tif']);
  assert.equal(await zip.file('big-one.tif').async('string'), 'first entry');
  assert.deepEqual(Array.from(await zip.file('big-two.tif').async('uint8array')), [9, 8, 7]);
}

// --- a huge archive no longer aborts mid-batch ------------------------------
{
  const w = new MemoryWritable();
  const writer = new ZipStoreWriter(w, { now: new Date('2026-05-16T00:00:00Z') });
  // Pretend we already streamed 5 GB, the point where the old writer threw
  // "ZIP archive size exceeds the ZIP32 limit." and the caller aborted.
  writer.position = 5 * 1024 * 1024 * 1024;
  await writer.addBlob('after-4gb.txt', new Blob(['still fine']));
  assert.equal(writer.entries.length, 1);
  assert.equal(writer.entries[0].zip64, true, 'entry past 4 GB must use ZIP64');
  assert.equal(w.aborted, false);
}

console.log('zipStoreWriter.test.mjs extended cases passed');
