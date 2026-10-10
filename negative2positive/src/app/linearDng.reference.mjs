// The linear DNG kernel of 1703835 (v1.0.31), verbatim: the per-pixel
// Float32 build and the DataView strip that #257's table kernel replaced.
// linearDng.test.mjs and the export worker's DNG test (#293) compare their
// bytes with it; it is never used by the app.
const STEPS = 4096;
const LINEAR = new Float32Array(STEPS + 1);
for (let i = 0; i <= STEPS; i++) LINEAR[i] = Math.pow(i / STEPS, 2.2);
const toLinear16 = (value) => {
  const idx = (value / 65535) * STEPS;
  const i0 = idx | 0;
  const f = idx - i0;
  return LINEAR[i0] * (1 - f) + LINEAR[Math.min(STEPS, i0 + 1)] * f;
};
function buildLinearPositive(image16, filmBase, { whitePercentile = 0.999, positive = false } = {}) {
  const { width, height, data } = image16;
  const pixels = width * height;
  const out = new Uint16Array(pixels * 3);
  const base = filmBase && [filmBase.r, filmBase.g, filmBase.b].every((v) => Number.isFinite(v) && v > 0)
    ? [filmBase.r, filmBase.g, filmBase.b].map((v) => Math.max(1e-4, toLinear16(Math.min(255, v) * 257)))
    : null;
  const linear = new Float32Array(pixels * 3);
  const floor = 1 / 65535;
  for (let p = 0; p < pixels; p++) {
    const o = p * 4;
    for (let c = 0; c < 3; c++) {
      const neg = Math.max(floor, toLinear16(data[o + c]));
      linear[p * 3 + c] = positive ? neg : (base ? base[c] / neg : 1 / neg);
    }
  }
  const gain = [1, 1, 1];
  const sampleStep = Math.max(1, Math.floor(pixels / 200000));
  for (let c = 0; c < 3; c++) {
    const samples = [];
    for (let p = 0; p < pixels; p += sampleStep) samples.push(linear[p * 3 + c]);
    samples.sort((a, b) => a - b);
    const white = samples[Math.min(samples.length - 1, Math.floor(samples.length * whitePercentile))] || 1;
    gain[c] = 1 / white;
  }
  for (let p = 0; p < pixels; p++) {
    for (let c = 0; c < 3; c++) {
      const v = linear[p * 3 + c] * gain[c];
      out[p * 3 + c] = v >= 1 ? 65535 : v <= 0 ? 0 : Math.round(v * 65535);
    }
  }
  return { width, height, data: out, gain };
}
function stripOf(data) {
  const strip = new Uint8Array(data.length * 2);
  const view = new DataView(strip.buffer);
  for (let i = 0; i < data.length; i++) view.setUint16(i * 2, data[i], true);
  return strip;
}

export { buildLinearPositive, stripOf };
