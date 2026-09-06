// Standalone Node test for the pure parts of rawFileLoader.js - run with:
// node negative2positive/src/app/rawFileLoader.test.mjs

import assert from 'node:assert/strict';

import {
  tiffIfdToRgb16,
  rawResultToRgb16,
  estimateRawDecodeBytes,
  checkRawDecodeBudget
} from './rawFileLoader.js';

// ---------------------------------------------------------------------------
// 16-bit TIFF must stay 16-bit. UTIF.toRGBA8 keeps only the high byte of each
// sample, so anything that went through it and was then relabelled "16-bit"
// was ×257 padding, not precision.
// ---------------------------------------------------------------------------
function tiffIfd({ width, height, bits, samples, photometric, values, planar }) {
  const data = new Uint16Array(values);
  const ifd = {
    width,
    height,
    t258: new Array(samples).fill(bits),
    t262: [photometric],
    t277: [samples],
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  };
  if (planar) ifd.t284 = [planar];
  return ifd;
}

{
  // 2x1 RGB 16-bit: low bytes carry real information.
  const ifd = tiffIfd({
    width: 2, height: 1, bits: 16, samples: 3, photometric: 2,
    values: [0x1234, 0x5678, 0x9ABC, 0xFEDC, 0x0001, 0xFFFF]
  });
  const wide = tiffIfdToRgb16(ifd);
  assert.ok(wide, '48-bit RGB TIFF must produce a genuine 16-bit plane');
  assert.equal(wide.channels, 3);
  assert.deepEqual(Array.from(wide.rgb16), [0x1234, 0x5678, 0x9ABC, 0xFEDC, 0x0001, 0xFFFF]);
  // The high-byte-only result the old path produced would have been these:
  assert.notDeepEqual(Array.from(wide.rgb16).map(v => v >>> 8), Array.from(wide.rgb16));
}

{
  const ifd = tiffIfd({
    width: 1, height: 2, bits: 16, samples: 1, photometric: 1,
    values: [0x0102, 0xF0F0]
  });
  const wide = tiffIfdToRgb16(ifd);
  assert.ok(wide, '16-bit greyscale TIFF (B&W film scans) must stay 16-bit');
  assert.equal(wide.channels, 1);
  assert.deepEqual(Array.from(wide.rgb16), [0x0102, 0xF0F0]);
}

{
  const ifd = tiffIfd({
    width: 1, height: 1, bits: 16, samples: 4, photometric: 2,
    values: [1, 2, 3, 4]
  });
  assert.equal(tiffIfdToRgb16(ifd).channels, 4);
}

// Everything that is not a plain 16-bit grey/RGB image must fall back to
// UTIF.toRGBA8 instead of being reinterpreted as 16-bit samples.
assert.equal(tiffIfdToRgb16(null), null);
assert.equal(tiffIfdToRgb16({ width: 2, height: 2 }), null, 'no decoded data');
assert.equal(
  tiffIfdToRgb16(tiffIfd({ width: 2, height: 1, bits: 8, samples: 3, photometric: 2, values: [1, 2, 3] })),
  null,
  '8-bit TIFF must not be relabelled 16-bit'
);
assert.equal(
  tiffIfdToRgb16(tiffIfd({ width: 1, height: 1, bits: 16, samples: 4, photometric: 5, values: [1, 2, 3, 4] })),
  null,
  'CMYK is not handled here'
);
assert.equal(
  tiffIfdToRgb16(tiffIfd({ width: 1, height: 1, bits: 16, samples: 3, photometric: 2, values: [1, 2, 3], planar: 2 })),
  null,
  'PlanarConfiguration 2 is not decoded by UTIF'
);
{
  // Truncated payload: refuse rather than read past the end.
  const ifd = tiffIfd({ width: 4, height: 4, bits: 16, samples: 3, photometric: 2, values: [1, 2, 3] });
  assert.equal(tiffIfdToRgb16(ifd), null);
}

