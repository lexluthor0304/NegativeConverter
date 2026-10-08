// A line-by-line JS model of render/previewShader.js's displayStep3 (#253): the
// expired-film rescue, Step 3 (WB gains, vibrance, CMY, curves) and the lab-match
// look, as the step3 program runs them on an RGBA8 frame. `round` is applied after
// every float operation: Math.fround models strict fp32 GPUs, the identity a GPU with
// wider intermediates. Uniforms and textures hold fp32 values, as WebGL stores them.
// The GLSL text itself is compared with the CPU by the in-browser self-test and
// scripts/display-modes-smoke.mjs.

import { RESCUE_LUMA } from '../src/pipeline/expiredRescue.js';

const fr = Math.fround;

function hue2rgb(R, p, q, t) {
  if (t < 0) t = R(t + 1);
  if (t > 1) t = R(t - 1);
  if (t < R(1 / 6)) return R(p + R(R(R(q - p) * 6) * t));
  if (t < 0.5) return q;
  if (t < R(2 / 3)) return R(p + R(R(R(q - p) * R(R(2 / 3) - t)) * 6));
  return p;
}

/**
 * `image` RGBA8 { width, height, data }; `step3` { wb, vib, cmy, curves: { r, g, b } };
 * `stages` from displayStageUniforms (or null); `frame` the u_frame vec4 (default: the
 * whole texture). `flipV` / `transposeLook` model the two silent bugs the orientation
 * fixture must catch. Returns RGBA8 as the framebuffer would hold it.
 */
