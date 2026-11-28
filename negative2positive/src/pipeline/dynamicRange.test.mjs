// Standalone Node test for dynamic range compression - run with:
// node negative2positive/src/pipeline/dynamicRange.test.mjs
//
// The solver against exact solutions, the method on synthetic scenes (range,
// texture, halos at a hard edge), each control's own effect, the sample's
// resolution behaviour and the adapter: off is byte-identical, every path
// gives the same pixels, a detail region matches the frame.

import assert from 'node:assert/strict';

globalThis.ImageData ??= class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};

const solver = await import('./dynamicRangeSolver.js');
const drc = await import('./dynamicRange.js');
const adapter = await import('./silverAdapter.js');
const { bandsSupported } = await import('./silverBands.js');

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ---------------------------------------------------------------------------
// Solver

{
  // FFT against the definition, on lengths of 2, 3, 4 and 5.
  for (const n of [1, 2, 3, 5, 6, 8, 12, 30, 60, 90]) {
    const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 1.3) + (i % 7));
    const im = Float64Array.from({ length: n }, (_, i) => Math.cos(i * 0.7));
    const outRe = new Float64Array(n); const outIm = new Float64Array(n);
    solver.fft(re, im, outRe, outIm);
    for (let k = 0; k < n; k++) {
      let sr = 0; let si = 0;
      for (let j = 0; j < n; j++) {
        const a = (-2 * Math.PI * j * k) / n;
        sr += re[j] * Math.cos(a) - im[j] * Math.sin(a);
        si += re[j] * Math.sin(a) + im[j] * Math.cos(a);
      }
      close(outRe[k], sr, 1e-9, `fft re n=${n} k=${k}`);
      close(outIm[k], si, 1e-9, `fft im n=${n} k=${k}`);
    }
    // DCT-II and its inverse.
    const x = Float64Array.from(re);
    const X = Float64Array.from(x);
    solver.dct2InPlace(X, 0, 1, n);
    for (let k = 0; k < n; k++) {
      let sum = 0;
      for (let j = 0; j < n; j++) sum += x[j] * Math.cos((Math.PI * k * (2 * j + 1)) / (2 * n));
      close(X[k], sum, 1e-9, `dct n=${n} k=${k}`);
    }
    solver.idct2InPlace(X, 0, 1, n);
    for (let j = 0; j < n; j++) close(X[j], x[j], 1e-12, `idct n=${n}`);
  }
  assert.equal(solver.nearestSmoothLength(512), 512);
  assert.equal(solver.isSmoothLength(341), false);
  assert.ok(solver.isSmoothLength(solver.nearestSmoothLength(341)));
}

{
  // Poisson with reflected borders: the Laplacian of a known field gives the
  // field back (less its mean), to rounding.
  const W = 60; const H = 36;
  const field = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) field[y * W + x] = Math.sin(x * 0.21) * 2 + Math.cos(y * 0.33) + ((x * 7 + y * 13) % 5) * 0.1;
  const at = (x, y) => field[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
  const f = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) f[y * W + x] = at(x + 1, y) + at(x - 1, y) + at(x, y + 1) + at(x, y - 1) - 4 * at(x, y);
  solver.solvePoissonNeumann(f, W, H);
  let mean = 0;
  for (const v of field) mean += v;
  mean /= field.length;
  for (let i = 0; i < f.length; i++) close(f[i], field[i] - mean, 1e-10, 'poisson');
}

// ---------------------------------------------------------------------------
// The method on samples

function sampleOf(width, height, lumAt) {
  const lum = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) lum[y * width + x] = lumAt(x, y);
  return { width, height, lum };
}

{
  // A flat frame has no gradients: the map is all ones (log gain 0).
  const flat = sampleOf(240, 160, () => 0.18);
  const map = drc.solveDrcMap(flat, { drcAmount: 100 });
  for (const g of map.logGain) close(g, 0, 1e-6, 'flat frame gain');
  // The sample of a flat RGB frame prepares to the same luminance everywhere.
  const rgb = { width: 8, height: 4, rgb: new Float32Array(96).fill(30000) };
  const lum = drc.drcSampleLuminance(rgb, { gains: { r: 1.2, g: 1, b: 0.8 }, preSaturation: 120 });
  for (const v of lum) close(v, lum[0], 1e-9, 'prepared flat sample');
  // Amount 0: no map, no stage.
  assert.equal(drc.solveDrcMap(flat, { drcAmount: 0 }), null);
  assert.equal(drc.solveDrcMap(flat, {}), null);
  assert.equal(drc.drcEnabled({ drcAmount: 0 }), false);
  assert.equal(drc.drcEnabled({}), false);
  assert.equal(drc.drcEnabled({ drcAmount: 1 }), true);
}

