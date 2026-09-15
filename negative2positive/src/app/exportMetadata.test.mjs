import assert from 'node:assert/strict';
import { inflate, deflate } from 'pako';
import { readFileSync } from 'node:fs';
import { SRGB_PROFILE } from './srgbProfile.js';
import { attachMetadataToBlob, listPngChunks, listJpegSegments } from './exportMetadata.js';
import { encodePng16Blob, encodeTiffBlob, createPngChunk } from '../workers/imageEncoders.js';
import { parseTiff } from '../workers/tiffWriter.js';
assert.deepEqual(SRGB_PROFILE, new Uint8Array(readFileSync(new URL('../../public/color/sRGB-v4.icc', import.meta.url))));
const samples = new Uint16Array(16).fill(32768);
for (const metadata of [null, { xmp: '<test/>' }]) {
 const png = await attachMetadataToBlob(encodePng16Blob(samples, 2, 2, deflate), 'png', metadata);
 const profile = listPngChunks(new Uint8Array(await png.arrayBuffer())).find(c => c.type === 'iCCP').data;
 assert.deepEqual(inflate(profile.subarray(6)), SRGB_PROFILE);
 const jpeg = await attachMetadataToBlob(new Blob([new Uint8Array([255,216,255,218,0,2,255,217])]), 'jpeg', metadata);
 const icc = listJpegSegments(new Uint8Array(await jpeg.arrayBuffer())).find(s => s.marker === 226).data;
 assert.deepEqual(icc.subarray(14), SRGB_PROFILE);
 const tiff = parseTiff(new Uint8Array(await encodeTiffBlob(samples, 2, 2, 16, metadata).arrayBuffer()));
 assert.deepEqual(new Uint8Array(tiff.ifd0[34675].values), SRGB_PROFILE);
}
console.log('ICC: exact profile round trip in PNG/JPEG/TIFF with and without analog metadata passed');

// A large canvas PNG can have thousands of IDAT chunks. Metadata insertion
// must preserve the compressed tail without reading each individual header.
const basePng = encodePng16Blob(samples, 2, 2, deflate);
const tail = new Blob([
  ...Array.from({ length: 2048 }, () => createPngChunk('IDAT', new Uint8Array([1, 2, 3]))),
  createPngChunk('iTXt', new TextEncoder().encode('retained text')),
  createPngChunk('IEND', new Uint8Array())
]);
const fragmented = new Blob([basePng.slice(0, 33), createPngChunk('sRGB', new Uint8Array([0])), tail]);
const originalSlice = fragmented.slice.bind(fragmented);
let slices = 0;
fragmented.slice = (...args) => { slices++; return originalSlice(...args); };
const tagged = await attachMetadataToBlob(fragmented, 'png', null);
assert.ok(slices < 10, `Read too many PNG chunks: ${slices}`);
const taggedBytes = new Uint8Array(await tagged.arrayBuffer());
const taggedChunks = listPngChunks(taggedBytes);
assert.equal(taggedChunks.some(chunk => chunk.type === 'sRGB'), false);
assert.equal(taggedChunks.filter(chunk => chunk.type === 'iCCP').length, 1);
assert.deepEqual(taggedBytes.slice(-tail.size), new Uint8Array(await tail.arrayBuffer()));
