// The HDR gain map of the Ultra HDR JPEG: per 4x4 block, the log2 ratio of the
// 16-bit plane's linear-light luminance to the SDR frame's. No DOM and no
// container code, so the export worker can import it without the packer and
// its XMP/TIFF writers (app/gainMapJpeg.js re-exports it).
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const linear = x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
const luminance = (data, i, scale) => 0.2126 * linear(data[i] / scale) + 0.7152 * linear(data[i + 1] / scale) + 0.0722 * linear(data[i + 2] / scale);

// The samples are integer codes, so the EOTF has only 256 or 65536 distinct
// inputs. Each entry is the exact double `linear(code / scale)` returns, and
// the tables stay Float64: Float32 entries would change the map bytes. The
// 512 KB 16-bit table is built on first use, once per realm.
let table8 = null;
let table16 = null;

export function linearTable8() {
  if (!table8) {
    table8 = new Float64Array(256);
    for (let v = 0; v < 256; v++) table8[v] = linear(v / 255);
  }
  return table8;
}

export function linearTable16() {
  if (!table16) {
    table16 = new Float64Array(65536);
    for (let v = 0; v < 65536; v++) table16[v] = linear(v / 65535);
  }
  return table16;
}

const isByteArray = data => data instanceof Uint8ClampedArray || data instanceof Uint8Array;

// The 16-bit plane uses the same sRGB transfer function as the SDR pixels.
// A quantisation-only difference produces a near-identity map. Never invent
// highlight headroom just because the source has 16-bit precision.
export function computeGainMap(sdr, plane16, { step = 4 } = {}) {
  const width = Math.ceil(sdr.width / step), height = Math.ceil(sdr.height / step);
  if (!plane16 || plane16.width !== sdr.width || plane16.height !== sdr.height || plane16.data.length !== sdr.data.length) return null;
  const s = sdr.data, p = plane16.data;
  // Tables for the typed integer planes every caller passes; anything else
  // keeps the per-sample evaluation.
  const exact = isByteArray(s) && p instanceof Uint16Array;
  const L8 = exact ? linearTable8() : null;
  const L16 = exact ? linearTable16() : null;
  const gains = new Float32Array(width * height);
  let max = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let a = 0, b = 0, count = 0;
    const yEnd = Math.min((y + 1) * step, sdr.height), xEnd = Math.min((x + 1) * step, sdr.width);
    // Row-major within the block, `a` and `b` summed separately in the same
    // order as the per-sample form, with the same luminance expression.
    if (exact) {
      for (let yy = y * step; yy < yEnd; yy++) for (let xx = x * step; xx < xEnd; xx++) {
        const i = (yy * sdr.width + xx) * 4;
        a += 0.2126 * L8[s[i]] + 0.7152 * L8[s[i + 1]] + 0.0722 * L8[s[i + 2]];
        b += 0.2126 * L16[p[i]] + 0.7152 * L16[p[i + 1]] + 0.0722 * L16[p[i + 2]];
        count++;
      }
    } else {
      for (let yy = y * step; yy < yEnd; yy++) for (let xx = x * step; xx < xEnd; xx++) {
        const i = (yy * sdr.width + xx) * 4;
        a += luminance(s, i, 255); b += luminance(p, i, 65535); count++;
      }
    }
    const gain = clamp(Math.log2((b / count + 1 / 64) / (a / count + 1 / 64)), 0, 3);
    gains[y * width + x] = gain; max = Math.max(max, gain);
  }
  const gainMax = Math.max(max, 0.001);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < gains.length; i++) {
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = Math.round(gains[i] / gainMax * 255); data[i * 4 + 3] = 255;
  }
  return { width, height, data, gainMax, gainMin: 0 };
}