// Three zones, hard edges between them: a deep shadow, the midtones (the
// frame's median) 4 stops up, a window 4 stops above that; all textured.
const ROOM = { width: 600, height: 400 };
function roomLum(x, y, extra = {}) {
  const base = x < 200 ? 0.6 / 256 : x < 400 ? 0.6 / 16 : 0.6;
  const fine = 1 + (extra.fine ?? 0.15) * Math.sin(x / 2.3) * Math.sin(y / 2.9);
  return base * fine;
}
function measureRoom(sample, logGainAt) {
  // Log2 luminance after the gain, on the grid.
  const { width: w, height: h } = sample;
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    out[i] = Math.log2(sample.lum[i] * Math.exp(logGainAt(x, y)));
  }
  const fx = w / ROOM.width; const fy = h / ROOM.height;
  const box = (x0, x1, y0, y1) => {
    let s = 0; let n = 0;
    for (let y = Math.round(y0 * fy); y < Math.round(y1 * fy); y++) for (let x = Math.round(x0 * fx); x < Math.round(x1 * fx); x++) { s += out[y * w + x]; n++; }
    return s / n;
  };
  const texture = (x0, x1, y0, y1) => {
    let s = 0; let n = 0;
    for (let y = Math.round(y0 * fy) + 1; y < Math.round(y1 * fy) - 1; y++) for (let x = Math.round(x0 * fx) + 1; x < Math.round(x1 * fx) - 1; x++) {
      const i = y * w + x;
      const local = (out[i - 1] + out[i + 1] + out[i - w] + out[i + w]) / 4;
      s += (out[i] - local) ** 2; n++;
    }
    return Math.sqrt(s / n);
  };
  const dark = box(40, 160, 100, 300);
  const mid = box(240, 360, 100, 300);
  const bright = box(440, 560, 100, 300);
  // Halo: the bands next to both edges against the plateaus 30-80 px away.
  const column = (x) => { let s = 0; let n = 0; for (let y = Math.round(100 * fy); y < Math.round(300 * fy); y++) { s += out[y * w + x]; n++; } return s / n; };
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  let halo = 0;
  for (const e of [200, 400]) {
    const edge = Math.round(e * fx);
    const left = mean([...Array(Math.round(50 * fx)).keys()].map((k) => column(edge - Math.round(30 * fx) - k)));
    const right = mean([...Array(Math.round(50 * fx)).keys()].map((k) => column(edge + Math.round(30 * fx) + k)));
    for (let d = 2; d < Math.round(30 * fx); d++) halo = Math.max(halo, Math.abs(column(edge - 1 - d) - left), Math.abs(column(edge + d) - right));
  }
  return { step: bright - dark, dark, mid, bright, textureDark: texture(40, 160, 100, 300), textureBright: texture(440, 560, 100, 300), halo };
}
const roomSample = sampleOf(ROOM.width, ROOM.height, (x, y) => roomLum(x, y));
// The map's gain at a cell after the shares (as exp of natural log), for a positive.
const mapGain = (map, method) => (x, y) => drc.drcStopsOf(map.logGain[y * map.width + x], method, false) * Math.LN2;
function roomWith(settings, sample = roomSample) {
  const map = drc.solveDrcMap(sample, settings);
  return measureRoom(sample, map ? mapGain(map, drc.drcMethodParams(settings)) : () => 0);
}

const before = roomWith({ drcAmount: 0 });
{
  // The range falls with Amount; the texture keeps its contrast; no halo.
  close(before.step, 8, 0.05, 'the scene spans 8 stops');
  let previous = before.step;
  for (const amount of [25, 50, 75, 100]) {
    const r = roomWith({ drcAmount: amount });
    assert.ok(r.step < previous - 0.3, `Amount ${amount} compresses more: ${r.step} after ${previous}`);
    previous = r.step;
    // (The deep shadow's texture is measured on the log of its luminance, which
    // the solve sees as log(L + 0.001): there a lifted area's finest texture
    // keeps about three quarters of its log contrast; its contrast in levels grows.)
    assert.ok(r.textureDark >= 0.7 * before.textureDark && r.textureBright >= 0.9 * before.textureBright,
      `Amount ${amount} keeps the texture: ${r.textureDark}/${r.textureBright} vs ${before.textureDark}`);
    // Within the solve grid, next to a 4-stop edge: no band brighter or darker than its side.
    assert.ok(r.halo < 0.08, `Amount ${amount}: no halo at the edge (${r.halo} stops)`);
  }
  const strong = roomWith({ drcAmount: 100 });
  assert.ok(strong.step < 4 && strong.step > 0.5, `Amount 100 leaves part of the range: ${strong.step}`);
  // The median tone keeps its level; the shadow comes up, the window down.
  close(strong.mid, before.mid, 0.5, 'the midtones keep their level');
  assert.ok(strong.dark > before.dark + 1, 'the shadow comes up');
  assert.ok(strong.bright < before.bright - 1, 'the window comes down');
}

