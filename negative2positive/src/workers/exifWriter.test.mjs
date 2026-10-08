// Standalone Node test for exifWriter.js and the metadata containers - run with:
// node negative2positive/src/workers/exifWriter.test.mjs

import assert from 'node:assert/strict';
import { buildExifPayload, jpegApp1Exif, jpegApp1Xmp, jpegInsertOffset } from './exifWriter.js';
import { parseTiff, TIFF_TAGS, EXIF_TAGS } from './tiffWriter.js';
import * as pako from 'pako';
import { encodeTiffBlob, encodePng16Blob } from './imageEncoders.js';
import { attachMetadataToBlob, listPngChunks, listJpegSegments } from '../app/exportMetadata.js';
import { buildExportMetadata, sanitizeRollMetadata, sanitizeFrameMetadata, frameNumberFor, buildXmpPacket } from '../app/analogMetadata.js';

const roll = { rollName: 'Roll 12', stock: 'Kodak Ultra Max 400', iso: '400', camera: 'Nikon FM2', lens: 'Nikkor 50mm f/1.8', process: 'C-41', lab: 'Corner Lab', date: '2026-09-06' };
const frame = { frameNumber: '31A', notes: 'Land Rover by the fig tree' };
const metadata = buildExportMetadata({ roll, frame, index: 4 });

// Sanitising: control characters and stray whitespace go, ISO keeps digits only.
{
  const safe = sanitizeRollMetadata({ stock: '  Portra\0 400 ', iso: 'ISO 200', date: '2026/09/06', camera: 'X' });
  assert.equal(safe.stock, 'Portra 400');
  assert.equal(safe.iso, '200');
  assert.equal(safe.date, '', 'dates must be ISO YYYY-MM-DD');
  assert.equal(sanitizeFrameMetadata({ frameNumber: ' 12 a ' }).frameNumber, '12A');
  assert.equal(frameNumberFor({}, 4), '5', 'unnumbered frames use their roll position');
  assert.equal(frameNumberFor({ frameNumber: '7' }, 4), '7');
  assert.equal(buildExportMetadata({ roll: {}, frame: {} }), null, 'no metadata, nothing to write');
}

// The standalone EXIF payload parses back with the standard tags.
{
  const parsed = parseTiff(buildExifPayload(metadata.exif));
  assert.equal(parsed.ifd0[TIFF_TAGS.Model].values, 'Nikon FM2');
  assert.equal(parsed.ifd0[TIFF_TAGS.DateTime].values, '2026:09:06 00:00:00');
  assert.match(parsed.ifd0[TIFF_TAGS.ImageDescription].values, /Kodak Ultra Max 400 · frame 31A/);
  assert.deepEqual(parsed.exif[EXIF_TAGS.ISOSpeedRatings].values, [400]);
  assert.equal(parsed.exif[EXIF_TAGS.DateTimeOriginal].values, '2026:09:06 00:00:00');
  assert.equal(parsed.exif[EXIF_TAGS.LensModel].values, 'Nikkor 50mm f/1.8');
  assert.equal(new TextDecoder().decode(parsed.exif[EXIF_TAGS.ExifVersion].raw), '0232');
  const comment = parsed.exif[EXIF_TAGS.UserComment].raw;
  assert.equal(new TextDecoder().decode(comment.subarray(0, 7)), 'UNICODE');
}

// XMP: AnalogExif schema, keywords for stock and lab, escaped text.
{
  const xmp = buildXmpPacket({ roll: { ...roll, lab: 'Lab & Co' }, frame: { notes: 'a < b' }, index: 0 });
  assert.match(xmp, /xmlns:AnalogExif="http:\/\/analogexif\.sourceforge\.net\/ns"/);
  assert.match(xmp, /<AnalogExif:Film>Kodak Ultra Max 400<\/AnalogExif:Film>/);
  assert.match(xmp, /<AnalogExif:ExposureNumber>1<\/AnalogExif:ExposureNumber>/);
  assert.match(xmp, /<AnalogExif:DevelopProcess>C-41<\/AnalogExif:DevelopProcess>/);
  assert.match(xmp, /<dc:subject><rdf:Bag>\s*<rdf:li>Kodak Ultra Max 400<\/rdf:li>\s*<rdf:li>Lab &amp; Co<\/rdf:li>/);
  assert.match(xmp, /<dc:description>.*a &lt; b/s);
  assert.match(xmp, /<exif:ISOSpeedRatings><rdf:Seq><rdf:li>400<\/rdf:li>/);
}

