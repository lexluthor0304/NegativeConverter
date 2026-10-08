import assert from 'node:assert/strict';
import {
  parseImageDimensions, readImageHeaderDimensions, imagePixelsForBatch, imagePixelsWithSiblings, rememberImageDimensions,
  halfDecodeFullSize, resolveHalfDecodeFullSize, knownImageDimensions, UNKNOWN_IMAGE_PIXELS, PHOTOMETRIC_CFA, PHOTOMETRIC_LINEAR_RAW
} from './imageDimensions.js';
import { planBatchParallelism } from './batchExportScheduler.js';
import { buildLinearDngParts } from './linearDng.js';
import { createThumbnailSourceCache } from './thumbnailSources.js';
globalThis.ImageData ||= class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const { reducedTileGeometry, renderReducedGeometry, tileGeometryKey } = await import('./reducedGeometry.js');
const png = new Uint8Array(24);
const pv = new DataView(png.buffer);
pv.setUint32(0, 0x89504e47); pv.setUint32(4, 0x0d0a1a0a);
pv.setUint32(16, 12000); pv.setUint32(20, 8000);
const file = new File([png], 'compressed.png');
assert.equal(await imagePixelsForBatch(file), 96_000_000);
assert.equal(planBatchParallelism({ hardwareConcurrency: 16, deviceMemory: 16, pixelsPerFile: await imagePixelsForBatch(file), fileCount: 36 }), 1);
const jpeg = Uint8Array.from([255,216,255,224,0,4,0,0,255,192,0,7,8,0x1f,0x40,0x2e,0xe0]);
assert.deepEqual(parseImageDimensions(jpeg.buffer), { width: 12000, height: 8000 });
for (const little of [true, false]) {
  const tiff = new ArrayBuffer(50), v = new DataView(tiff);
  v.setUint16(0, little ? 0x4949 : 0x4d4d); v.setUint16(2,42,little); v.setUint32(4,8,little); v.setUint16(8,3,little);
  [[256,12000],[257,8000],[262,32803]].forEach(([tag,value],i) => {
    const at = 10 + i * 12; v.setUint16(at,tag,little); v.setUint16(at+2,4,little); v.setUint32(at+4,1,little); v.setUint32(at+8,value,little);
  });
  // The matched IFD's PhotometricInterpretation comes with the size (#255).
  assert.deepEqual(parseImageDimensions(tiff, {raw:true}), {width:12000,height:8000,photometric:32803});
  v.setUint32(42,2,little);
  assert.equal(parseImageDimensions(tiff, {raw:true}), null, 'RAW embedded preview is not sensor dimensions');
  assert.deepEqual(parseImageDimensions(tiff), {width:12000,height:8000,photometric:2});
}
for (let n = 0; n < 24; n++) assert.equal(parseImageDimensions(png.buffer.slice(0,n)), null);
const unknown = new File(['invalid'], 'unknown.heic');
assert.equal(await imagePixelsForBatch(unknown), UNKNOWN_IMAGE_PIXELS);
rememberImageDimensions(unknown, {width:4000,height:3000});
assert.equal(await imagePixelsForBatch(unknown), 12_000_000);
// #258: a header without a size borrows a decoded file's of the same
// extension (one camera, one roll); another extension or none stays unknown.
{
  const decoded = new File(['x'], 'L1000617.RW2');
  const next = new File(['y'], 'L1000618.rw2');
  const other = new File(['z'], 'scan.orf');
  assert.equal(await imagePixelsWithSiblings(next, [decoded, other]), UNKNOWN_IMAGE_PIXELS, 'nothing decoded yet');
  rememberImageDimensions(decoded, { width: 9536, height: 6336 });
  assert.equal(await imagePixelsWithSiblings(next, [decoded, other]), 9536 * 6336);
  assert.equal(await imagePixelsWithSiblings(other, [decoded, next]), UNKNOWN_IMAGE_PIXELS);
  // A size of its own always wins.
  rememberImageDimensions(next, { width: 100, height: 50 });
  assert.equal(await imagePixelsWithSiblings(next, [decoded]), 5000);
}
let bytesRead = 0;
await imagePixelsForBatch({name:'large.png', slice(start,end) { bytesRead += end-start; return new Blob([png]); }});
assert.equal(bytesRead, 256*1024);