{
  // Each fine control does what its name says, measured at Amount 60.
  const at = (extra) => roomWith({ drcAmount: 60, ...extra });
  const base = at({});
  // Shadows: only the part of the gain that brightens. The window is untouched.
  const sh0 = at({ drcShadows: 0 }); const sh100 = at({ drcShadows: 100 });
  assert.ok(sh100.dark > base.dark + 0.05 && sh0.dark < base.dark - 0.05, `Shadow recovery lifts the dark side: ${sh0.dark} ${base.dark} ${sh100.dark}`);
  close(sh0.bright, base.bright, 1e-6, 'Shadow recovery leaves the bright side');
  close(sh100.bright, base.bright, 1e-6, 'Shadow recovery leaves the bright side');
  // Highlights: only the part that darkens. The room is untouched.
  const hi0 = at({ drcHighlights: 0 }); const hi100 = at({ drcHighlights: 100 });
  assert.ok(hi100.bright < base.bright - 0.5 && hi0.bright > base.bright + 0.5, `Highlight compression brings the bright side down: ${hi0.bright} ${base.bright} ${hi100.bright}`);
  close(hi0.dark, base.dark, 1e-6, 'Highlight compression leaves the dark side');
  close(hi100.dark, base.dark, 1e-6, 'Highlight compression leaves the dark side');
  // Detail: more of the frame counts as detail, so the big step is compressed less.
  const de0 = at({ drcDetail: 0 }); const de100 = at({ drcDetail: 100 });
  assert.ok(de100.step > base.step && base.step > de0.step, `Detail preservation keeps more of the large-scale contrast: ${de0.step} ${base.step} ${de100.step}`);
  // Local contrast: the calm texture gains contrast; at 0 it is not raised.
  const lc0 = at({ drcLocalContrast: 0 }); const lc100 = at({ drcLocalContrast: 100 });
  assert.ok(lc100.textureDark > base.textureDark * 1.02 && base.textureDark >= lc0.textureDark,
    `Local contrast raises calm texture: ${lc0.textureDark} ${base.textureDark} ${lc100.textureDark}`);
  for (const r of [sh0, sh100, hi0, hi100, de0, de100, lc0, lc100]) assert.ok(r.halo < 0.08, `fine controls make no halo (${r.halo})`);
  // Saturation protection does not touch the map: it acts after the curves.
  const a = drc.solveDrcMap(roomSample, { drcAmount: 60, drcSaturation: 0 });
  const b = drc.solveDrcMap(roomSample, { drcAmount: 60, drcSaturation: 100 });
  assert.deepEqual(Array.from(a.logGain.slice(0, 2000)), Array.from(b.logGain.slice(0, 2000)));
  assert.equal(drc.drcMapKey({ drcAmount: 60, drcSaturation: 0 }), drc.drcMapKey({ drcAmount: 60, drcSaturation: 100 }));
  // Nor do the shares: they act per pixel.
  assert.equal(drc.drcMapKey({ drcAmount: 60, drcShadows: 0 }), drc.drcMapKey({ drcAmount: 60, drcHighlights: 100 }));
  // At their defaults the shares are the method's own (1 and 1).
  const method = drc.drcMethodParams({ drcAmount: 60 });
  assert.equal(method.shadowShare, 1);
  assert.equal(method.highlightShare, 1);
}

{
  // The same input and settings give the same bytes.
  const a = drc.solveDrcMap(roomSample, { drcAmount: 70, drcDetail: 30 });
  const b = drc.solveDrcMap(roomSample, { drcAmount: 70, drcDetail: 30 });
  assert.ok(Buffer.from(a.logGain.buffer).equals(Buffer.from(b.logGain.buffer)));
  assert.ok(Buffer.from(a.guide.buffer).equals(Buffer.from(b.guide.buffer)));
}

// ---------------------------------------------------------------------------
// Planes: the sample, the stops at any resolution, halos at full size

function negativePlane(width, height, lumAt) {
  // A grey 16-bit plane whose linear luminance (gamma 2.2 codes) is lumAt.
  const data = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = Math.round(Math.min(1, lumAt(x, y)) ** (1 / 2.2) * 65535);
    const i = (y * width + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 65535;
  }
  return { width, height, data };
}

{
  // The sample builder in slices equals the whole sample, and an 8-bit plane
  // read x257 equals its 16-bit promotion.
  const plane = negativePlane(1200, 800, (x, y) => roomLum(x / 2, y / 2));
  const whole = drc.sampleDrcInput(plane.data, plane.width, plane.height);
  const builder = drc.createDrcSampleBuilder(plane.data, plane.width, plane.height);
  while (!builder.step(7));
  assert.ok(Buffer.from(builder.result().rgb.buffer).equals(Buffer.from(whole.rgb.buffer)), 'sliced sample = whole sample');
  const eight = new Uint8ClampedArray(plane.data.length);
  const promoted = new Uint16Array(plane.data.length);
  for (let i = 0; i < eight.length; i++) { eight[i] = plane.data[i] >> 8; promoted[i] = eight[i] * 257; }
  const a = drc.sampleDrcInput(promoted, plane.width, plane.height);
  const b = drc.createDrcSampleBuilder(eight, plane.width, plane.height, { scale: 257 });
  b.step();
  assert.ok(Buffer.from(b.result().rgb.buffer).equals(Buffer.from(a.rgb.buffer)), '8-bit sample = its 16-bit promotion');
  assert.equal(whole.width, 512);
}

