// Local exposure (dodge and burn) pixel operation shared by the engine and the
// app: multiplies a 16-bit RGBA negative by 2^stops per pixel in linear light.
// The data is display-encoded (gamma 2.2); pixels with 0 stops are untouched.

const LINEAR_STEPS = 4096;
const LINEAR_LUT = new Float32Array(LINEAR_STEPS + 1);
for (let i = 0; i <= LINEAR_STEPS; i++) LINEAR_LUT[i] = Math.pow(i / LINEAR_STEPS, 2.2);

export function applyExposureStopsToImage16(image16, stops) {
  if (!image16 || !image16.data) return image16;
  const data = image16.data;
  const n = image16.width * image16.height;
  if (!stops || stops.length !== n) return image16;
  const max = 65535;
  for (let p = 0; p < n; p++) {
    const s = stops[p];
    if (s === 0) continue;
    const gain = Math.pow(2, s);
    const o = p * 4;
    for (let ch = 0; ch < 3; ch++) {
      const idx = (data[o + ch] / max) * LINEAR_STEPS;
      const i0 = Math.floor(idx); const f = idx - i0;
      const linear = LINEAR_LUT[i0] * (1 - f) + LINEAR_LUT[Math.min(LINEAR_STEPS, i0 + 1)] * f;
      const out = Math.pow(Math.min(1, linear * gain), 1 / 2.2);
      data[o + ch] = Math.round(out * max);
    }
  }
  return image16;
}

export function hasExposureStops(stops) {
  if (!stops) return false;
  for (let i = 0; i < stops.length; i++) if (stops[i] !== 0) return true;
  return false;
}
