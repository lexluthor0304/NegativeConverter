// Random-access embedded-preview locator: synthetic TIFF containers for every
// layout the roll and the repo NEFs use, plus malformed input. When the real
// fixtures sit at the repo root (untracked, like the other RAW checks), their
// headers are walked too; only small slices are read, nothing is decoded.
import assert from 'node:assert/strict';
import { existsSync, openAsBlob } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  locateEmbeddedPreviews, pickForViewer, pickForTile, isTiffContainerRawName, TIFF_HEAD_BYTES
} from './rawEmbeddedPreview.js';
import { parseJpegFrameHeader, readJpegDimensionsFromSOF } from './nefJpegPreview.js';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function exifApp1(orientation, little = true) {
  // "Exif\0\0" + TIFF header + IFD0 with one Orientation entry.
  const tiff = new Uint8Array(8 + 2 + 12 + 4);
  const dv = new DataView(tiff.buffer);
  tiff[0] = tiff[1] = little ? 0x49 : 0x4D;
  dv.setUint16(2, 42, little); dv.setUint32(4, 8, little);
  dv.setUint16(8, 1, little);
  dv.setUint16(10, 0x0112, little); dv.setUint16(12, 3, little); dv.setUint32(14, 1, little);
  dv.setUint16(18, orientation, little);
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const length = payload.length + 2;
  return [0xFF, 0xE1, length >> 8, length & 0xFF, ...payload];
}

