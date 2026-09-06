// Standalone Node test for tiffWriter.js - run with:
// node negative2positive/src/workers/tiffWriter.test.mjs

import assert from 'node:assert/strict';
import {
  buildTiff, buildTiffParts, parseTiff, asciiEntry, shortEntry, longEntry, rationalEntry,
  srationalEntry, bytesEntry, doubleEntry, TIFF_TAGS, TIFF_TYPES
} from './tiffWriter.js';

// Inline and out-of-line values, sorted tags, an Exif sub-IFD and a data block
// all come back through the reader with the right offsets.
{
  const strip = new Uint8Array([1, 2, 3, 4, 5]); // odd length: padded
  const bytes = buildTiff({
    entries: [
      asciiEntry(TIFF_TAGS.Software, 'NeoAnalogLab'),
      longEntry(TIFF_TAGS.ImageWidth, 3),
      shortEntry(TIFF_TAGS.BitsPerSample, [8, 8, 8]),
      shortEntry(TIFF_TAGS.Compression, 1),
      rationalEntry(50, [[72, 1], 0.5]),
      srationalEntry(51, [-1.25]),
      doubleEntry(52, [Math.PI]),
      bytesEntry(TIFF_TAGS.XMP, new TextEncoder().encode('<x/>'), TIFF_TYPES.BYTE)
    ],
    exif: [shortEntry(34855, 400), asciiEntry(36867, '2026:09:06 00:00:00')],
    blocks: [{ tag: TIFF_TAGS.StripOffsets, bytes: strip }]
  });
  assert.equal(bytes[0], 0x49);
  const parsed = parseTiff(bytes);
  assert.equal(parsed.ifd0[TIFF_TAGS.Software].values, 'NeoAnalogLab');
  assert.deepEqual(parsed.ifd0[TIFF_TAGS.ImageWidth].values, [3]);
  assert.deepEqual(parsed.ifd0[TIFF_TAGS.BitsPerSample].values, [8, 8, 8], 'three shorts live out of line');
  assert.deepEqual(parsed.ifd0[TIFF_TAGS.Compression].values, [1], 'one short lives inline');
  assert.deepEqual(parsed.ifd0[50].values, [[72, 1], [5000, 10000]]);
  assert.deepEqual(parsed.ifd0[51].values, [[-12500, 10000]]);
  assert.ok(Math.abs(parsed.ifd0[52].values[0] - Math.PI) < 1e-12);
  assert.equal(new TextDecoder().decode(parsed.ifd0[TIFF_TAGS.XMP].raw), '<x/>');
  const tags = Object.keys(parsed.ifd0).map(Number);
  assert.deepEqual(tags, [...tags].sort((a, b) => a - b), 'entries are sorted by tag');
  assert.deepEqual(parsed.exif[34855].values, [400]);
  assert.equal(parsed.exif[36867].values, '2026:09:06 00:00:00');
  const stripOffset = parsed.ifd0[TIFF_TAGS.StripOffsets].values[0];
  assert.deepEqual(Array.from(bytes.subarray(stripOffset, stripOffset + 5)), [1, 2, 3, 4, 5]);
  assert.equal(bytes.length, stripOffset + 6, 'odd block padded to an even length');
  assert.equal(bytes.length % 2, 0);
}

// Parts keep the strip buffer itself (no copy) and join to the same bytes.
{
  const strip = new Uint8Array(1000).fill(7);
  const spec = { entries: [longEntry(TIFF_TAGS.ImageWidth, 10)], blocks: [{ tag: TIFF_TAGS.StripOffsets, bytes: strip }] };
  const parts = buildTiffParts(spec);
  assert.equal(parts[1], strip, 'the strip is passed through by reference');
  const whole = buildTiff(spec);
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { joined.set(p, o); o += p.length; }
  assert.deepEqual(Array.from(whole), Array.from(joined));
}

// Several blocks under one tag become one offset array (multi-strip files).
{
  const bytes = buildTiff({
    entries: [longEntry(TIFF_TAGS.ImageWidth, 1)],
    blocks: [
      { tag: TIFF_TAGS.StripOffsets, bytes: new Uint8Array([9, 9]) },
      { tag: TIFF_TAGS.StripOffsets, bytes: new Uint8Array([8, 8, 8, 8]) }
    ]
  });
  const parsed = parseTiff(bytes);
  const [a, b] = parsed.ifd0[TIFF_TAGS.StripOffsets].values;
  assert.equal(b - a, 2);
  assert.equal(bytes[a], 9);
  assert.equal(bytes[b], 8);
}

console.log('tiffWriter.test.mjs passed');
