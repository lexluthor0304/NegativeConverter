// A line-by-line JS model of render/previewShader.js's applyProgram for Node tests
// (#239). `round` is applied after every float operation: Math.fround models strict
// fp32 GPUs, the identity models a GPU that keeps more precision (fused multiply-add,
// wider intermediates). Uniforms are always fp32, as WebGL stores them. The model
// checks the stage-exact quantisation design against the CPU engine; the GLSL text
// itself is checked by glslc (previewShader.test.mjs), the in-browser self-test and
// scripts/gpu-preview-smoke.mjs.

import { hueWeightTables, HUE_TABLE_SIZE } from '../src/silvercore/engine/ImageProcessor.js';
import { LINEAR_LUT, LINEAR_STEPS } from '../src/silvercore/util/localExposure.js';

const fr = Math.fround;

export function modelApplyProgram({ image, stops = null, uniforms: u, toneLut, paperLut = null, profile = null, preSatRamp = null, satRamp = null }, round = fr) {
  const R = round;
  const MAX16 = 65535;
  const [wR, wG, wB] = hueWeightTables();
  const uf = (x) => fr(x);
  const mix = u.mix.map(uf), posWb = u.posWb.map(uf), hueShift = u.hueShift.map(uf), satFactor = u.satFactor.map(uf);
  const preSat = uf(u.preSat), gainU = uf(u.gain), sat = uf(u.sat), str = uf(u.lut3dStr), invStr = uf(u.lut3dInvStr);
  const luma = [fr(0.299), fr(0.587), fr(0.114)];
  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

  const saturate16 = (c, factor, ramp) => {
    if (c[0] === c[1] && c[1] === c[2]) return [ramp[c[0]], ramp[c[0]], ramp[c[0]]];
    const lum = R(R(R(luma[0] * c[0]) + R(luma[1] * c[1])) + R(luma[2] * c[2]));
    return c.map((v) => Math.trunc(clamp(R(lum + R(factor * R(v - lum))), 0, MAX16)));
  };
  const positiveStage = (c) => {
    const v = c.map((x, i) => R(x * posWb[i]));
    const peak = R(Math.max(v[0], v[1], v[2]) / MAX16);
    const scale = R(gainU / R(1 + R(R(gainU - 1) * peak)));
    return v.map((x) => clamp(Math.floor(R(R(x * scale) + 0.5)), 0, MAX16));
  };
  const expose = (value, s) => {
    const gain = R(Math.pow(2, s));
    const idx = R(R(value / MAX16) * LINEAR_STEPS);
    const base = Math.floor(idx);
    const frac = R(idx - base);
    const lo = LINEAR_LUT[base], hi = LINEAR_LUT[Math.min(LINEAR_STEPS, base + 1)];
    const linear = R(R(lo * R(1 - frac)) + R(hi * frac));
    const x = Math.min(1, R(linear * gain));
    const o = x > 0 ? R(Math.pow(x, R(1 / 2.2))) : 0;
    return Math.floor(R(R(o * MAX16) + 0.5));
  };
  const hue2rgb = (p, q, t) => {
    if (t < 0) t = R(t + 1);
    if (t > 1) t = R(t - 1);
    if (t < R(1 / 6)) return R(p + R(R(R(q - p) * 6) * t));
    if (t < 0.5) return q;
    if (t < R(2 / 3)) return R(p + R(R(R(q - p) * R(R(2 / 3) - t)) * 6));
    return p;
  };
  const hslStage = (c) => {
    if (u.hueSkip) {
      const moved = c[0] > c[1] && c[0] > c[2] ? u.bandActive[0]
        : c[1] > c[0] && c[1] > c[2] ? u.bandActive[1]
        : c[2] > c[0] && c[2] > c[1] ? u.bandActive[2] : 0;
      if (!moved) return c;
    }
    const invMax = R(1 / MAX16);
    const r = R(c[0] * invMax), g = R(c[1] * invMax), b = R(c[2] * invMax);
    let mx, mn;
    if (r > g) { mx = r > b ? r : b; mn = g < b ? g : b; } else { mx = g > b ? g : b; mn = r < b ? r : b; }
    const d = R(mx - mn);
    const l = R(R(mx + mn) * 0.5);
    if (d < fr(1e-6)) return c;
    let h;
    if (mx === r) h = R(R(R(R(g - b) / d) + (g < b ? 6 : 0)) / 6);
    else if (mx === g) h = R(R(R(R(b - r) / d) + 2) / 6);
    else h = R(R(R(R(r - g) / d) + 4) / 6);
    const invD = R(1 / (l > 0.5 ? R(R(2 - mx) - mn) : R(mx + mn)));
    let s = R(d * invD);
    const hIdx = clamp(Math.trunc(R(h * HUE_TABLE_SIZE)), 0, HUE_TABLE_SIZE - 1);
    const w = [wR[hIdx], wG[hIdx], wB[hIdx]];
    h = R(h + R(R(R(w[0] * hueShift[0]) + R(w[1] * hueShift[1])) + R(w[2] * hueShift[2])));
    h = R(h - Math.floor(h));
    const satAdj = R(R(R(w[0] * satFactor[0]) + R(w[1] * satFactor[1])) + R(w[2] * satFactor[2]));
    s = clamp(R(s * R(1 + satAdj)), 0, 1);
    let o;
    if (s < fr(1e-6)) o = [l, l, l];
    else {
      const q = l < 0.5 ? R(l * R(1 + s)) : R(R(l + s) - R(l * s));
      const p = R(R(2 * l) - q);
      o = [hue2rgb(p, q, R(h + R(1 / 3))), hue2rgb(p, q, h), hue2rgb(p, q, R(h - R(1 / 3)))];
    }
    return o.map((x) => Math.trunc(clamp(R(R(x * MAX16) + 0.5), 0, MAX16)));
  };
  const lut3dStage = (c) => {
    const baked = profile.bakedData, size = profile.size, max = size - 1;
    const scale = R(max / MAX16);
    const grid = c.map((x) => R(x * scale));
    const i0 = grid.map((x) => Math.min(Math.trunc(x), max - 1));
    const f = grid.map((x, i) => R(x - i0[i]));
    const f1 = f.map((x) => R(1 - x));
    const texel = (ri, gi, bi) => { const i = ((ri * size + gi) * size + bi) * 3; return [baked[i], baked[i + 1], baked[i + 2]]; };
    const lerp = (a, b, t1, t) => a.map((x, i) => R(R(x * t1) + R(b[i] * t)));
    const [r0, g0, b0] = i0;
    const x00 = lerp(texel(r0, g0, b0), texel(r0, g0, b0 + 1), f1[2], f[2]);
    const x01 = lerp(texel(r0, g0 + 1, b0), texel(r0, g0 + 1, b0 + 1), f1[2], f[2]);
    const x10 = lerp(texel(r0 + 1, g0, b0), texel(r0 + 1, g0, b0 + 1), f1[2], f[2]);
    const x11 = lerp(texel(r0 + 1, g0 + 1, b0), texel(r0 + 1, g0 + 1, b0 + 1), f1[2], f[2]);
    const lut = lerp(lerp(x00, x01, f1[1], f[1]), lerp(x10, x11, f1[1], f[1]), f1[0], f[0]);
    return c.map((x, i) => clamp(Math.floor(R(R(R(x * invStr) + R(lut[i] * str)) + 0.5)), 0, MAX16));
  };

  const { width, height, data } = image;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    let c = [data[p * 4], data[p * 4 + 1], data[p * 4 + 2]];
    const alpha = data[p * 4 + 3];
    if (u.prepared8) c = c.map((v) => v * 257);
    const s = u.stopsOn && stops ? stops[p] : 0;
    if (u.mode === 1) {
      const y = R(R(R(c[0] * mix[0]) + R(c[1] * mix[1])) + R(c[2] * mix[2]));
      let grey = Math.floor(R(y + 0.5)) & 0xFFFF;
      if (u.preSatOn) grey = preSatRamp[grey];
      if (s !== 0) grey = expose(grey, s);
      c = [toneLut.r[grey], toneLut.g[grey], toneLut.b[grey]];
    } else {
      if (u.preSatOn) c = saturate16(c, preSat, preSatRamp);
      if (u.positiveOn && alpha !== 0) c = positiveStage(c);
      if (s !== 0) c = c.map((v) => expose(v, s));
      c = [toneLut.r[c[0]], toneLut.g[c[1]], toneLut.b[c[2]]];
      if (u.hslOn) c = hslStage(c);
      if (u.lut3dOn) c = lut3dStage(c);
      if (u.satOn) c = saturate16(c, sat, satRamp);
      if (u.paperOn) c = [paperLut.r[c[0]], paperLut.g[c[1]], paperLut.b[c[2]]];
    }
    out[p * 4] = c[0] >>> 8;
    out[p * 4 + 1] = c[1] >>> 8;
    out[p * 4 + 2] = c[2] >>> 8;
    out[p * 4 + 3] = 255;
  }
  return out;
}

// Max channel difference and share of identical pixels between two RGBA8 buffers.
export function compare8(a, b) {
  let maxDiff = 0, same = 0;
  const pixels = a.length / 4;
  for (let p = 0; p < pixels; p++) {
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a[p * 4 + c] - b[p * 4 + c]));
    if (!d) same++;
    if (d > maxDiff) maxDiff = d;
  }
  return { maxDiff, identical: same / pixels };
}
