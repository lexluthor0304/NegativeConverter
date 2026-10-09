// The compact dust state of a cold history entry (#281): the streaming hash
// equals contentHash.js's, the frame digest tells frames apart by any 8-bit,
// 16-bit or alpha byte, and compacting then rebuilding a dust state on a frame
// with the same pixels gives back the mask and the repaired image byte for
// byte (aligned and unaligned planes, with and without a 16-bit plane, empty
// and full masks, pixels repaired outside the mask), in slices or at once.
import assert from 'node:assert/strict';
import { murmurHash3x86_128 } from './contentHash.js';
import {
  createMurmur128, frameDigestSteps, compactDustSteps, rebuildDustSteps, coldDustRecordBytes,
  runSteps, runStepsInSlices
} from './dustColdState.js';

globalThis.ImageData ||= class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};

let seed = 11;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const randomBytes = (length) => Uint8Array.from({ length }, () => Math.floor(random() * 256));

// ---- the streaming hash is MurmurHash3 x86_128 of the concatenated bytes ----
for (const length of [0, 1, 3, 15, 16, 17, 31, 32, 33, 63, 100, 1000, 4099]) {
  const bytes = randomBytes(length);
  for (const seedValue of [0, 7]) {
    const expected = murmurHash3x86_128(bytes, seedValue);
    assert.equal(createMurmur128(seedValue).update(bytes).digest(), expected, `whole, ${length} bytes`);
    for (let trial = 0; trial < 6; trial++) {
      const hasher = createMurmur128(seedValue);
      let at = 0;
      while (at < length) {
        const next = Math.min(length, at + Math.floor(random() * 40));
        hasher.update(bytes.subarray(at, next));
        at = next;
        if (random() < 0.2) hasher.update(new Uint8Array(0));
      }
      assert.equal(hasher.digest(), expected, `pieces, ${length} bytes, trial ${trial}`);
    }
  }
}
{
  // Unaligned views and other element types hash their bytes.
  const backing = randomBytes(203);
  const view = backing.subarray(3, 3 + 160);
  assert.equal(createMurmur128().update(view).digest(), murmurHash3x86_128(view));
  const words = new Uint16Array(backing.buffer, 2, 80);
  assert.equal(createMurmur128().update(words).digest(), murmurHash3x86_128(new Uint8Array(backing.buffer, 2, 160)));
}

// ---- frames ----
function makeFrame(width, height, { with16 = true, unaligned = false } = {}) {
  const pixels = width * height;
  // Unaligned: planes that start one element into their buffer.
  const data = unaligned ? new Uint8ClampedArray(new ArrayBuffer(pixels * 4 + 1), 1, pixels * 4) : new Uint8ClampedArray(pixels * 4);
  const plane = with16 ? (unaligned ? new Uint16Array(new ArrayBuffer(pixels * 8 + 2), 2, pixels * 4) : new Uint16Array(pixels * 4)) : null;
  for (let i = 0; i < pixels * 4; i++) {
    const value = (i & 3) === 3 ? 65535 : Math.floor(random() * 65536);
    if (plane) plane[i] = value;
    data[i] = value >>> 8;
  }
  const image = new ImageData(data, width, height);
  if (plane) image.__image16 = { width, height, data: plane };
  return image;
}
function copyFrame(image, { unaligned = false } = {}) {
  const out = makeFrame(image.width, image.height, { with16: Boolean(image.__image16), unaligned });
  out.data.set(image.data);
  if (out.__image16) out.__image16.data.set(image.__image16.data);
  return out;
}
const digest = (image, options) => runSteps(frameDigestSteps(image, options));
const sameBytes = (a, b, label) => assert.ok(Buffer.from(a.buffer, a.byteOffset, a.byteLength)
  .equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength)), label);
function sameImage(actual, expected, label) {
  assert.equal(actual.width, expected.width, `${label}: width`);
  assert.equal(actual.height, expected.height, `${label}: height`);
  sameBytes(actual.data, expected.data, `${label}: 8-bit`);
  assert.equal(Boolean(actual.__image16), Boolean(expected.__image16), `${label}: 16-bit plane`);
  if (expected.__image16) sameBytes(actual.__image16.data, expected.__image16.data, `${label}: 16-bit`);
}

