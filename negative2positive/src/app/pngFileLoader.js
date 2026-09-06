import UPNGImport from 'upng-js';

const UPNG = (UPNGImport && typeof UPNGImport.decode === 'function')
  ? UPNGImport
  : (UPNGImport && UPNGImport.default && typeof UPNGImport.default.decode === 'function'
    ? UPNGImport.default
    : UPNGImport);

// Samples per pixel for each PNG colour type.
// 0 = greyscale, 2 = truecolour, 3 = palette (one index per pixel),
// 4 = greyscale+alpha, 6 = truecolour+alpha.
const PNG_CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function pngChannelCount(colorType) {
  const channels = PNG_CHANNELS_BY_COLOR_TYPE[colorType];
  return channels === undefined ? 0 : channels;
}

/**
 * True when UPNG.decode's raw `data` is a flat array of 16-bit big-endian
 * samples we can promote losslessly. Palette (ctype 3) never reaches depth 16,
 * and every depth < 16 layout (bit-packed rows, palette indices, tRNS) is
 * UPNG.toRGBA8's job — decoding those by hand produces noise.
 */
export function isNativeSixteenBitPng(colorType, depth) {
  return depth === 16 && pngChannelCount(colorType) > 0 && colorType !== 3;
}

/**
 * Decode a PNG to ImageData.
 *
 * Contract: `__image16` is attached ONLY when the file genuinely carries 16
 * bits per sample. An 8-bit (or palette / low-bit-depth) PNG returns plain
 * ImageData with no 16-bit mirror — silverAdapter promotes on demand, on the
 * cropped region, instead of paying a full-resolution ×257 upscale at load.
 */
export function loadPngFile(buffer) {
  const decoded = UPNG.decode(buffer);
  const { width, height, ctype, depth, data } = decoded;
  const pixelCount = width * height;

  if (!isNativeSixteenBitPng(ctype, depth)) {
    // Palette, tRNS, interlaced and 1/2/4/8-bit rows all live in UPNG's
    // converter. It returns one RGBA8 buffer per (APNG) frame.
    const frames = UPNG.toRGBA8(decoded);
    const rgba8 = new Uint8ClampedArray(frames[0]);
    return new ImageData(rgba8, width, height);
  }

  const channels = pngChannelCount(ctype);
  const hasAlpha = ctype === 4 || ctype === 6;
  const rgba16 = new Uint16Array(pixelCount * 4);
  const final8 = new Uint8ClampedArray(pixelCount * 4);

  for (let i = 0; i < pixelCount; i++) {
    // PNG stores 16-bit samples big-endian; read them straight into the
    // destination instead of materialising a whole endian-swapped mirror.
    const src = i * channels * 2;
    const dst = i * 4;

    const s0 = (data[src] << 8) | data[src + 1];
    const r16 = s0;
    const g16 = channels >= 3 ? (data[src + 2] << 8) | data[src + 3] : s0;
    const b16 = channels >= 3 ? (data[src + 4] << 8) | data[src + 5] : s0;
    let a16 = 65535;
    if (hasAlpha) {
      const alphaOffset = src + (channels - 1) * 2;
      a16 = (data[alphaOffset] << 8) | data[alphaOffset + 1];
    }

    rgba16[dst] = r16;
    rgba16[dst + 1] = g16;
    rgba16[dst + 2] = b16;
    rgba16[dst + 3] = a16;

    final8[dst] = r16 >>> 8;
    final8[dst + 1] = g16 >>> 8;
    final8[dst + 2] = b16 >>> 8;
    final8[dst + 3] = a16 >>> 8;
  }

  const imageData = new ImageData(final8, width, height);
  imageData.__image16 = { width, height, data: rgba16 };
  return imageData;
}
