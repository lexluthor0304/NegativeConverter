#!/usr/bin/env node
// Re-encode a PNG as 8-bit opaque RGB (colour type 2). App Store screenshots
// must not carry an alpha channel and `xcrun simctl io screenshot` writes
// RGBA, so scripts/ios-store-screenshots.sh runs every capture through this
// before scripts/check-ios-store-assets.mjs sees it.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';

const UPNG = createRequire(import.meta.url)('upng-js');
const [, , input, output] = process.argv;
if (!input || !output) {
  console.error('usage: png-to-rgb.mjs <in.png> <out.png>');
  process.exit(2);
}

const png = UPNG.decode(readFileSync(input));
const { width, height } = png;
const rgba = new Uint8Array(UPNG.toRGBA8(png)[0]);
if (rgba.length !== width * height * 4) throw new Error(`${input}: incomplete decode`);

// One filter byte (0 = none) per scanline, then RGB triples.
const raw = Buffer.alloc((width * 3 + 1) * height);
for (let y = 0, i = 0, o = 0; y < height; y++) {
  raw[o++] = 0;
  for (let x = 0; x < width; x++, i += 4) {
    raw[o++] = rgba[i];
    raw[o++] = rgba[i + 1];
    raw[o++] = rgba[i + 2];
  }
}

const table = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  table[n] = c >>> 0;
}
const crc32 = (buffer) => {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width, 0);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // colour type: truecolour, no alpha
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

writeFileSync(output, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]));
console.log(`${output}: ${width}x${height} RGB`);
