// Synthetic LibRaw imageData() results for the post-decode tests: a smooth
// orange-mask negative with grain, a few stuck photosites smeared the way AHD
// smears them, laid out in every shape LibRaw (or a caller) can hand over.
// Not a test file itself; imported by rawPostDecode*.test.mjs and
// rawFileLoader.postDecode.test.mjs.

function makeRng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * @param {{ width: number, height: number, seed?: number, channels?: 1|3|4, bits?: 8|16,
 *   asBytes?: boolean, byteOffset?: number, padding?: number, dropBits?: boolean, snow?: boolean }} spec
 */
export function makeRawResult({
  width, height, seed = 1, channels = 3, bits = 16,
  asBytes = false, byteOffset = 0, padding = 0, dropBits = false, snow = false
}) {
  const rnd = makeRng(seed);
  const max = bits === 8 ? 255 : 65535;
  const pixelCount = width * height;
  const samples = new Float64Array(pixelCount * channels);
  const base = [0.72, 0.46, 0.27, 1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const g = 1 + 0.15 * (x / width) - 0.1 * (y / height);
      for (let c = 0; c < channels; c++) {
        const i = (y * width + x) * channels + c;
        if (channels === 4 && c === 3) { samples[i] = max; continue; }
        const level = snow ? rnd() : base[channels === 1 ? 1 : c] * g * (1 + (rnd() - 0.5) * 0.03);
        samples[i] = level * max;
      }
    }
  }
  if (!snow) {
    // Stuck photosites (single channel, smeared), well inside the frame.
    const spread = [[0, 0, 1], [1, 0, 0.5], [-1, 0, 0.5], [0, 1, 0.5], [0, -1, 0.5], [1, 1, 0.25], [-1, 1, 0.25], [1, -1, 0.25], [-1, -1, 0.25]];
    const count = 3 + Math.floor(rnd() * 4);
    for (let n = 0; n < count; n++) {
      const x = 4 + Math.floor(rnd() * (width - 8));
      const y = 4 + Math.floor(rnd() * (height - 8));
      const c = channels === 1 ? 0 : Math.floor(rnd() * 3);
      const stuck = rnd() < 0.5 ? 0 : max;
      for (const [dx, dy, f] of spread) {
        const i = ((y + dy) * width + (x + dx)) * channels + c;
        samples[i] += (stuck - samples[i]) * f;
      }
    }
  }
  const total = samples.length + padding;
  let data;
  if (bits === 8) {
    const buffer = new ArrayBuffer(byteOffset + total);
    data = new Uint8Array(buffer, byteOffset, total);
    for (let i = 0; i < samples.length; i++) data[i] = Math.max(0, Math.min(255, Math.round(samples[i])));
  } else if (asBytes) {
    const buffer = new ArrayBuffer(byteOffset + total * 2);
    data = new Uint8Array(buffer, byteOffset, total * 2);
    for (let i = 0; i < samples.length; i++) {
      const v = Math.max(0, Math.min(65535, Math.round(samples[i])));
      data[i * 2] = v & 0xFF;
      data[i * 2 + 1] = v >> 8;
    }
  } else {
    const buffer = new ArrayBuffer(byteOffset + total * 2);
    data = new Uint16Array(buffer, byteOffset, total);
    for (let i = 0; i < samples.length; i++) data[i] = Math.max(0, Math.min(65535, Math.round(samples[i])));
  }
  for (let i = samples.length; i < total; i++) data[i] = 12345 & (bits === 8 ? 0xFF : 0xFFFF);
  const result = { width, height, colors: channels, data };
  if (!dropBits) result.bits = bits;
  return result;
}

/** A deep copy with the same buffer layout (offset, trailing bytes). */
export function cloneRawResult(result) {
  const { data } = result;
  const copy = new data.constructor(data.buffer.slice(0), data.byteOffset, data.length);
  return { ...result, data: copy };
}