export function modelDisplayStep3({ image, step3, stages = null, frame = null, flipV = false, transposeLook = false }, round = fr) {
  const R = round;
  const { width, height, data } = image;
  const wb = step3.wb.map(fr);
  const vib = fr(step3.vib);
  const cmy = step3.cmy.map(fr);
  const curves = step3.curves;
  const on = Boolean(stages && stages.active);
  const u = on ? {
    frame: (frame || [0, 0, 1 / width, 1 / height]).map(fr),
    fog: Array.from(stages.fog, fr), fogOffset: stages.fogOffset.map(fr), fogScale: fr(stages.fogScale), fogLimit: fr(stages.fogLimit),
    fraction: stages.fraction.map(fr), local: fr(stages.local),
    mean: stages.mean ? { width: stages.mean.width, height: stages.mean.height, data: Float32Array.from(stages.mean.data) } : null,
    offsets: stages.offsets ? Float32Array.from(stages.offsets.data) : null,
    tone: stages.tone ? Float32Array.from(stages.tone.data) : null,
    matrix: stages.lookMatrix.map(fr), offset: stages.lookOffset.map(fr),
    lookCurves: stages.lookCurves ? stages.lookCurves.data : null,
  } : null;
  const luma = RESCUE_LUMA.map(fr);
  const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  const dot = (a) => R(R(R(a[0] * luma[0]) + R(a[1] * luma[1])) + R(a[2] * luma[2]));

  const meanAt = (uv) => {
    const { width: gw, height: gh, data: m } = u.mean;
    const g = [R(clamp(R(R(uv[0] - u.fraction[0]) / u.fraction[2]), 0, 1) * (gw - 1)),
      R(clamp(R(R(uv[1] - u.fraction[1]) / u.fraction[3]), 0, 1) * (gh - 1))];
    const i0 = [Math.trunc(g[0]), Math.trunc(g[1])];
    const i1 = [Math.min(i0[0] + 1, gw - 1), Math.min(i0[1] + 1, gh - 1)];
    const f = [R(g[0] - i0[0]), R(g[1] - i0[1])];
    const at = (x, y) => m[y * gw + x];
    const top = R(R(at(i0[0], i0[1]) * R(1 - f[0])) + R(at(i1[0], i0[1]) * f[0]));
    const bottom = R(R(at(i0[0], i1[1]) * R(1 - f[0])) + R(at(i1[0], i1[1]) * f[0]));
    return R(R(top * R(1 - f[1])) + R(bottom * f[1]));
  };
  const toneAt = (x) => {
    if (x <= 0) return u.tone[0];
    if (x >= 255) return u.tone[255];
    const i = Math.trunc(x);
    const f = R(x - i);
    const a = u.tone[i], b = u.tone[i + 1];
    return R(a + R(R(b - a) * f));
  };
  const rescue = (px, uv) => {
    uv = [clamp(uv[0], u.fraction[0], R(u.fraction[0] + u.fraction[2])), clamp(uv[1], u.fraction[1], R(u.fraction[1] + u.fraction[3]))];
    let fogLum = 0;
    if (stages.fogOn) {
      for (let ch = 0; ch < 3; ch++) {
        const k = ch * 6, c = u.fog;
        const q = R(R(R(R(R(c[k] + R(c[k + 1] * uv[0])) + R(c[k + 2] * uv[1])) + R(R(c[k + 3] * uv[0]) * uv[0]))
          + R(R(c[k + 4] * uv[1]) * uv[1])) + R(R(c[k + 5] * uv[0]) * uv[1]));
        const fog = R(clamp(R(q - u.fogOffset[ch]), 0, u.fogLimit) * u.fogScale);
        if (fog > 0) px[ch] = Math.max(R(R(px[ch] - fog) / R(1 - R(fog / 255))), 0);
        fogLum = R(fogLum + R(fog * luma[ch]));
      }
    }
    if (u.local > 0) {
      let m = meanAt(uv);
      if (fogLum > 0) m = Math.max(R(R(m - fogLum) / R(1 - R(fogLum / 255))), 0);
      const delta = R(R(dot(px) - m) * u.local);
      px = px.map((v) => clamp(R(v + delta), 0, 255));
    }
    if (stages.offsetsOn) {
      const pos = R(clamp(R(dot(px) / 255), 0, 1) * 63);
      const i0 = Math.trunc(pos), i1 = Math.min(i0 + 1, 63);
      const f = R(pos - i0);
      px = px.map((v, ch) => clamp(R(R(v + R(u.offsets[i0 * 4 + ch] * R(1 - f))) + R(u.offsets[i1 * 4 + ch] * f)), 0, 255));
    }
    return px.map(toneAt);
  };
  const rgbToHsl = (c) => {
    const [r, g, b] = c;
    const maxc = Math.max(r, g, b), minc = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = R(R(maxc + minc) * 0.5);
    if (maxc !== minc) {
      const d = R(maxc - minc);
      s = l > 0.5 ? R(d / R(R(2 - maxc) - minc)) : R(d / R(maxc + minc));
      if (maxc === r) h = R(R(R(g - b) / d) + (g < b ? 6 : 0));
      else if (maxc === g) h = R(R(R(b - r) / d) + 2);
      else h = R(R(R(r - g) / d) + 4);
      h = R(h / 6);
    }
    return [h, s, l];
  };
  const hslToRgb = (h, s, l) => {
    if (s === 0) return [l, l, l];
    const q = l < 0.5 ? R(l * R(1 + s)) : R(R(l + s) - R(l * s));
    const p = R(R(2 * l) - q);
    return [hue2rgb(R, p, q, R(h + R(1 / 3))), hue2rgb(R, p, q, h), hue2rgb(R, p, q, R(h - R(1 / 3)))];
  };
  const applyStep3 = (c) => {
    c = c.map((v, i) => clamp(R(v * wb[i]), 0, 1));
    if (vib !== 0) {
      const hsl = rgbToHsl(c);
      let s = hsl[1];
      if (vib >= 0) s = R(s + R(R(1 - s) * vib));
      else s = R(s * R(1 + vib));
      c = hslToRgb(hsl[0], clamp(s, 0, 1), hsl[2]);
    }
    if (on && stages.roundBeforeCmy) c = c.map((v) => R(Math.floor(R(R(v * 255) + 0.5)) / 255));
    c = c.map((v, i) => R(1 - clamp(R(R(1 - v) + cmy[i]), 0, 1)));
    const idx = c.map((v) => clamp(Math.floor(R(R(v * 255) + 0.5)), 0, 255));
    return [curves.r[idx[0]] / 255, curves.g[idx[1]] / 255, curves.b[idx[2]] / 255].map(fr);
  };
  const look = (c) => {
    let v = c.map((x) => Math.floor(R(R(x * 255) + 0.5)));
    if (stages.lookMatrixOn) {
      const m = u.matrix;
      const row = (i) => (transposeLook ? [m[i], m[i + 3], m[i + 6]] : [m[i * 3], m[i * 3 + 1], m[i * 3 + 2]]);
      v = [0, 1, 2].map((i) => {
        const r = row(i);
        return clamp(R(R(R(R(r[0] * v[0]) + R(r[1] * v[1])) + R(r[2] * v[2])) + u.offset[i]), 0, 255);
      });
    }
    if (!stages.lookCurvesOn) return v.map((x) => R(x / 255));
    const idx = v.map((x) => clamp(Math.floor(R(x + 0.5)), 0, 255));
    return idx.map((i, ch) => fr(u.lookCurves[i * 4 + ch] / 255));
  };

  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let c = [fr(data[i] / 255), fr(data[i + 1] / 255), fr(data[i + 2] / 255)];
      if (on && stages.rescueOn) {
        const py = flipV ? height - 1 - y : y;
        const uv = [R(u.frame[0] + R(R(x + 0.5) * u.frame[2])), R(u.frame[1] + R(R(py + 0.5) * u.frame[3]))];
        c = rescue(c.map((v) => Math.floor(R(R(v * 255) + 0.5))), uv).map((v) => R(v / 255));
      }
      c = applyStep3(c);
      if (on && (stages.lookMatrixOn || stages.lookCurvesOn)) c = look(c);
      for (let ch = 0; ch < 3; ch++) out[i + ch] = Math.round(clamp(c[ch], 0, 1) * 255);
      out[i + 3] = 255;
    }
  }
  return out;
}