function makeJpeg(width, height, { sof = 0xC0, precision = 8, orientation = 0, padding = 0, tail = 64 } = {}) {
  const parts = [0xFF, 0xD8];
  if (orientation) parts.push(...exifApp1(orientation));
  if (padding) {
    // An APP2 segment large enough to push the SOF past the first 2 KiB.
    const length = padding + 2;
    parts.push(0xFF, 0xE2, length >> 8, length & 0xFF, ...new Array(padding).fill(0x20));
  }
  parts.push(0xFF, sof, 0x00, 0x11, precision, height >> 8, height & 0xFF, width >> 8, width & 0xFF, 3,
    1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  parts.push(0xFF, 0xDA, 0x00, 0x0C, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3F, 0);
  for (let i = 0; i < tail; i++) parts.push(i & 0x7F);
  parts.push(0xFF, 0xD9);
  return Uint8Array.from(parts);
}

const SHORT = 3, LONG = 4, IFD = 13;

// Build a TIFF container. `ifds` entries: { at, entries: [{ tag, type, values, at? }], next }.
// Out-of-line values need an explicit `at`. Payloads are { at, bytes }.
function buildTiff({ little = true, magic = 42, ifd0, size, ifds, payloads = [] }) {
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out[0] = out[1] = little ? 0x49 : 0x4D;
  dv.setUint16(2, magic, little);
  dv.setUint32(4, ifd0, little);
  for (const { at, bytes } of payloads) out.set(bytes, at);
  for (const ifd of ifds) {
    const entries = [...ifd.entries].sort((a, b) => a.tag - b.tag);
    dv.setUint16(ifd.at, entries.length, little);
    entries.forEach((entry, i) => {
      const e = ifd.at + 2 + i * 12;
      const values = Array.isArray(entry.values) ? entry.values : [entry.values];
      const width = entry.type === SHORT ? 2 : 4;
      dv.setUint16(e, entry.tag, little); dv.setUint16(e + 2, entry.type, little);
      dv.setUint32(e + 4, values.length, little);
      const inline = values.length * width <= 4;
      const base = inline ? e + 8 : entry.at;
      if (!inline) {
        assert.ok(Number.isInteger(entry.at), `tag ${entry.tag} needs an out-of-line offset`);
        dv.setUint32(e + 8, entry.at, little);
      }
      values.forEach((value, j) => {
        if (width === 2) dv.setUint16(base + j * 2, value, little);
        else dv.setUint32(base + j * 4, value, little);
      });
    });
    dv.setUint32(ifd.at + 2 + entries.length * 12, ifd.next || 0, little);
  }
  return out;
}

const blobOf = bytes => new Blob([bytes]);
const previewIfd = (at, width, height, offset, length, extra = []) => ({ at, entries: [
  { tag: 254, type: LONG, values: 1 }, { tag: 256, type: SHORT, values: width },
  { tag: 257, type: SHORT, values: height }, { tag: 259, type: SHORT, values: 7 },
  { tag: 262, type: SHORT, values: 6 }, { tag: 273, type: LONG, values: offset },
  { tag: 279, type: LONG, values: length }, ...extra] });

// The M11 roll layout: IFD0 at byte 12 is the Compression-7 CFA raw itself
// (one lossless-JPEG strip that is most of the file); four baseline JPEG
// previews live in SubIFDs, the smallest thumbnail at 14336.
function m11({ little = true, magic = 42, ifd0 = 12, tailIfd0 = false } = {}) {
  const thumb = makeJpeg(160, 120), big = makeJpeg(9504, 6320), mid = makeJpeg(2112, 1408), small = makeJpeg(720, 480);
  const rawStrip = makeJpeg(9536, 6336, { sof: 0xC3, precision: 14 });
  const at = { thumb: 14336, big: 28672, mid: 60000, small: 90000, raw: 120000 };
  const size = 200000;
  const ifd0At = tailIfd0 ? size - 400 : ifd0;
  const ifds = [
    { at: ifd0At, entries: [
      { tag: 254, type: LONG, values: 0 }, { tag: 256, type: LONG, values: 9536 }, { tag: 257, type: LONG, values: 6336 },
      { tag: 259, type: SHORT, values: 7 }, { tag: 262, type: SHORT, values: 32803 }, { tag: 274, type: SHORT, values: 1 },
      { tag: 273, type: LONG, values: at.raw }, { tag: 279, type: LONG, values: 72_700_000 > size ? size - at.raw - 1000 : 0 },
      { tag: 330, type: LONG, values: [630, 780, 930, 1080], at: 400 }] },
    previewIfd(630, 160, 120, at.thumb, thumb.length),
    previewIfd(780, 9504, 6320, at.big, big.length),
    previewIfd(930, 2112, 1408, at.mid, mid.length),
    previewIfd(1080, 720, 480, at.small, small.length),
  ];
  const bytes = buildTiff({ little, magic, ifd0: ifd0At, size, ifds, payloads: [
    { at: at.thumb, bytes: thumb }, { at: at.big, bytes: big }, { at: at.mid, bytes: mid },
    { at: at.small, bytes: small }, { at: at.raw, bytes: rawStrip }] });
  return { bytes, at };
}

// ---------------------------------------------------------------------------
// M11 layout: IFD0 at 12, the CFA strip rejected, 2112 and 720 picked
// ---------------------------------------------------------------------------
for (const little of [true, false]) {
  const { bytes, at } = m11({ little });
  const found = await locateEmbeddedPreviews(blobOf(bytes));
  assert.ok(found, `M11 ${little ? 'LE' : 'BE'}: previews found`);
  assert.deepEqual(found.previews.map(p => [p.width, p.height]), [[160, 120], [720, 480], [2112, 1408], [9504, 6320]]);
  assert.ok(!found.previews.some(p => p.offset === at.raw), 'the CFA raw strip is never a candidate');
  assert.deepEqual(found.rawSize, { width: 9536, height: 6336 });
  assert.equal(found.orientation, 1);
  assert.ok(found.bytesRead <= 32 * 1024, `IFD walk and SOF checks stay within 32 KiB (${found.bytesRead})`);
  const viewer = pickForViewer(found.previews, 2200);
  assert.deepEqual([viewer.width, viewer.height, viewer.offset], [2112, 1408, at.mid]);
  assert.deepEqual([pickForTile(found.previews, 288).width, pickForTile(found.previews, 288).offset], [720, at.small]);
  // The 60 MP preview is never picked for display, however large the viewer.
  assert.equal(pickForViewer(found.previews, 20000).width, 2112);
  // A small DPR-1 viewer is served by the 720 px preview.
  assert.equal(pickForViewer(found.previews, 700).width, 720);
}

// Even when the CFA IFD carried Photometric 6 by mistake, the SOF check
// rejects its lossless (SOF3) stream.
{
  const { bytes, at } = m11();
  const dv = new DataView(bytes.buffer);
  // Rewrite IFD0's Photometric (entry order is sorted by tag: 254,256,257,259,262,...).
  const e262 = 12 + 2 + 4 * 12;
  assert.equal(dv.getUint16(e262, true), 262);
  dv.setUint16(e262 + 8, 6, true);
  const found = await locateEmbeddedPreviews(blobOf(bytes));
  assert.ok(!found.previews.some(p => p.offset === at.raw), 'SOF3 lossless strip rejected by the SOF check');
  assert.equal(found.rawSize, null, 'no CFA IFD left to measure');
}

// RW2 magic (0x55) is walked like TIFF.
{
  const { bytes } = m11({ magic: 0x55 });
  const found = await locateEmbeddedPreviews(blobOf(bytes));
  assert.equal(found?.previews.length, 4, 'RW2 magic accepted');
  const { bytes: bad } = m11({ magic: 0x2B });
  assert.equal(await locateEmbeddedPreviews(blobOf(bad)), null, 'BigTIFF/unknown magic is not walked');
}

// ---------------------------------------------------------------------------
// IFD0 at the file tail (L1009967 layout)
// ---------------------------------------------------------------------------
{
  const { bytes } = m11({ tailIfd0: true });
  assert.ok(bytes.length - 400 > TIFF_HEAD_BYTES);
  const found = await locateEmbeddedPreviews(blobOf(bytes));
  assert.equal(found?.previews.length, 4, 'IFD0 beyond the head is followed with its own slice');
  assert.deepEqual(found.rawSize, { width: 9536, height: 6336 });
  assert.equal(pickForViewer(found.previews, 2400).width, 2112);
  // Every read is a Blob slice; no full read.
  let sliced = 0, whole = 0;
  const blob = blobOf(bytes);
  const probe = { size: blob.size, slice: (a, b) => { sliced += b - a; return blob.slice(a, b); },
    arrayBuffer: () => { whole++; return blob.arrayBuffer(); } };
  assert.ok(await locateEmbeddedPreviews(probe));
  assert.equal(whole, 0, 'never reads the whole container');
  assert.ok(sliced < 40 * 1024, `slices stay small (${sliced})`);
}

// ---------------------------------------------------------------------------
// NEF: previews via 513/514 in SubIFDs past 256 KiB
// ---------------------------------------------------------------------------
{
  const size = 700_000;
  const ifdThumb = makeJpeg(160, 120), preview = makeJpeg(1620, 1080), full = makeJpeg(6048, 4032);
  const at = { thumb: 251972, subs: 263980, preview: 512000, full: 600000 };
  const bytes = buildTiff({ little: false, ifd0: 8, size, payloads: [
    { at: at.thumb, bytes: ifdThumb }, { at: at.preview, bytes: preview }, { at: at.full, bytes: full }], ifds: [
    { at: 8, entries: [{ tag: 254, type: LONG, values: 1 }, { tag: 259, type: SHORT, values: 6 },
      { tag: 274, type: SHORT, values: 1 }, { tag: 513, type: LONG, values: at.thumb }, { tag: 514, type: LONG, values: ifdThumb.length },
      { tag: 330, type: LONG, values: [at.subs, at.subs + 120, at.subs + 240], at: 400 }] },
    { at: at.subs, entries: [{ tag: 254, type: LONG, values: 1 }, { tag: 259, type: SHORT, values: 6 },
      { tag: 513, type: LONG, values: at.full }, { tag: 514, type: LONG, values: full.length }] },
    { at: at.subs + 120, entries: [{ tag: 254, type: LONG, values: 0 }, { tag: 256, type: LONG, values: 6064 },
      { tag: 257, type: LONG, values: 4040 }, { tag: 259, type: SHORT, values: 34713 }, { tag: 262, type: SHORT, values: 32803 }] },
    { at: at.subs + 240, entries: [{ tag: 254, type: LONG, values: 1 }, { tag: 259, type: SHORT, values: 6 },
      { tag: 513, type: LONG, values: at.preview }, { tag: 514, type: LONG, values: preview.length }] }] });
  assert.ok(at.subs > 256 * 1024, 'fixture puts the SubIFDs past the old 256 KiB header');
  const found = await locateEmbeddedPreviews(blobOf(bytes));
  assert.deepEqual(found.previews.map(p => p.width), [160, 1620, 6048]);
  assert.deepEqual(found.rawSize, { width: 6064, height: 4040 });
  assert.equal(pickForViewer(found.previews, 2400).width, 1620, 'NEF viewer preview is 1620x1080');
  assert.equal(pickForTile(found.previews).width, 1620);
}

// ---------------------------------------------------------------------------
// CR2-style IFD0 preview without NewSubFileType; lossless strip rejected
// ---------------------------------------------------------------------------
{
  const size = 120_000;
  const preview = makeJpeg(5472, 3648, { tail: 32 }), mid = makeJpeg(668, 432), lossless = makeJpeg(5568, 3708, { sof: 0xC3 });
  const bytes = buildTiff({ ifd0: 16, size, payloads: [
    { at: 20_000, bytes: preview }, { at: 60_000, bytes: mid }, { at: 80_000, bytes: lossless }], ifds: [
    // CR2 IFD0: compression 6, no NewSubFileType, no Photometric.
    { at: 16, entries: [{ tag: 256, type: SHORT, values: 5472 }, { tag: 257, type: SHORT, values: 3648 },
      { tag: 259, type: SHORT, values: 6 }, { tag: 273, type: LONG, values: 20_000 }, { tag: 279, type: LONG, values: preview.length },
      { tag: 274, type: SHORT, values: 6 }], next: 400 },
    { at: 400, entries: [{ tag: 259, type: SHORT, values: 6 }, { tag: 513, type: LONG, values: 60_000 },
      { tag: 514, type: LONG, values: mid.length }], next: 600 },
    // CR2 IFD3: the raw, compression 6 and no Photometric: only the SOF check rejects it.
    { at: 600, entries: [{ tag: 259, type: SHORT, values: 6 }, { tag: 273, type: LONG, values: 80_000 },
      { tag: 279, type: LONG, values: lossless.length }] }] });
  const found = await locateEmbeddedPreviews(blobOf(bytes));
  assert.deepEqual(found.previews.map(p => p.width), [668, 5472], 'IFD0 preview accepted without NewSubFileType; SOF3 rejected');
  assert.equal(found.orientation, 6);
  assert.equal(pickForViewer(found.previews, 2400).width, 668, '20 MP preview is above the display cap');
}

// ---------------------------------------------------------------------------
// JPEG XL previews are skipped (_DSC5290 layout)
// ---------------------------------------------------------------------------
{
  const size = 60_000;
  const bytes = buildTiff({ ifd0: 8, size, ifds: [
    { at: 8, entries: [{ tag: 254, type: LONG, values: 1 }, { tag: 256, type: SHORT, values: 256 }, { tag: 257, type: SHORT, values: 171 },
      { tag: 259, type: SHORT, values: 1 }, { tag: 262, type: SHORT, values: 2 }, { tag: 273, type: LONG, values: 20_000 },
      { tag: 279, type: LONG, values: 131 }, { tag: 330, type: LONG, values: [1000, 1200], at: 900 }] },
    { at: 1000, entries: [{ tag: 254, type: LONG, values: 0 }, { tag: 256, type: SHORT, values: 6048 }, { tag: 257, type: SHORT, values: 4024 },
      { tag: 259, type: SHORT, values: 7 }, { tag: 262, type: SHORT, values: 32803 }, { tag: 322, type: SHORT, values: 256 },
      { tag: 323, type: SHORT, values: 256 }, { tag: 324, type: LONG, values: 30_000 }, { tag: 325, type: LONG, values: 100 }] },
    // Single-strip JXL, LinearRaw photometric: rejected on compression and photometric.
    { at: 1200, entries: [{ tag: 254, type: LONG, values: 1 }, { tag: 256, type: SHORT, values: 256 }, { tag: 257, type: SHORT, values: 171 },
      { tag: 259, type: SHORT, values: 52546 }, { tag: 262, type: SHORT, values: 34892 }, { tag: 273, type: LONG, values: 40_000 },
      { tag: 279, type: LONG, values: 7667 }] }],
    payloads: [{ at: 40_000, bytes: Uint8Array.from([0xFF, 0x0A, 1, 2, 3, 4]) }] });
  assert.equal(await locateEmbeddedPreviews(blobOf(bytes)), null, 'JPEG XL / LinearRaw previews are not candidates');
}

// A preview whose own head carries 2 KiB+ of APP data extends the SOF read.
{
  const padded = makeJpeg(2112, 1408, { padding: 5000, orientation: 8 });
  const bytes = buildTiff({ ifd0: 8, size: 40_000, payloads: [{ at: 20_000, bytes: padded }], ifds: [
    previewIfd(8, 2112, 1408, 20_000, padded.length, [{ tag: 274, type: SHORT, values: 3 }])] });
  const found = await locateEmbeddedPreviews(blobOf(bytes));
  assert.equal(found?.previews[0].width, 2112, 'SOF beyond 2 KiB is found by the extended read');
  assert.equal(found.previews[0].exifOrientation, 8, 'the preview keeps its own Exif Orientation');
  assert.equal(found.orientation, 3, 'IFD0 Orientation is reported separately');
}

// Orientation 3, 6 and 8 read from IFD0.
for (const orientation of [3, 6, 8]) {
  const jpeg = makeJpeg(720, 480);
  const bytes = buildTiff({ ifd0: 8, size: 30_000, payloads: [{ at: 20_000, bytes: jpeg }], ifds: [
    previewIfd(8, 720, 480, 20_000, jpeg.length, [{ tag: 274, type: SHORT, values: orientation }])] });
  assert.equal((await locateEmbeddedPreviews(blobOf(bytes))).orientation, orientation);
}

// ---------------------------------------------------------------------------
// Malformed input returns null and never throws
// ---------------------------------------------------------------------------
{
  const cases = new Map();
  cases.set('null', null);
  cases.set('empty', blobOf(new Uint8Array(0)));
  cases.set('png', blobOf(Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...new Array(64).fill(0)])));
  cases.set('jpeg', blobOf(makeJpeg(720, 480)));
  cases.set('random', blobOf(Uint8Array.from({ length: 4096 }, (_, i) => (i * 131 + 7) & 0xFF)));
  const { bytes: m } = m11();
  cases.set('truncated header', blobOf(m.slice(0, 12)));
  cases.set('truncated before IFD entries', blobOf(m.slice(0, 40)));
  // Previews point past the end of a truncated file.
  cases.set('truncated previews', blobOf(m.slice(0, 14_000)));
  const outOfRange = m.slice(); new DataView(outOfRange.buffer).setUint32(4, 10_000_000, true);
  cases.set('IFD0 out of range', blobOf(outOfRange));
  const zeroCount = m.slice(); new DataView(zeroCount.buffer).setUint16(12, 0, true);
  cases.set('empty IFD0', blobOf(zeroCount));
  const hugeCount = m.slice(); new DataView(hugeCount.buffer).setUint16(12, 5000, true);
  cases.set('IFD0 with too many entries', blobOf(hugeCount));
  // A directory that lists itself as its own SubIFD and next IFD, with no preview.
  const cyclic = buildTiff({ ifd0: 8, size: 4096, ifds: [{ at: 8, entries: [{ tag: 256, type: SHORT, values: 10 },
    { tag: 330, type: LONG, values: 8 }], next: 8 }] });
  cases.set('cyclic', blobOf(cyclic));
  // Out-of-range SubIFD array pointer and strip values.
  const badSub = buildTiff({ ifd0: 8, size: 4096, ifds: [{ at: 8, entries: [{ tag: 259, type: SHORT, values: 7 },
    { tag: 262, type: SHORT, values: 6 }, { tag: 273, type: LONG, values: 4000 }, { tag: 279, type: LONG, values: 900 },
    { tag: 330, type: LONG, values: [99_999_999, 5] , at: 200 }] }] });
  cases.set('out-of-range values', blobOf(badSub));
  const throwing = { size: 1_000_000, slice: () => { throw new Error('unreadable'); } };
  cases.set('unreadable blob', throwing);
  for (const [name, input] of cases) {
    assert.equal(await locateEmbeddedPreviews(input), null, `${name} returns null`);
  }
  // A cycle that does contain a preview terminates and reports it once.
  const jpeg = makeJpeg(720, 480);
  const loop = buildTiff({ ifd0: 8, size: 30_000, payloads: [{ at: 20_000, bytes: jpeg }], ifds: [
    { ...previewIfd(8, 720, 480, 20_000, jpeg.length, [{ tag: 330, type: LONG, values: [8, 300], at: 600 }]), next: 300 },
    { at: 300, entries: [{ tag: 256, type: SHORT, values: 1 }], next: 8 }] });
  const once = await locateEmbeddedPreviews(blobOf(loop));
  assert.equal(once.previews.length, 1, 'cyclic IFDs are visited once');
}