{
  const frame = makeFrame(37, 23);
  const value = digest(frame);
  assert.match(value, /^37x23:[0-9a-f]{32}:[0-9a-f]{32}$/);
  assert.equal(digest(copyFrame(frame)), value, 'the same pixels, another object');
  assert.equal(digest(copyFrame(frame, { unaligned: true })), value, 'unaligned planes');
  for (const sliceBytes of [16, 48, 1000, 4096]) assert.equal(digest(frame, { sliceBytes }), value, `slices of ${sliceBytes}`);
  for (const [plane, index] of [['data', 0], ['data', 37 * 23 * 4 - 1], ['plane', 5], ['plane', 37 * 23 * 4 - 1]]) {
    const other = copyFrame(frame);
    const target = plane === 'data' ? other.data : other.__image16.data;
    target[index] ^= 1;
    assert.notEqual(digest(other), value, `one bit of ${plane}[${index}]`);
  }
  const without16 = makeFrame(37, 23, { with16: false });
  assert.match(digest(without16), /^37x23:[0-9a-f]{32}:-$/);
  const reshaped = copyFrame(frame);
  reshaped.width = 23; reshaped.height = 37;
  assert.notEqual(digest(reshaped), value, 'the size is part of the digest');
}

// ---- compact, then rebuild on a frame with the same pixels ----
// A dust state as the app has one: specks in the mask (bytes 255, some other
// values, rows and edges), the repaired image the clean source with new
// values on masked pixels and, as repair strokes do, a few outside the mask.
function dustState(clean, { specks = 12, extra = 4, maskValue = 255, full = false } = {}) {
  const { width, height } = clean;
  const mask = new Uint8Array(width * height);
  if (full) mask.fill(maskValue);
  for (let k = 0; k < specks; k++) {
    const cx = Math.floor(random() * width), cy = Math.floor(random() * height), r = 1 + Math.floor(random() * 3);
    for (let y = Math.max(0, cy - r); y <= Math.min(height - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(width - 1, cx + r); x++) mask[y * width + x] = k % 5 === 0 ? 1 + k : maskValue;
    }
  }
  // The last row and a corner pixel.
  if (specks) { mask.fill(maskValue, (height - 1) * width); mask[0] = maskValue; }
  const repaired = copyFrame(clean);
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p] || random() < 0.1) continue; // a masked pixel TELEA left as it was
    for (let c = 0; c < 3; c++) {
      repaired.data[p * 4 + c] = Math.floor(random() * 256);
      if (repaired.__image16) repaired.__image16.data[p * 4 + c] = repaired.data[p * 4 + c] * 257;
    }
  }
  for (let k = 0; k < extra; k++) {
    const p = Math.floor(random() * mask.length);
    repaired.data[p * 4 + 1] ^= 0x40;
    if (repaired.__image16 && random() < 0.5) repaired.__image16.data[p * 4 + 3] ^= 0x100;
  }
  return { mask, repaired };
}

const cases = [
  { width: 41, height: 29 },
  { width: 64, height: 48, with16: false },
  { width: 50, height: 31, unaligned: true },
  { width: 33, height: 17, specks: 0, extra: 0 },
  { width: 30, height: 20, full: true },
  { width: 45, height: 38, maskValue: 1, extra: 25 },
];
for (const options of cases) {
  const label = JSON.stringify(options);
  const clean = makeFrame(options.width, options.height, options);
  const { mask, repaired } = dustState(clean, options);
  for (const slicePixels of [7, 1 << 20]) {
    const record = runSteps(compactDustSteps({ cleanSource: clean, mask, inpaintedImageData: repaired }, { slicePixels }));
    assert.ok(record, `${label}: compacted`);
    assert.equal(record.digest, digest(clean), `${label}: the clean source's digest`);
    assert.equal(record.repaired, 'own');
    // On the frame a cold undo converts again: other objects, the same pixels.
    const frame = copyFrame(clean, { unaligned: Boolean(options.unaligned) });
    const rebuilt = runSteps(rebuildDustSteps(record, frame, { sliceBytes: 64, slicePixels }));
    sameBytes(rebuilt.mask, mask, `${label}: mask`);
    sameImage(rebuilt.inpaintedImageData, repaired, `${label}: repaired image`);
    assert.notEqual(rebuilt.inpaintedImageData, frame, 'a repaired image of its own');
    assert.notEqual(rebuilt.inpaintedImageData.data.buffer, frame.data.buffer);
    sameImage(frame, clean, `${label}: the frame is not written`);
    // Bytes kept: runs, mask bytes, and RGBA8 (+ RGBA16) per differing pixel.
    const masked = mask.reduce((sum, value) => sum + (value ? 1 : 0), 0);
    const differing = record.diff.rgba8.length / 4;
    assert.equal(coldDustRecordBytes(record), record.mask.runs.byteLength + masked + record.diff.runs.byteLength
      + differing * (clean.__image16 ? 12 : 4));
  }
}