// The full size behind a half-size LibRaw decode (#229 review R1-080). LibRaw
// halves only mosaic data: a decode at the reported size (LibRaw's metadata,
// or the header's raw IFD), or of a LinearRaw IFD, is its own full size,
// never twice it; one at half the reported size has that size.
assert.deepEqual(halfDecodeFullSize(6000, 4000, 6000, 4000), { width: 6000, height: 4000 }, 'unshrunk: not doubled');
assert.deepEqual(halfDecodeFullSize(4000, 6000, 6000, 4000), { width: 4000, height: 6000 }, 'unshrunk, the report the other way round');
assert.deepEqual(halfDecodeFullSize(6001, 3999, 6000, 4000), { width: 6001, height: 3999 }, 'within a pixel');
assert.deepEqual(halfDecodeFullSize(3000, 2000, 6000, 4000), { width: 6000, height: 4000 }, 'halved');
assert.deepEqual(halfDecodeFullSize(2000, 3000, 6000, 4000), { width: 4000, height: 6000 }, 'halved, the report the other way round');
assert.deepEqual(halfDecodeFullSize(3000, 2000), { width: 3000, height: 2000 }, 'no report cannot prove a half-size result');
assert.deepEqual(halfDecodeFullSize(240, 160, 242, 162), { width: 240, height: 160 }, 'mismatched full report cannot prove shrinking');
for (const report of [[NaN, Infinity], [Infinity, 320], [480, NaN]]) {
  assert.deepEqual(halfDecodeFullSize(240, 160, ...report), { width: 240, height: 160 }, 'non-finite reports cannot change geometry');
}
assert.deepEqual(halfDecodeFullSize(240, 160, 0, 0, { photometric: PHOTOMETRIC_LINEAR_RAW }), { width: 240, height: 160 }, 'a LinearRaw IFD is never halved');
assert.deepEqual(halfDecodeFullSize(120, 80, 240, 160, { photometric: PHOTOMETRIC_CFA }), { width: 240, height: 160 }, 'a CFA IFD is');
const knownFullSize = { width: 240, height: 160 };
assert.deepEqual(resolveHalfDecodeFullSize(240, 160, { knownFullSize, metadataSize: { width: 480, height: 320 } }), knownFullSize,
  'an earlier full decode defeats misleading doubled metadata');
assert.deepEqual(resolveHalfDecodeFullSize(120, 80, { knownFullSize }), knownFullSize, 'missing metadata cannot erase a proven half match');
assert.equal(resolveHalfDecodeFullSize(120, 80), null, 'unknown shrinkage requires a full decode');
assert.equal(resolveHalfDecodeFullSize(100, 70, { knownFullSize, metadataSize: { width: 200, height: 140 } }), null,
  'mismatched earlier full evidence is not replaced by metadata');
const cfaSize = { ...knownFullSize, photometric: PHOTOMETRIC_CFA };
assert.deepEqual(resolveHalfDecodeFullSize(120, 80, { headerSize: cfaSize, metadataSize: { width: 120, height: 80 } }), knownFullSize,
  'metadata at decoded dimensions cannot hide the independent CFA half match');
assert.deepEqual(resolveHalfDecodeFullSize(240, 160, { headerSize: cfaSize, metadataSize: { width: 480, height: 320 } }), knownFullSize,
  'the independent CFA full match defeats misleading metadata');
const headerOnly = new File([png], 'header-only.png');
await imagePixelsForBatch(headerOnly);
assert.equal(knownImageDimensions(headerOnly), null, 'a memory-planning header is not an earlier full decode');
rememberImageDimensions(headerOnly, knownFullSize);
assert.deepEqual(knownImageDimensions(headerOnly), knownFullSize);

