// #264 Part A phase 2: the scan decoders (16-bit TIFF, 16-bit PNG) build their
// RGBA16 plane with the caller's allocator, so the editor's scans live in
// shared memory like its RAW decodes, with the same samples; the 8-bit plane
// is that plane >>> 8.
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';

globalThis.ImageData ||= class ImageData { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
const { decodeTiffBuffer } = await import('./tiffFileLoader.js');
const { loadPngFile } = await import('./pngFileLoader.js');
const { encodeTiffBlob } = await import('../workers/imageEncoders.js');
const { allocPlane16, isSharedPlane } = await import('./crossOriginIsolation.js');

const isolated = { crossOriginIsolated: true, SharedArrayBuffer };
const shared = (length) => allocPlane16(length, { shared: true, env: isolated });
const W = 37, H = 23;
const samples = new Uint16Array(W * H * 4);
for (let i = 0; i < samples.length; i++) samples[i] = (i & 3) === 3 ? 65535 : (i * 2654435761) >>> 16;

function checkPair(plain, sharedImage, label) {
  assert.equal(isSharedPlane(plain.__image16.data), false, `${label}: plain by default`);
  assert.ok(isSharedPlane(sharedImage.__image16.data), `${label}: shared with the allocator`);
  assert.deepEqual([...sharedImage.__image16.data], [...plain.__image16.data], `${label}: the same 16-bit samples`);
  assert.deepEqual([...sharedImage.data], [...plain.data], `${label}: the same 8-bit plane`);
  for (let i = 0; i < sharedImage.data.length; i++) {
    if (sharedImage.data[i] !== (sharedImage.__image16.data[i] >>> 8)) assert.fail(`${label}: the 8-bit plane is the 16-bit one >>> 8`);
  }
}

// 16-bit TIFF (RGB, the app's own writer).
{
  const blob = encodeTiffBlob(samples, W, H, 16);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  checkPair(decodeTiffBuffer(bytes.slice().buffer), decodeTiffBuffer(bytes.slice().buffer, { alloc: shared }), 'TIFF16');
}

// 16-bit PNG (RGBA, big-endian samples).
{
  const crc = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); table[n] = c >>> 0; }
    return (bytes) => { let c = 0xFFFFFFFF; for (const b of bytes) c = table[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  })();
  const chunk = (type, payload) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(payload)]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(payload.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 16; ihdr[9] = 6;
  const raw = Buffer.alloc(H * (1 + W * 8));
  for (let y = 0; y < H; y++) for (let x = 0; x < W * 4; x++) raw.writeUInt16BE(samples[y * W * 4 + x], y * (1 + W * 8) + 1 + x * 2);
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  const buffer = () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
  checkPair(loadPngFile(buffer()), loadPngFile(buffer(), { alloc: shared }), 'PNG16');
}
console.log('scan decoders: 16-bit planes built with the caller\'s (shared) allocator');
