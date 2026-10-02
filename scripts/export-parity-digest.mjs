// Parity digests of exported files: what a reader decodes, not the encoder's
// byte stream (#229 review, R1-038 = R1-100 = R1-128, R1-144). #257 (flagged)
// writes a PNG16 as row bands, so its file bytes differ from 1703835's while
// its samples are equal; a whole-file hash cannot tell that from a real 16-bit
// regression. Per format:
//   PNG   the IHDR fields, SHA-256 of the samples (UPNG's unfiltered rows, as
//         scripts/perf/lib/export-verify.mjs decodes them, cut to
//         height x bytes-per-row: UPNG leaves the last row's filtered tail
//         after them, which follows the encoder's filter choice) and SHA-256
//         of every chunk but IDAT, IEND and tIME (a clock time), type and
//         data, in file order.
//   TIFF  SHA-256 of the whole file (uncompressed strips and an IFD the app
//         writes; no flagged change touches them).
//   JPEG  SHA-256 of the primary image decoded to RGBA (the bytes before the
//         MPF index's second image, no colour conversion, so a gain map is
//         never applied), SHA-256 of the primary's APPn and COM segments but
//         the MPF index (offsets that follow the encoded sizes), and SHA-256
//         and length of the gain-map image's bytes from the MPF index.
//   Anything else: SHA-256 of the whole file.
// The exports carry no clock time (their EXIF and XMP dates are the roll's,
// from the recipe), so no JPEG field is left out.
//
// exportParityDigest runs in the page (PAGE_EXPORT_DIGEST installs it with
// UPNG and its pako from node_modules as window.__ncExportDigest) and in Node
// (export-parity-digest.test.mjs). It must not use anything outside itself.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * @param {Uint8Array} bytes one exported file
 * @param {{ UPNG: object, sha256: (bytes: Uint8Array) => Promise<string>,
 *   decodeJpeg: (bytes: Uint8Array) => Promise<{ width: number, height: number, data: Uint8Array | Uint8ClampedArray }> }} io
 */
export async function exportParityDigest(bytes, { UPNG, sha256, decodeJpeg }) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start, end) => String.fromCharCode(...bytes.subarray(start, end));
  const concat = (parts) => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
  };

  if (bytes.length > 8 && bytes[0] === 0x89 && ascii(1, 4) === 'PNG') {
    const kept = [], types = [];
    for (let at = 8; at + 8 <= bytes.length;) {
      const length = view.getUint32(at);
      const type = ascii(at + 4, at + 8);
      if (type !== 'IDAT' && type !== 'IEND' && type !== 'tIME') {
        kept.push(bytes.subarray(at + 4, at + 8 + length));
        types.push(type);
      }
      at += 12 + length;
      if (type === 'IEND') break;
    }
    const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
    const png = UPNG.decode(whole ? bytes.buffer : bytes.slice().buffer);
    const data = png.data instanceof Uint8Array ? png.data : new Uint8Array(png.data);
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[png.ctype];
    const samples = channels ? data.subarray(0, Math.ceil(png.width * channels * png.depth / 8) * png.height) : data;
    return {
      format: 'png', width: png.width, height: png.height, depth: png.depth, ctype: png.ctype,
      samples: await sha256(samples), chunks: types.join(','), metadata: await sha256(concat(kept))
    };
  }

  if (bytes.length > 4 && bytes[0] === 0xFF && bytes[1] === 0xD8) {
    // Segments before the first scan, and the MPF index's images (offsets
    // count from the index's TIFF header).
    const metadata = [], markers = [];
    let images = null;
    for (let at = 2; at + 4 <= bytes.length && bytes[at] === 0xFF;) {
      const marker = bytes[at + 1];
      if (marker === 0xDA || marker === 0xD9) break;
      const length = view.getUint16(at + 2);
      const isMpf = marker === 0xE2 && ascii(at + 4, at + 8) === 'MPF\0';
      if (isMpf) {
        const tiff = at + 8;
        const little = bytes[tiff] === 0x49;
        const ifd = tiff + view.getUint32(tiff + 4, little);
        for (let i = 0, count = view.getUint16(ifd, little); i < count; i++) {
          const entry = ifd + 2 + i * 12;
          if (view.getUint16(entry, little) !== 0xB002) continue;
          const list = tiff + view.getUint32(entry + 8, little);
          images = [];
          for (let k = 0; k < view.getUint32(entry + 4, little) / 16; k++) {
            const size = view.getUint32(list + k * 16 + 4, little);
            const offset = view.getUint32(list + k * 16 + 8, little);
            images.push({ start: k === 0 ? 0 : tiff + offset, size });
          }
        }
      } else if ((marker >= 0xE0 && marker <= 0xEF) || marker === 0xFE) {
        metadata.push(bytes.subarray(at + 1, at + 2 + length));
        markers.push(marker === 0xFE ? 'COM' : 'APP' + (marker - 0xE0));
      }
      at += 2 + length;
    }
    const primary = images && images[0].size ? bytes.subarray(0, images[0].size) : bytes;
    const gain = images && images[1] ? bytes.subarray(images[1].start, images[1].start + images[1].size) : null;
    const decoded = await decodeJpeg(primary);
    return {
      format: 'jpeg', width: decoded.width, height: decoded.height,
      pixels: await sha256(decoded.data instanceof Uint8Array ? decoded.data : new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength)),
      segments: markers.join(','), metadata: await sha256(concat(metadata)),
      gainMap: gain ? { bytes: gain.length, sha256: await sha256(gain) } : null
    };
  }

  const tiff = bytes.length > 4 && ((bytes[0] === 0x49 && bytes[1] === 0x49) || (bytes[0] === 0x4D && bytes[1] === 0x4D));
  return { format: tiff ? 'tiff' : 'file', size: bytes.length, file: await sha256(bytes) };
}

const require = createRequire(import.meta.url);
const upngPath = require.resolve('upng-js');
const pakoPath = createRequire(upngPath).resolve('pako/dist/pako_inflate.min.js');

// Installs window.__ncExportDigest(bytes) in the page. UPNG and pako are
// UMD scripts: run with `window` shadowed and no module system, they put
// themselves on that scope and nowhere else.
export const PAGE_EXPORT_DIGEST = `(() => {
  if (window.__ncExportDigest) return;
  const scope = {};
  (function (window, exports, module, define, require) {
${readFileSync(pakoPath, 'utf8')}
${readFileSync(upngPath, 'utf8')}
  })(scope);
  const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
  const sha256 = async (bytes) => hex(await crypto.subtle.digest('SHA-256', bytes));
  const decodeJpeg = async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
  };
  const digest = ${exportParityDigest.toString()};
  window.__ncExportDigest = (bytes) => digest(bytes, { UPNG: scope.UPNG, sha256, decodeJpeg });
})()`;