// The repaired image as null and as the clean source itself.
{
  const clean = makeFrame(20, 14);
  const { mask } = dustState(clean, { specks: 3 });
  for (const [inpaintedImageData, repaired] of [[null, 'none'], [clean, 'clean']]) {
    const record = runSteps(compactDustSteps({ cleanSource: clean, mask, inpaintedImageData }));
    assert.equal(record.repaired, repaired);
    assert.equal(record.diff, null);
    const frame = copyFrame(clean);
    const rebuilt = runSteps(rebuildDustSteps(record, frame));
    sameBytes(rebuilt.mask, mask, `${repaired}: mask`);
    assert.equal(rebuilt.inpaintedImageData, repaired === 'clean' ? frame : null, `${repaired}: the rebuilt image`);
  }
}

// A known digest is not computed again; states that cannot be described.
{
  const clean = makeFrame(16, 12);
  const { mask, repaired } = dustState(clean, { specks: 2 });
  const record = runSteps(compactDustSteps({ cleanSource: clean, mask, inpaintedImageData: repaired }, { digest: 'given' }));
  assert.equal(record.digest, 'given');
  assert.equal(runSteps(compactDustSteps({ cleanSource: clean, mask: mask.subarray(1), inpaintedImageData: repaired })), null, 'a mask of another size');
  assert.equal(runSteps(compactDustSteps({ cleanSource: clean, mask, inpaintedImageData: makeFrame(16, 12, { with16: false }) })), null, 'other planes');
  assert.equal(runSteps(compactDustSteps({ cleanSource: clean, mask, inpaintedImageData: makeFrame(12, 16) })), null, 'another size');
  // Over the cap: nothing is kept.
  const bytes = coldDustRecordBytes(record);
  assert.equal(runSteps(compactDustSteps({ cleanSource: clean, mask, inpaintedImageData: repaired }, { maxBytes: bytes - 1 })), null);
  assert.ok(runSteps(compactDustSteps({ cleanSource: clean, mask, inpaintedImageData: repaired }, { maxBytes: bytes })));
  // A checkerboard mask whose runs alone pass the cap stops early.
  const checker = new Uint8Array(16 * 12).map((_, p) => ((p + Math.floor(p / 16)) % 2 ? 255 : 0));
  assert.equal(runSteps(compactDustSteps({ cleanSource: clean, mask: checker }, { maxBytes: 64 })), null);
  // A frame of another size is not rebuilt on.
  assert.equal(runSteps(rebuildDustSteps(record, makeFrame(12, 16))), null);
  assert.equal(runSteps(rebuildDustSteps(record, makeFrame(16, 12, { with16: false }))), null);
}

// In slices: one pause between slices; a state that stops being current ends it.
{
  const clean = makeFrame(40, 30);
  const { mask, repaired } = dustState(clean);
  let pauses = 0;
  const record = await runStepsInSlices(compactDustSteps({ cleanSource: clean, mask, inpaintedImageData: repaired }, { slicePixels: 100 }),
    { pause: async () => { pauses++; } });
  assert.ok(pauses > 10, 'many slices');
  assert.deepEqual(record, runSteps(compactDustSteps({ cleanSource: clean, mask, inpaintedImageData: repaired })), 'the same record either way');
  let left = 3;
  const stopped = await runStepsInSlices(compactDustSteps({ cleanSource: clean, mask, inpaintedImageData: repaired }, { slicePixels: 100 }),
    { pause: async () => {}, isCurrent: () => --left > 0 });
  assert.equal(stopped, undefined, 'stopped once no longer current');
  // A digest slice is at most sliceBytes.
  let digestPauses = 0;
  await runStepsInSlices(frameDigestSteps(clean, { sliceBytes: 1024 }), { pause: async () => { digestPauses++; } });
  assert.equal(digestPauses, Math.ceil(clean.data.byteLength / 1024) - 1 + Math.ceil(clean.__image16.data.byteLength / 1024) - 1);
}

console.log('dustColdState: streaming MurmurHash3 equals contentHash.js, frame digests see every byte, and compact/rebuild restores mask and repaired image byte for byte');