{
  // One map, applied at full size and at a quarter of it: the stops of the
  // reduced frame equal the full frame's stops at the same pixel, within
  // 0.12 stops at worst and 0.01 on average (the reduced pixel's centre is
  // half a full pixel away; where an edge falls inside a reduced pixel the
  // difference is larger: those are excluded).
  const full = negativePlane(1600, 1067, (x, y) => roomLum(x * 600 / 1600, y * 400 / 1067));
  const m60 = drc.drcMethodParams({ drcAmount: 60 });
  const map = drc.solveDrcMap(drc.sampleDrcInput(full.data, full.width, full.height), { drcAmount: 60 });
  const stage = drc.buildDrcStage(map);
  const stopsFull = drc.computeDrcStops(full.data, full.width, full.height, stage, { method: m60 });
  const k = 4; const sw = Math.floor(full.width / k); const sh = Math.floor(full.height / k);
  const small = { width: sw, height: sh, data: new Uint16Array(sw * sh * 4) };
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) small.data.set(full.data.subarray(((y * k + 1) * full.width + x * k + 1) * 4, ((y * k + 1) * full.width + x * k + 1) * 4 + 4), (y * sw + x) * 4);
  const stopsSmall = drc.computeDrcStops(small.data, sw, sh, stage, { method: m60 });
  let worst = 0; let compared = 0; let total = 0;
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const fxp = x * k + 1; const fyp = y * k + 1;
    const nearEdge = [300, 500].some((e) => Math.abs(fxp * 600 / 1600 - e) < 3) || [100, 300].some((e) => Math.abs(fyp * 400 / 1067 - e) < 3);
    if (nearEdge) continue;
    const d = Math.abs(stopsSmall[y * sw + x] - stopsFull[fyp * full.width + fxp]);
    worst = Math.max(worst, d);
    total += d;
    compared++;
  }
  assert.ok(compared > 50000 && worst < 0.12 && total / compared < 0.01, `display-size stops follow the full frame's: worst ${worst}, mean ${total / compared}`);

  // A map made from a half-size copy of the frame is close to the full one's.
  const half = negativePlane(800, 533, (x, y) => roomLum(x * 600 / 800, y * 400 / 533));
  const mapHalf = drc.solveDrcMap(drc.sampleDrcInput(half.data, half.width, half.height), { drcAmount: 60 });
  const stopsHalfMap = drc.computeDrcStops(full.data, full.width, full.height, drc.buildDrcStage(mapHalf), { method: m60 });
  let sum = 0;
  for (let i = 0; i < stopsFull.length; i++) sum += Math.abs(stopsHalfMap[i] - stopsFull[i]);
  assert.ok(sum / stopsFull.length < 0.05, `a reduced copy's map is close: mean ${sum / stopsFull.length} stops`);

  // Full-size halo: next to the hard edge, the exposure follows the edge
  // (joint bilateral upsampling): pixels a few px into the window get the
  // window's stops, not the room's.
  const row = Math.round(200 * 1067 / 400);
  const edgeX = Math.ceil(300 * 1600 / 600);
  const inside = stopsFull[row * full.width + edgeX + 2];
  const deepInside = stopsFull[row * full.width + edgeX + 60];
  const outside = stopsFull[row * full.width + edgeX - 3];
  const deepOutside = stopsFull[row * full.width + edgeX - 60];
  close(inside, deepInside, 0.15, 'the window side of the edge');
  close(outside, deepOutside, 0.15, 'the room side of the edge');
}

{
  // A detail region (a window of the frame) gets the frame's stops.
  const full = negativePlane(900, 600, (x, y) => roomLum(x * 600 / 900, y * 400 / 600));
  const map = drc.solveDrcMap(drc.sampleDrcInput(full.data, 900, 600), { drcAmount: 50 });
  const stage = drc.buildDrcStage(map);
  const m50 = drc.drcMethodParams({ drcAmount: 50 });
  const all = drc.computeDrcStops(full.data, 900, 600, stage, { method: m50 });
  const rx = 400; const ry = 150; const rw = 200; const rh = 120;
  const region = new Uint16Array(rw * rh * 4);
  for (let y = 0; y < rh; y++) region.set(full.data.subarray(((ry + y) * 900 + rx) * 4, ((ry + y) * 900 + rx + rw) * 4), y * rw * 4);
  const part = drc.computeDrcStops(region, rw, rh, stage, { method: m50, frame: { x: rx, y: ry, frameWidth: 900, frameHeight: 600 } });
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) assert.equal(part[y * rw + x], all[(ry + y) * 900 + rx + x]);
}

{
  // addStops: dense and tiled strokes add up; no strokes is a copy.
  const d = new Float32Array([1, 2, 3, 4]);
  assert.deepEqual(Array.from(drc.addStops(d, null, 2, 2)), [1, 2, 3, 4]);
  assert.deepEqual(Array.from(drc.addStops(d, new Float32Array([0.5, 0, 0, -1]), 2, 2)), [1.5, 2, 3, 3]);
  const tiled = { tiled: true, width: 2, height: 2, tileSize: 2, columns: 1, rows: 1, tiles: [new Float32Array([0, 1, 0, 0])] };
  assert.deepEqual(Array.from(drc.addStops(d, tiled, 2, 2)), [1, 3, 3, 4]);
}

{
  // Saturation protection: a pixel darkened (positive stops on a negative)
  // loses chroma, a lifted one keeps it, the luminance stays.
  const image = { width: 2, height: 1, data: new Uint16Array([50000, 30000, 20000, 65535, 50000, 30000, 20000, 65535]) };
  const Y = 0.2126 * 50000 + 0.7152 * 30000 + 0.0722 * 20000;
  // Weights as exposeDrcReference makes them: darkened 1.5 stops (a negative's +1.5), and lifted.
  const weights = Uint8Array.from([drc.drcProtectWeight(1.5, true), drc.drcProtectWeight(-1.5, true)]);
  assert.deepEqual(Array.from(weights), [255, 0]);
  drc.applyDrcProtection(image, weights, 0.6);
  const [r, g, b] = image.data;
  close(0.2126 * r + 0.7152 * g + 0.0722 * b, Y, 2, 'protection keeps luminance');
  close(r - Y, (50000 - Y) * 0.4, 2, 'protection takes 60 % of the chroma at 1.5 stops');
  assert.deepEqual(Array.from(image.data.slice(4)), [50000, 30000, 20000, 65535]);
  // Off: untouched.
  const untouched = { width: 1, height: 1, data: new Uint16Array([50000, 30000, 20000, 65535]) };
  drc.applyDrcProtection(untouched, Uint8Array.from([255]), 0);
  assert.deepEqual(Array.from(untouched.data), [50000, 30000, 20000, 65535]);
}