// The app's own LinearRaw DNG export, 240x160, re-imported with a recipe
// whose tile takes a half-size decode (#247 1b). LibRaw cannot halve it and
// returns the 240x160 frame (libraw-wasm 1.6.0: metadata 240x160, filters 0),
// so the decode is the full frame, with LibRaw's size or the header's, and
// the tile shows the recipe's crop. A doubled base size (twice the decode,
// what was assumed) framed the region at half the crop's offset and size.
{
  const width = 240, height = 160;
  const linear = new Uint16Array(width * height * 3);
  const rgba16 = new Uint16Array(width * height * 4);
  const rgba8 = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rgb = [x * 256, y * 256, 4096];
      for (let c = 0; c < 3; c++) {
        linear[(y * width + x) * 3 + c] = rgb[c];
        rgba16[(y * width + x) * 4 + c] = rgb[c];
        rgba8[(y * width + x) * 4 + c] = rgb[c] >>> 8;
      }
      rgba16[(y * width + x) * 4 + 3] = 65535;
      rgba8[(y * width + x) * 4 + 3] = 255;
    }
  }
  const parts = buildLinearDngParts({ width, height, data: linear });
  const dng = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { dng.set(part, at); at += part.length; }
  const header = parseImageDimensions(dng.buffer, { raw: true });
  assert.deepEqual(header, { width, height, photometric: PHOTOMETRIC_LINEAR_RAW });
  assert.deepEqual(await readImageHeaderDimensions(new File([dng], 'L1000617-positive.dng'), { raw: true }), header);
  // LibRaw's half-size result: the frame itself (here its RGBA planes).
  const decoded = new ImageData(rgba8, width, height);
  decoded.__image16 = { width, height, data: rgba16 };
  const recipe = { rotationAngle: 0, mirrored: false, cropRegion: { left: 60, top: 40, width: 96, height: 64 } };
  const tileOf = (baseSize) => {
    const frame = reducedTileGeometry(baseSize, recipe, 288);
    return renderReducedGeometry(decoded, recipe, { step: frame.step, fullWidth: baseSize.width, fullHeight: baseSize.height });
  };
  for (const [label, full] of [
    ['LibRaw\'s size', halfDecodeFullSize(width, height, width, height)],
    ['the header\'s size', halfDecodeFullSize(width, height, header.width, header.height, { photometric: header.photometric })],
    ['missing report', halfDecodeFullSize(width, height)],
    ['mismatched report', halfDecodeFullSize(width, height, width + 2, height + 2)],
    ['misleading half report with LinearRaw evidence', halfDecodeFullSize(width, height, width * 2, height * 2, { photometric: header.photometric })]
  ]) {
    assert.deepEqual(full, { width, height }, `${label}: the decode is the full frame`);
    const tile = tileOf(full);
    assert.deepEqual([tile.width, tile.height], [96, 64], `${label}: the crop's size`);
    for (const [x, y] of [[0, 0], [95, 0], [0, 63], [95, 63], [40, 30]]) {
      const i = (y * tile.width + x) * 4;
      assert.deepEqual([tile.__image16.data[i], tile.__image16.data[i + 1]], [(60 + x) * 256, (40 + y) * 256], `${label}: tile pixel ${x},${y}`);
    }
    const cache = createThumbnailSourceCache(), item = {};
    assert.equal(cache.put(item, { working: tile, baseSize: full, geometryKey: tileGeometryKey(recipe, full) }), true);
    const changedColours = { ...recipe, coreContrast: 17 };
    const retained = cache.lookup(item, size => tileGeometryKey(changedColours, size));
    assert.deepEqual(retained.baseSize, { width, height }, `${label}: a retained tile never stores doubled geometry`);
    assert.deepEqual(retained.working.__image16.data, tile.__image16.data, `${label}: colour changes reuse the correctly framed pixels`);
  }
  const doubled = tileOf({ width: width * 2, height: height * 2 });
  assert.deepEqual([doubled.width, doubled.height], [48, 32], 'a doubled base size frames half the crop');
  assert.deepEqual([doubled.__image16.data[0], doubled.__image16.data[1]], [30 * 256, 20 * 256], 'at half its offset');
}
console.log('Batch dimensions: compressed images, TIFF endianness/RAW previews, truncated headers and bounded IO passed');