// ---------------------------------------------------------------------------
// Shared SOF parser: size floor is a parameter
// ---------------------------------------------------------------------------
{
  const tile = makeJpeg(720, 480);
  assert.deepEqual(parseJpegFrameHeader(tile).width, 720, 'locator floor admits the 720x480 tile preview');
  assert.equal(readJpegDimensionsFromSOF(tile.buffer, 0, tile.length), null, 'HE NEF fallback keeps its 1000 px floor');
  assert.deepEqual(parseJpegFrameHeader(tile.subarray(0, 10)), { truncated: true });
  assert.equal(parseJpegFrameHeader(makeJpeg(720, 480, { sof: 0xC3 })), null);
  assert.equal(parseJpegFrameHeader(makeJpeg(720, 480, { precision: 12, sof: 0xC1 })), null);
  assert.equal(parseJpegFrameHeader(makeJpeg(720, 480, { orientation: 6 })).orientation, 6);
}

assert.equal(isTiffContainerRawName('L1000617.DNG'), true);
assert.equal(isTiffContainerRawName('DSC_8800.NEF'), true);
assert.equal(isTiffContainerRawName('IMG_0001.CR3'), false, 'CR3 is an ISO-BMFF container');
assert.equal(isTiffContainerRawName('frame.raf'), false);
assert.equal(isTiffContainerRawName('scan.tif'), false, 'TIFF scans decode exactly and need no preview');