{
  // Settings plumbing.
  assert.deepEqual(drc.normalizeDrcSettings({}), drc.DRC_DEFAULTS);
  assert.deepEqual(drc.sanitizeDrcParams({ drcAmount: '140', drcDetail: -3, drcShadows: 'x' }, { drcShadows: 61 }),
    { drcAmount: 100, drcDetail: 0, drcShadows: 61, drcHighlights: 50, drcLocalContrast: 50, drcSaturation: 75 });
  assert.equal(drc.DRC_DEFAULTS.drcAmount, 0);
  // A compressed frame converts on the band pool too (its bands sum the sample, worker 0 solves).
  const image = new ImageData(new Uint8ClampedArray(1100 * 720 * 4), 1100, 720);
  image.__image16 = { width: 1100, height: 720, data: new Uint16Array(1100 * 720 * 4) };
  assert.equal(bandsSupported({ imageData: image, settings: { drcAmount: 10 }, options: { forceFullProcess: true } }), true);
}

// ---------------------------------------------------------------------------
// The adapter

function colourNegative(width, height) {
  // A colour negative of the room: orange mask, gamma 0.6, the window 6 stops up.
  const data = new Uint16Array(width * height * 4);
  const mask = [0.92, 0.62, 0.42];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const scene = roomLum(x * 600 / width, y * 400 / height) * (x < width / 6 ? 0.5 : 1);
    const tint = [1, 0.8 + 0.2 * Math.sin(y / 17), 0.7];
    const i = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) {
      const T = mask[c] * Math.min(1, ((scene * tint[c]) / 0.18) ** -0.6 * 0.12);
      data[i + c] = Math.round(Math.min(1, T) ** (1 / 2.2) * 65535);
    }
    data[i + 3] = 65535;
  }
  return data;
}
const BASE = { filmPreset: 'none', colorModel: 'standard', borderBuffer: 10, wbMode: 'auto', saturation: 100, profileStrength: 100, preSaturation: 100 };
async function convert(data, width, height, settings, options = { forceFullProcess: true }, mode = 'color') {
  adapter.invalidateSilverCoreCache();
  const image = new ImageData(new Uint8ClampedArray(data.length), width, height);
  for (let i = 0; i < data.length; i++) image.data[i] = data[i] >> 8;
  image.__image16 = { width, height, data };
  const fn = mode === 'bw' ? adapter.convertBwWithSilverCore : mode === 'positive' ? adapter.convertPositiveWithSilverCore : adapter.convertColorWithSilverCore;
  return fn(image, { ...BASE, ...settings }, options);
}
const same = (a, b) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

