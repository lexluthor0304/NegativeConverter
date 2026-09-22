// Standalone Node test for zipStoreWriter.js - run with:
// node negative2positive/src/app/zipStoreWriter.test.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// APPNOTE 4.4.4 / 4.4.8 / 4.4.9: with bit 3, ZIP32 local CRC/sizes
// are zero; actual values live in the descriptor and central directory.
// ZIP64 still uses size sentinels and its 64-bit local extra fields.
const independentArchives = [];
for (const forceZip64 of [false, true]) {
  const target = new MemoryWritable();
  const writer = new ZipStoreWriter(target, { forceZip64 });
  await writer.addBlob('a.txt', new Blob(['abc']));
  await writer.close();
  const bytes = target.bytes();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint16(6, true) & 8, 8, 'local header sets descriptor flag');
  assert.equal(view.getUint32(14, true), 0, 'local CRC belongs to descriptor');
  assert.equal(view.getUint32(18, true), forceZip64 ? 0xffffffff : 0, 'local compressed size');
  assert.equal(view.getUint32(22, true), forceZip64 ? 0xffffffff : 0, 'local uncompressed size');
  const nameLength = view.getUint16(26, true), extraLength = view.getUint16(28, true);
  assert.equal(extraLength, forceZip64 ? 20 : 0);
  if (forceZip64) {
    const extra = 30 + nameLength;
    assert.equal(view.getUint16(extra, true), 1, 'ZIP64 extra field ID');
    assert.equal(view.getUint16(extra + 2, true), 16, 'two ZIP64 size fields');
    assert.equal(view.getBigUint64(extra + 4, true), 3n);
    assert.equal(view.getBigUint64(extra + 12, true), 3n);
  }
  const descriptor = 30 + nameLength + extraLength + 3;
  assert.equal(view.getUint32(descriptor, true), 0x08074b50);
  assert.equal(view.getUint32(descriptor + 4, true), 0x352441c2, 'known CRC32 of abc');
  if (forceZip64) {
    assert.equal(view.getBigUint64(descriptor + 8, true), 3n);
    assert.equal(view.getBigUint64(descriptor + 16, true), 3n);
  } else {
    assert.equal(view.getUint32(descriptor + 8, true), 3);
    assert.equal(view.getUint32(descriptor + 12, true), 3);
  }
  const central = descriptor + (forceZip64 ? 24 : 16);
  assert.equal(view.getUint32(central, true), 0x02014b50);
  assert.equal(view.getUint16(central + 8, true) & 8, 8);
  assert.equal(view.getUint32(central + 16, true), 0x352441c2);
  assert.equal(view.getUint32(central + 20, true), forceZip64 ? 0xffffffff : 3);
  assert.equal(view.getUint32(central + 24, true), forceZip64 ? 0xffffffff : 3);
  if (forceZip64) {
    const extra = central + 46 + nameLength;
    assert.equal(view.getBigUint64(extra + 4, true), 3n);
    assert.equal(view.getBigUint64(extra + 12, true), 3n);
  }
  independentArchives.push({ forceZip64, bytes });
}

// Info-ZIP is independent of the JavaScript reader. Keep the exact structural
// assertions above mandatory even on environments without this optional tool.
const unzip = spawnSync('unzip', ['-v'], { encoding: 'utf8' });
if (unzip.error?.code === 'ENOENT') {
  console.log('SKIP: optional Info-ZIP extraction check (unzip unavailable)');
} else {
  assert.equal(unzip.status, 0, unzip.stderr || unzip.error?.message);
  const directory = mkdtempSync(join(tmpdir(), 'nc-zip-descriptor-'));
  try {
    for (const { forceZip64, bytes } of independentArchives) {
      const path = join(directory, forceZip64 ? 'zip64.zip' : 'zip32.zip');
      writeFileSync(path, bytes);
      const check = spawnSync('unzip', ['-t', path], { encoding: 'utf8' });
      assert.equal(check.status, 0, check.stdout + check.stderr);
      const extracted = spawnSync('unzip', ['-p', path, 'a.txt'], { encoding: 'utf8' });
      assert.equal(extracted.status, 0, extracted.stderr);
      assert.equal(extracted.stdout, 'abc');
    }
    console.log('ZIP32/ZIP64 exact headers and independent Info-ZIP CRC/extraction passed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

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

// A payload is read once; even a single giant producer chunk is written in
// bounded pieces, with task yields while computing its checksum.
{
  let reads = 0;
  let ticks = 0;
  const bytes = new Uint8Array(16 * 1024 * 1024);
  bytes[0] = 19; bytes[bytes.length - 1] = 237;
  class SingleReadBlob extends Blob {
    stream() {
      assert.equal(++reads, 1, 'ZIP payload must not be read twice');
      return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    }
  }
  const target = new MemoryWritable();
  const writer = new ZipStoreWriter(target);
  const timer = setInterval(() => ticks++, 0);
  try { await writer.addBlob('large.bin', new SingleReadBlob([bytes])); }
  finally { clearInterval(timer); }
  await writer.addBlob('empty.bin', new Blob([]));
  await writer.close();
  assert.ok(ticks > 0, 'CRC computation should yield to input and paint tasks');
  assert.ok(target.chunks.every(chunk => chunk.length <= 256 * 1024), 'bounded write chunks');
  const zip = await JSZip.loadAsync(target.bytes(), { checkCRC32: true });
  assert.deepEqual(await zip.file('large.bin').async('uint8array'), bytes);
  assert.equal((await zip.file('empty.bin').async('uint8array')).length, 0);
}