// ---------------------------------------------------------------------------
// LibRaw's output shape follows outputBps: 8 -> Uint8Array of w*h*colors,
// 16 -> Uint16Array of the same sample count. Parsing the 8-bit result as
// little-endian byte pairs fused neighbouring samples into garbage.
// ---------------------------------------------------------------------------
{
  const data = new Uint8Array([10, 20, 30, 40, 50, 60]);
  const { rgb16, channels } = rawResultToRgb16({ width: 2, height: 1, colors: 3, bits: 8, data });
  assert.equal(channels, 3);
  assert.deepEqual(Array.from(rgb16), [10 * 257, 20 * 257, 30 * 257, 40 * 257, 50 * 257, 60 * 257]);
  // The old byte-pair reading would have produced this nonsense instead:
  assert.notDeepEqual(Array.from(rgb16), [10 | (20 << 8), 30 | (40 << 8), 50 | (60 << 8), 0, 0, 0]);
}

{
  // Same 8-bit payload, but with no `bits` field to lean on.
  const data = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const { rgb16, channels } = rawResultToRgb16({ width: 2, height: 1, data });
  assert.equal(channels, 3);
  assert.deepEqual(Array.from(rgb16), [257, 514, 771, 1028, 1285, 1542]);
}

{
  const data = new Uint16Array([1000, 2000, 3000, 4000, 5000, 6000]);
  const { rgb16, channels } = rawResultToRgb16({ width: 2, height: 1, colors: 3, bits: 16, data });
  assert.equal(channels, 3);
  assert.equal(rgb16, data, '16-bit output is used as-is, no copy');
}

{
  // 16-bit samples delivered as raw bytes (little-endian pairs).
  const source = new Uint16Array([0x1234, 0x5678, 0x9ABC]);
  const data = new Uint8Array(source.buffer.slice(0));
  const { rgb16 } = rawResultToRgb16({ width: 1, height: 1, colors: 3, bits: 16, data });
  assert.deepEqual(Array.from(rgb16), [0x1234, 0x5678, 0x9ABC]);
}

{
  // Monochrome sensor: one colour channel.
  const data = new Uint8Array([7, 8, 9, 10]);
  const { rgb16, channels } = rawResultToRgb16({ width: 2, height: 2, colors: 1, bits: 8, data });
  assert.equal(channels, 1);
  assert.deepEqual(Array.from(rgb16), [7 * 257, 8 * 257, 9 * 257, 10 * 257]);
}

assert.throws(
  // 9 bytes for 4 pixels is not 1, 3 or 4 samples per pixel in any encoding.
  () => rawResultToRgb16({ width: 2, height: 2, data: new Uint8Array(9) }),
  (err) => err.code === 'RAW_DECODE_GARBLED'
);
assert.throws(
  () => rawResultToRgb16({ width: 2, height: 1, colors: 3, bits: 8, data: new Uint8Array(4) }),
  (err) => err.code === 'RAW_DECODE_GARBLED',
  'a truncated 8-bit payload must not be read past its end'
);
assert.throws(
  () => rawResultToRgb16({ width: 0, height: 0, data: new Uint8Array(0) }),
  (err) => err.code === 'RAW_DECODE_GARBLED'
);

// ---------------------------------------------------------------------------
// Device-memory gating: only devices that report a small budget are affected.
// ---------------------------------------------------------------------------
{
  const mp24 = { w: 6000, h: 4000 };
  const mp60 = { w: 9500, h: 6300 };

  assert.ok(estimateRawDecodeBytes(mp24.w, mp24.h) > 256 * 1024 * 1024);
  assert.ok(estimateRawDecodeBytes(mp60.w, mp60.h) > estimateRawDecodeBytes(mp24.w, mp24.h));

  // Desktop / unknown: never gated.
  assert.equal(checkRawDecodeBudget(mp60.w, mp60.h, NaN).ok, true);
  assert.equal(checkRawDecodeBudget(mp60.w, mp60.h, undefined).ok, true);
  assert.equal(checkRawDecodeBudget(mp60.w, mp60.h, 8).ok, true);

  // 4 GB device: a 24 MP frame still loads, a 60 MP one is refused up front.
  assert.equal(checkRawDecodeBudget(mp24.w, mp24.h, 4).ok, true);
  assert.equal(checkRawDecodeBudget(mp60.w, mp60.h, 4).ok, false);

  // Half-size preview of the same 60 MP frame fits again.
  assert.equal(checkRawDecodeBudget(mp60.w / 2, mp60.h / 2, 4).ok, true);
}

console.log('rawFileLoader.test.mjs passed');