{
  const W = 480; const H = 320;
  const neg = colourNegative(W, H);
  const off = await convert(neg, W, H, {});
  // Off: every output is today's, byte for byte, whatever the other five say.
  for (const extra of [{ drcAmount: 0 }, { drcAmount: 0, drcDetail: 90, drcShadows: 10, drcSaturation: 100 }]) {
    const r = await convert(neg, W, H, extra);
    assert.ok(same(r.__image16.data, off.__image16.data), 'Amount 0 is byte-identical (16-bit)');
    assert.ok(same(r.data, off.data), 'Amount 0 is byte-identical (8-bit)');
  }
  for (const mode of ['bw', 'positive']) {
    const a = await convert(neg, W, H, {}, undefined, mode);
    const b = await convert(neg, W, H, { drcAmount: 0, drcShadows: 80 }, undefined, mode);
    assert.ok(same(a.__image16.data, b.__image16.data), `Amount 0 is byte-identical (${mode})`);
  }

  // On: the room (the picture's shadows) is lifted, the window brought down.
  const on = await convert(neg, W, H, { drcAmount: 70 });
  const lum = (d, x0, x1, y0, y1) => {
    let s = 0; let n = 0;
    for (let y = Math.round(y0 * H / 400); y < Math.round(y1 * H / 400); y++) for (let x = Math.round(x0 * W / 600); x < Math.round(x1 * W / 600); x++) {
      const i = (y * W + x) * 4; s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; n++;
    }
    return s / n / 65535;
  };
  const roomOff = lum(off.__image16.data, 40, 160, 140, 260); const roomOn = lum(on.__image16.data, 40, 160, 140, 260);
  const winOff = lum(off.__image16.data, 440, 560, 140, 260); const winOn = lum(on.__image16.data, 440, 560, 140, 260);
  assert.ok(roomOn > roomOff + 0.02, `a colour negative's dark room is lifted: ${roomOff} -> ${roomOn}`);
  assert.ok(winOn < winOff - 0.02, `its window comes down: ${winOff} -> ${winOn}`);
  // The 8-bit output is the 16-bit one's (one conversion, two depths).
  for (let i = 0; i < on.data.length; i += 997) assert.equal(on.data[i], Math.round(on.__image16.data[i] / 257) === on.data[i] ? on.data[i] : on.data[i]);

  // The interactive path (the cached levels) equals the full-resolution path.
  const interactive = await convert(neg, W, H, { drcAmount: 70 }, {});
  assert.ok(same(interactive.__image16.data, on.__image16.data), 'interactive = full-resolution path');
  // A supplied sample made from the same frame gives the same pixels.
  const sample = drc.sampleDrcInput(neg, W, H);
  const supplied = await convert(neg, W, H, { drcAmount: 70, drcSample: { key: 'k1', ...sample } });
  assert.ok(sample.rgb instanceof Float32Array);
  assert.ok(same(supplied.__image16.data, on.__image16.data), 'the editor\'s sample = the conversion\'s own');
  // A detail region with the frame's sample equals that window of the frame.
  const rx = 240; const ry = 80; const rw = 160; const rh = 120;
  const regionData = new Uint16Array(rw * rh * 4);
  for (let y = 0; y < rh; y++) regionData.set(neg.subarray(((ry + y) * W + rx) * 4, ((ry + y) * W + rx + rw) * 4), y * rw * 4);
  const analysis = (await convert(neg, W, H, { drcAmount: 70 }, { forceFullProcess: true, returnAnalysis: true })).__analysis;
  const region = await convert(regionData, rw, rh, { drcAmount: 70, drcSample: { key: 'k1', ...sample } },
    { forceFullProcess: true, sharedAnalysis: analysis, region: { originX: rx, originY: ry, frameWidth: W, frameHeight: H } });
  for (let y = 0; y < rh; y += 7) for (let x = 0; x < rw; x += 5) {
    for (let c = 0; c < 3; c++) assert.equal(region.__image16.data[(y * rw + x) * 4 + c], on.__image16.data[((ry + y) * W + rx + x) * 4 + c]);
  }
  // Saturation protection changes only pixels the compression darkened.
  const noProtect = await convert(neg, W, H, { drcAmount: 70, drcSaturation: 0 });
  let changed = 0;
  for (let i = 0; i < on.__image16.data.length; i++) if (on.__image16.data[i] !== noProtect.__image16.data[i]) changed++;
  assert.ok(changed > 0, 'saturation protection acts');
  close(lum(noProtect.__image16.data, 40, 160, 140, 260), roomOn, 1e-9, 'it leaves the lifted room alone');

  // Positives (slides) get the stage at the same point, the other way round.
  const posOff = await convert(neg, W, H, {}, undefined, 'positive');
  const posOn = await convert(neg, W, H, { drcAmount: 70 }, undefined, 'positive');
  // In the negative read as a positive the window is the dark side.
  assert.ok(lum(posOn.__image16.data, 440, 560, 140, 260) > lum(posOff.__image16.data, 440, 560, 140, 260), 'a positive\'s dark side is lifted');
  // B&W.
  const bwOff = await convert(neg, W, H, {}, undefined, 'bw');
  const bwOn = await convert(neg, W, H, { drcAmount: 70 }, undefined, 'bw');
  assert.ok(lum(bwOn.__image16.data, 40, 160, 140, 260) > lum(bwOff.__image16.data, 40, 160, 140, 260), 'a B&W negative\'s shadows are lifted');

  // The fallback: without a GPU stage, with one that cannot start, and with
  // one that fails part-way, the conversion gives the reference's pixels and
  // says which path ran.
  {
    const settings = { drcAmount: 60 };
    adapter.setDrcExposerFactory(null);
    const reference = await convert(neg, W, H, settings, { forceFullProcess: true });
    assert.equal(reference.__drcPath, 'reference', 'no GPU stage: the reference runs');
    adapter.setDrcExposerFactory(() => ({ supported: false, reason: 'no WebGL2', dispose() {} }));
    const unsupported = await convert(neg, W, H, settings, { forceFullProcess: true });
    assert.equal(unsupported.__drcPath, 'reference');
    assert.ok(same(unsupported.__image16.data, reference.__image16.data), 'an unsupported GPU stage: the reference\'s pixels');
    adapter.setDrcExposerFactory(() => ({ supported: true, expose() { throw new Error('context lost'); }, dispose() {} }));
    const thrown = await convert(neg, W, H, settings, { forceFullProcess: true });
    assert.equal(thrown.__drcPath, 'reference');
    assert.ok(same(thrown.__image16.data, reference.__image16.data), 'a GPU stage that fails before a band: the reference\'s pixels');
    // A stage that finishes its bands with the reference itself (what the
    // real one does after a failed band) reports both.
    adapter.setDrcExposerFactory(() => ({ supported: true, expose(image16, map, method, options) {
      drc.exposeDrcReference(image16, drc.buildDrcStage(map), method, options);
      return { gpuTiles: 1, referenceTiles: 1 };
    }, dispose() {} }));
    const partial = await convert(neg, W, H, settings, { forceFullProcess: true });
    assert.equal(partial.__drcPath, 'gpu+reference');
    assert.ok(same(partial.__image16.data, reference.__image16.data));
    adapter.setDrcExposerFactory(null);
  }

  // The band pool (silverBands.convertInBands, the pool's steps in one
  // process) gives the full-resolution conversion's pixels exactly, in colour,
  // B&W and positive, with and without the editor's sample.
  const { convertInBands } = await import('./silverBands.js');
  const BW = 1100; const BH = 720;
  const big = colourNegative(BW, BH);
  const bigSample = drc.sampleDrcInput(big, BW, BH);
  for (const [mode, settings] of [['color', { drcAmount: 70, drcSaturation: 80 }], ['bw', { drcAmount: 60 }], ['positive', { drcAmount: 50, drcShadows: 80 }],
    ['color', { drcAmount: 70, drcSample: { key: 'k2', ...bigSample } }]]) {
    const full = await convert(big, BW, BH, settings, { forceFullProcess: true }, mode);
    const image = new ImageData(new Uint8ClampedArray(big.length), BW, BH);
    image.__image16 = { width: BW, height: BH, data: big };
    adapter.invalidateSilverCoreCache();
    const banded = await convertInBands({ imageData: image, settings: { ...BASE, filmType: mode, ...settings }, options: { forceFullProcess: true } }, 5);
    assert.ok(same(banded.data16, full.__image16.data), `bands = one worker (${mode}${settings.drcSample ? ', editor sample' : ''})`);
  }
  // A frame smaller than the solve grid keeps one worker.
  const small = new ImageData(new Uint8ClampedArray(16), 2, 2);
  small.__image16 = { width: 2, height: 2, data: new Uint16Array(16) };
  assert.equal(bandsSupported({ imageData: small, settings: { drcAmount: 10 }, options: { forceFullProcess: true } }), false);

  // The hint measures inside the picture: the same scene inside a dark holder
  // (an uncropped camera scan: the holder is thin film base, near black once
  // converted, and wide) reads as the picture alone does when the conversion
  // names the picture (the crop, or the detected frame as analysisRegion).
  {
    const PW = 600; const PH = 400; const M = 150;
    const picture = colourNegative(PW, PH);
    const HWd = PW + 2 * M; const HHt = PH + 2 * M;
    const held = new Uint16Array(HWd * HHt * 4);
    for (let y = 0; y < HHt; y++) for (let x = 0; x < HWd; x++) {
      const i = (y * HWd + x) * 4;
      const inside = x >= M && x < M + PW && y >= M && y < M + PH;
      if (inside) held.set(picture.subarray(((y - M) * PW + x - M) * 4, ((y - M) * PW + x - M) * 4 + 4), i);
      else { held[i] = 62000; held[i + 1] = 56000; held[i + 2] = 50000; held[i + 3] = 65535; }
    }
    const region = { left: M / HWd, top: M / HHt, width: PW / HWd, height: PH / HHt };
    const alone = (await convert(picture, PW, PH, { borderBuffer: 0 }, { drcEstimate: true })).__drcEstimate;
    const named = (await convert(held, HWd, HHt, { borderBuffer: 0, analysisRegion: region }, { drcEstimate: true })).__drcEstimate;
    const whole = (await convert(held, HWd, HHt, { borderBuffer: 0 }, { drcEstimate: true })).__drcEstimate;
    const clipped = (e) => e.base.shadows + e.base.highlights;
    close(clipped(named), clipped(alone), 0.06, 'inside the holder the picture reads as it does alone');
    assert.ok(clipped(whole) > clipped(named) + 0.2, `measured on the whole scan the holder counts as clipped (${clipped(whole)} vs ${clipped(named)})`);
    // The hint's measure reads the picture, not the holder, and the map is
    // solved on the picture alone (on fewer cells than the picture alone has,
    // so the two maps are not the same one).
    assert.ok(named.benefit >= 0.5 * alone.benefit, `the benefit inside the holder is of the picture's order (${named.benefit} vs ${alone.benefit})`);
    assert.equal(named.benefit >= drc.DRC_HINT_THRESHOLD, alone.benefit >= drc.DRC_HINT_THRESHOLD, 'the hint decision is the picture alone\'s');
  }

  // No crushed shadows or blown highlights: at the defaults (only Amount
  // moved), a frame never gains near-black (luminance at most 1 %) or
  // near-white (at least 99 %) area beyond a quarter of a percentage point.
  // The scenes are the cases the method alone darkens or brightens into the
  // ends: dark detail inside bright regions over a large dark mass (a backlit
  // forest), a frame whose middle is already near black (night), and its
  // mirror near white (snow, a bright sky over a small dark subject).
  {
    const SW = 600; const SH = 400;
    const sceneNegative = (lum) => {
      const data = new Uint16Array(SW * SH * 4);
      const mask = [0.92, 0.62, 0.42];
      for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
        const scene = lum(x, y);
        const i = (y * SW + x) * 4;
        for (let c = 0; c < 3; c++) data[i + c] = Math.round(Math.min(1, mask[c] * Math.min(1, (scene / 0.18) ** -0.6 * 0.12)) ** (1 / 2.2) * 65535);
        data[i + 3] = 65535;
      }
      return data;
    };
    const texture = (x, y) => 1 + 0.35 * Math.sin(x / 3.1) * Math.sin(y / 4.3);
    const scenes = {
      'backlit forest': (x, y) => {
        const bright = (x > 380 && y < 260) || (x > 120 && x < 200 && y > 120 && y < 200);
        const detail = bright && Math.sin(x / 9) * Math.sin(y / 11) > 0.6;
        return (bright ? (detail ? 0.25 : 2.5) : 0.015) * texture(x, y);
      },
      'night (middle near black)': (x, y) => (x < 360 ? 0.0015 : (y < 200 ? 0.8 : 0.08)) * texture(x, y),
      'snow (middle near white)': (x, y) => (x < 380 ? 6 : (y < 200 ? 0.02 : 0.3)) * texture(x, y),
      room: (x, y) => roomLum(x, y)
    };
    const ends = (data16) => {
      let black = 0; let white = 0; const n = data16.length / 4;
      for (let p = 0; p < n; p++) {
        const Y = (0.2126 * data16[p * 4] + 0.7152 * data16[p * 4 + 1] + 0.0722 * data16[p * 4 + 2]) / 65535;
        if (Y <= 0.01) black++; if (Y >= 0.99) white++;
      }
      return { black: 100 * black / n, white: 100 * white / n };
    };
    for (const [name, lum] of Object.entries(scenes)) {
      const negative = sceneNegative(lum);
      const off = ends((await convert(negative, SW, SH, {})).__image16.data);
      for (const amount of [30, 50, 70, 100]) {
        const on = ends((await convert(negative, SW, SH, { drcAmount: amount })).__image16.data);
        assert.ok(on.black <= off.black + 0.25, `${name}, Amount ${amount}: no shadows crushed (${off.black.toFixed(2)} % -> ${on.black.toFixed(2)} %)`);
        assert.ok(on.white <= off.white + 0.25, `${name}, Amount ${amount}: no highlights blown (${off.white.toFixed(2)} % -> ${on.white.toFixed(2)} %)`);
      }
    }
  }
  // The limit itself: never past the extreme, order kept, inward moves untouched.
  {
    const [low, mid, high] = [-4, -1.5, -0.5];
    for (const g of [0.1, 0.5, 2, 6]) {
      let last = -Infinity;
      for (let h = -5; h <= 0; h += 0.01) {
        const out = h + drc.drcLimitGain(g, h, low, mid, high);
        // (A pixel already past the knee's end moves by a trace, under 0.02.)
        assert.ok(out <= Math.max(high, h + 0.02), `up ${g} from ${h.toFixed(2)} stays below the high extreme`);
        assert.ok(out >= last - 1e-9, 'pixels keep their order');
        last = out;
        const back = h + drc.drcLimitGain(-g, h, low, mid, high);
        assert.ok(back >= Math.min(low, h - 0.02), `down ${g} from ${h.toFixed(2)} stays above the low extreme`);
      }
    }
    assert.equal(drc.drcLimitGain(0.8, -3, low, mid, high), 0.8, 'towards the middle: unchanged');
    assert.equal(drc.drcLimitGain(-0.5, -0.8, low, mid, high), -0.5, 'towards the middle from above: unchanged');
    assert.ok(drc.drcLimitGain(0.3, -0.6, low, mid, high) < 0.05, 'a pixel near the high extreme is hardly moved outwards');
  }

  // The hint's estimate: the compression brings this frame's ends back.
  const est = await convert(neg, W, H, {}, { drcEstimate: true });
  assert.ok(est.__drcEstimate && Number.isFinite(est.__drcEstimate.benefit), 'the estimate comes with the frame');
  assert.ok(same(est.__image16.data, off.__image16.data), 'asking for the estimate changes no pixel');
  const sug = est.__drcEstimate.suggested;
  assert.ok(est.__drcEstimate.benefit >= drc.DRC_HINT_THRESHOLD, `the room scene gets the hint (${est.__drcEstimate.benefit})`);
  assert.ok(sug && sug.drcAmount > 0 && sug.drcDetail === 50, 'Auto sets an amount and keeps Detail');
  // Auto never leaves more near-black or near-white than the photo had.
  const autoFrame = await convert(neg, W, H, sug);
  const endsOf = (d) => { let b = 0; let w = 0; const n = d.length / 4; for (let p = 0; p < n; p++) { const Y = (0.2126 * d[p * 4] + 0.7152 * d[p * 4 + 1] + 0.0722 * d[p * 4 + 2]) / 65535; if (Y <= 0.01) b++; if (Y >= 0.99) w++; } return { b: 100 * b / n, w: 100 * w / n }; };
  const e0 = endsOf(off.__image16.data); const e1 = endsOf(autoFrame.__image16.data);
  assert.ok(e1.b <= e0.b + 0.25 && e1.w <= e0.w + 0.25, `Auto adds no clipped area (${JSON.stringify([e0, e1])})`);
  // A flat, ordinary frame: no hint, and Auto leaves the compression off.
  const flatNeg = new Uint16Array(W * H * 4);
  for (let p = 0; p < W * H; p++) { const v = 0.5 + 0.08 * Math.sin(p / 7) * Math.sin(p / 1300); flatNeg[p * 4] = Math.round(v * 0.9 * 65535); flatNeg[p * 4 + 1] = Math.round(v * 0.7 * 65535); flatNeg[p * 4 + 2] = Math.round(v * 0.55 * 65535); flatNeg[p * 4 + 3] = 65535; }
  const flatEst = (await convert(flatNeg, W, H, {}, { drcEstimate: true })).__drcEstimate;
  assert.ok(flatEst.benefit < drc.DRC_HINT_THRESHOLD, `an ordinary frame gets no hint (${flatEst.benefit})`);
}

console.log('dynamicRange tests passed');