// TIFF: the encoder writes IFD0 descriptive tags, the XMP tag and the Exif sub-IFD.
{
  const pixels = new Uint8ClampedArray(2 * 2 * 4).fill(200);
  const blob = encodeTiffBlob(pixels, 2, 2, 8, metadata);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const parsed = parseTiff(bytes);
  assert.deepEqual(parsed.ifd0[TIFF_TAGS.ImageWidth].values, [2]);
  assert.equal(parsed.ifd0[TIFF_TAGS.Software].values, 'NeoAnalogLab Negative Converter');
  assert.equal(parsed.ifd0[TIFF_TAGS.Model].values, 'Nikon FM2');
  assert.match(new TextDecoder().decode(parsed.ifd0[TIFF_TAGS.XMP].raw), /AnalogExif:Lab>Corner Lab</);
  assert.deepEqual(parsed.exif[EXIF_TAGS.ISOSpeedRatings].values, [400]);
  const stripOffset = parsed.ifd0[TIFF_TAGS.StripOffsets].values[0];
  assert.equal(bytes[stripOffset], 200, 'pixels sit where StripOffsets says');
  assert.deepEqual(parsed.ifd0[TIFF_TAGS.StripByteCounts].values, [16]);
  // Without metadata the file is a plain baseline TIFF.
  const plain = parseTiff(new Uint8Array(await encodeTiffBlob(pixels, 2, 2, 16).arrayBuffer()));
  assert.equal(plain.exif, null);
  assert.equal(plain.ifd0[TIFF_TAGS.XMP], undefined);
  assert.deepEqual(plain.ifd0[TIFF_TAGS.BitsPerSample].values, [16, 16, 16, 16]);
}

// PNG: eXIf and iTXt chunks are spliced in after IHDR; the image data is untouched.
{
  const pixels = new Uint16Array(2 * 2 * 4).fill(30000);
  const png = encodePng16Blob(pixels, 2, 2, pako);
  const withMeta = await attachMetadataToBlob(png, 'png', metadata);
  const chunks = listPngChunks(new Uint8Array(await withMeta.arrayBuffer()));
  // One IDAT per row band, then the zlib trailer in an IDAT of its own.
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'iCCP', 'eXIf', 'iTXt', 'IDAT', 'IDAT', 'IEND']);
  const exif = parseTiff(chunks[2].data);
  assert.deepEqual(exif.exif[EXIF_TAGS.ISOSpeedRatings].values, [400]);
  const itxt = new TextDecoder().decode(chunks[3].data);
  assert.match(itxt, /^XML:com\.adobe\.xmp\0\0\0\0\0<\?xpacket/);
  assert.match(itxt, /AnalogExif:RollId>Roll 12</);
  assert.equal(withMeta.size, png.size + chunks[1].data.length + 12 + chunks[2].data.length + 12 + chunks[3].data.length + 12);
  assert.ok((await attachMetadataToBlob(png, 'png', null)).size > png.size, 'ICC is embedded even without analog metadata');
}

// JPEG: APP1 EXIF and APP1 XMP go after the JFIF APP0 segment.
{
  const jfif = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xFF, 0xDA, 0x00, 0x02, 0xAA, 0xFF, 0xD9]);
  assert.equal(jpegInsertOffset(jfif), 20);
  assert.equal(jpegInsertOffset(new Uint8Array([0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x04])), 2, 'no APP0: right after SOI');
  const withMeta = await attachMetadataToBlob(new Blob([jfif], { type: 'image/jpeg' }), 'jpeg', metadata);
  const bytes = new Uint8Array(await withMeta.arrayBuffer());
  const segments = listJpegSegments(bytes);
  assert.deepEqual(segments.map((s) => s.marker), [0xE0, 0xE2, 0xE1, 0xE1]);
  assert.equal(new TextDecoder().decode(segments[2].data.subarray(0, 4)), 'Exif');
  const exif = parseTiff(segments[2].data.subarray(6));
  assert.equal(exif.exif[EXIF_TAGS.LensModel].values, 'Nikkor 50mm f/1.8');
  assert.match(new TextDecoder().decode(segments[3].data), /^http:\/\/ns\.adobe\.com\/xap\/1\.0\/\0<\?xpacket/);
  assert.deepEqual(Array.from(bytes.subarray(bytes.length - 7)), [0xFF, 0xDA, 0x00, 0x02, 0xAA, 0xFF, 0xD9], 'scan data untouched');
  const exifSeg = jpegApp1Exif(new Uint8Array(10));
  assert.equal((exifSeg[2] << 8) | exifSeg[3], 2 + 6 + 10);
  assert.throws(() => jpegApp1Xmp('x'.repeat(70000)), /too large/);
}

console.log('exifWriter.test.mjs passed');