// ---------------------------------------------------------------------------
// Real fixtures, when present (header reads only)
// ---------------------------------------------------------------------------
const root = fileURLToPath(new URL('../../../', import.meta.url));
const real = {
  'L1009967.dng': { viewer: [2112, 1408], tile: [720, 480], raw: { width: 9536, height: 6336 } },
  'DSC_8800.NEF': { viewer: [1620, 1080], raw: { width: 6064, height: 4040 } },
  '_DSC3111.NEF': { viewer: [1620, 1080] },
  // Adobe DNG Converter: JPEG XL previews are skipped; its baseline 1024 px one is not.
  '_DSC5290.dng': { viewer: [1024, 683] },
};
let checked = 0;
for (const [name, expected] of Object.entries(real)) {
  if (!existsSync(root + name)) continue;
  const found = await locateEmbeddedPreviews(await openAsBlob(root + name));
  assert.ok(found, `${name}: previews located`);
  const viewer = pickForViewer(found.previews, 2200);
  assert.deepEqual([viewer.width, viewer.height], expected.viewer, `${name}: viewer preview`);
  if (expected.tile) {
    const tile = pickForTile(found.previews, 288);
    assert.deepEqual([tile.width, tile.height], expected.tile, `${name}: tile preview`);
    assert.ok(found.bytesRead + tile.length <= 200 * 1024, `${name}: tile path reads ${found.bytesRead + tile.length} B`);
  }
  if (expected.raw) assert.deepEqual(found.rawSize, expected.raw);
  assert.ok(found.bytesRead <= 32 * 1024, `${name}: IFD data read ${found.bytesRead} B`);
  checked++;
}

console.log(`rawEmbeddedPreview tests passed (${checked} real fixture header(s) checked)`);
