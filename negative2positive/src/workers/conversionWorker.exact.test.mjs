// #254 follow-up: a live dodge-and-burn stroke over the display preview of a
// full-resolution frame. That display (the full render converted, then
// filtered) is not the preview worker's frame of the same settings (the
// negative filtered, then converted): the two differ at edges and on grain, so
// a pen-up that put the worker's frame on screen changed the photo outside the
// stroke, and displayed + (live - committed) missed the exact frame inside it.
// `exposureExact` converts the stroke's region of the source as the full render
// converts it (with that render's analysis) and filters it as its display was
// filtered: the painted display equals the display of the full render with the
// stroke, bit for bit in both planes, and nothing outside the rectangles moves.
import assert from 'node:assert/strict';
import { sanitizeLocalExposureForSettings, sanitizeLocalExposureStrokes } from '../app/localExposure.js';
import { sanitizeFlatFieldMap } from '../app/flatField.js';

globalThis.ImageData = class {
  constructor(a, b, c) {
    if (typeof a === 'number') Object.assign(this, { width: a, height: b, data: new Uint8ClampedArray(a * b * 4) });
    else Object.assign(this, { data: a, width: b, height: c });
  }
};
let received;
globalThis.self = { postMessage: (payload, transfers = []) => { received = structuredClone(payload, { transfer: transfers }); } };
await import('./conversionWorker.js');

let id = 0;
async function send(message) {
  await self.onmessage({ data: structuredClone(message) });
  return received;
}

// A negative with hard edges (frame lines, a bright patch) and grain over a
// gradient: the content on which converting and filtering do not commute.
function negative(W, H, seed) {
  const data = new Uint16Array(W * H * 4);
  let rng = seed;
  const noise = () => ((rng = (Math.imul(rng, 1103515245) + 12345) >>> 0) >>> 20) - 2048;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const t = (x + y * 0.6) / (W + H);
      const edge = (x % 37 < 3 || y % 29 < 2) ? 0.35 : 1;
      const patch = x > W * 0.55 && x < W * 0.8 && y > H * 0.2 && y < H * 0.6 ? 0.5 : 1;
      const k = edge * patch;
      data[i] = Math.max(0, Math.min(65535, Math.round((52000 - 26000 * t) * k + noise())));
      data[i + 1] = Math.max(0, Math.min(65535, Math.round((36000 - 19000 * t) * k + noise())));
      data[i + 2] = Math.max(0, Math.min(65535, Math.round((24000 - 13000 * t) * k + noise())));
      data[i + 3] = 65535;
    }
  }
  return data;
}

const stroke = (stops, size, feather, points) => sanitizeLocalExposureStrokes({ strokes: [{ stops, size, feather, points }] }).strokes[0];
const W = 150, H = 100;
const plain = { baseWidth: W, baseHeight: H, rotatedWidth: W, rotatedHeight: H, rotationAngle: 0, mirrored: false, cropRegion: null };
// Mirrored and cropped from a larger base: the stroke maps through the chain.
const cropped = { baseWidth: 180, baseHeight: 130, rotatedWidth: 180, rotatedHeight: 130, rotationAngle: 0, mirrored: true,
  cropRegion: { left: 12, top: 17, width: W, height: H } };
const BASE = { color: { colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 } }, bw: { colorModel: 'standard', bwMix: 'red' }, positive: { positiveMode: 'correct' } };

function sample(data) {
  // A reduced copy, as getColorAnalysisSample hands the conversions.
  const w = 50, h = 33, out = new Uint16Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const from = (Math.floor(y * H / h) * W + Math.floor(x * W / w)) * 4;
    out.set(data.subarray(from, from + 4), (y * w + x) * 4);
  }
  return { width: w, height: h, data: out };
}

function stats(a, b, area = null) {
  let n = 0, over2 = 0, max = 0;
  for (let p = 0; p < a.length / 4; p++) {
    if (area && !area[p]) continue;
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a[p * 4 + c] - b[p * 4 + c]));
    n++;
    if (d > 2) over2++;
    max = Math.max(max, d);
  }
  return { n, over2, max, within2: n ? +(100 * (1 - over2 / n)).toFixed(2) : 100 };
}

// A flat field (lens fall-off) placed by its frame position, as regions place it.
const flatFieldFor = (geometry) => ({
  flatField: sanitizeFlatFieldMap({ id: 'pad', width: 2, height: 2, gains: [1, 1.1, 1.2, 1.05, 1, 1.1, 1.2, 1.3, 1, 1, 1.1, 1.2] }),
  flatFieldGeometry: { ...geometry },
});

let cases = 0;
for (const [filmType, flat] of [['color', false], ['color', true], ['bw', false], ['positive', false]]) {
  for (const [geometryName, geometry] of [['plain', plain], ['mirrored crop', cropped]]) {
    for (const [targetName, target] of [['bilinear', { width: 97, height: 64 }], ['area', { width: 50, height: 33 }]]) {
      for (const withSample of [false, true]) {
        const label = `${filmType}${flat ? ' with a flat field' : ''}, ${geometryName}, ${targetName} display, ${withSample ? 'analysis sample' : 'own analysis'}`;
        const source = negative(W, H, 7 + cases);
        const analysisImageData = withSample ? sample(source) : null;
        const committed = sanitizeLocalExposureForSettings({ strokes: [stroke(0.7, 0.3, 0.5, [{ x: 0.3, y: 0.3, p: 1 }, { x: 0.6, y: 0.5, p: 1 }])] });
        const settings = { filmType, ...BASE[filmType], ...(flat ? flatFieldFor(geometry) : {}), localExposure: committed, localExposureGeometry: geometry };
        // The full-resolution render as main asks for it: its display preview
        // and the analysis it converted with.
        const render = async (localExposure) => {
          const reply = await send({ type: 'convert', id: ++id, width: W, height: H, image16: source.slice().buffer,
            settings: { ...settings, localExposure },
            options: { forceFullProcess: true, includeAnalysisPreview: false, returnAnalysis: true, displayTarget: target, histogramSamples: 4096,
              ...(analysisImageData ? { analysisImageData } : {}) } });
          assert.equal(reply.type, 'result', reply.message);
          assert.ok(reply.analysis && reply.displayPreview, `${label}: the render returns its analysis and display`);
          return { analysis: reply.analysis, rgba: new Uint8ClampedArray(reply.displayPreview.rgba), image16: new Uint16Array(reply.displayPreview.image16) };
        };
        const before = await render(committed);
        // The preview worker's frame of the same settings, which caches the source (k = 1).
        const preview = async (localExposure, reuse) => {
          const reply = await send({ type: 'convert', id: ++id, cacheInput: true, reuseSource: reuse, reuseAnalysis: false, width: W, height: H,
            ...(reuse ? {} : { image16: source.slice().buffer }), display: { target, geometry: { sourceWidth: W, sourceHeight: H, k: 1 } },
            settings: { ...settings, localExposure }, options: { preview: true, includeAnalysisPreview: false, ...(analysisImageData ? { analysisImageData } : {}) } });
          assert.equal(reply.type, 'result', reply.message);
          return new Uint8ClampedArray(reply.rgba);
        };
        const workerBefore = await preview(committed, false);
        // The cause: the worker's frame is not the display on screen.
        const cause = stats(workerBefore, before.rgba);
        assert.ok(cause.over2 > 0, `${label}: the preview worker's frame differs from the full render's display (${JSON.stringify(cause)})`);

        // Paint a stroke with exact rectangles into a copy of the display.
        const painted = stroke(1.2, 0.25, 0.5, Array.from({ length: 16 }, (_, k) => ({ x: 0.15 + k * 0.045, y: 0.75 - k * 0.03, p: 0.4 + (k % 5) * 0.12 })));
        const live = { stops: painted.stops, size: painted.size, feather: painted.feather };
        const exact = { settings, analysis: before.analysis, frame: { width: W, height: H }, display: { ...target, k: 1 },
          geometry: { ...geometry, width: W, height: H } };
        const screen = { rgba: before.rgba.slice(), image16: before.image16.slice() };
        const touched = new Uint8Array(target.width * target.height);
        for (let k = 0; k < painted.points.length; k += 4) {
          const reply = await send({ type: 'exposureExact', id: ++id, strokeId: 5, stroke: live, points: painted.points.slice(k, k + 4),
            reset: k === 0, ...(k === 0 ? { exact } : {}) });
          assert.equal(reply.type, 'exposureLive', reply.message);
          if (!reply.rect) continue;
          const { rect } = reply;
          const rgba = new Uint8ClampedArray(reply.rgba), image16 = new Uint16Array(reply.image16);
          for (let y = 0; y < rect.height; y++) {
            const to = ((rect.y + y) * target.width + rect.x) * 4;
            screen.rgba.set(rgba.subarray(y * rect.width * 4, (y + 1) * rect.width * 4), to);
            screen.image16.set(image16.subarray(y * rect.width * 4, (y + 1) * rect.width * 4), to);
            touched.fill(1, (rect.y + y) * target.width + rect.x, (rect.y + y) * target.width + rect.x + rect.width);
          }
        }
        const after = await render(sanitizeLocalExposureForSettings({ strokes: [...committed.strokes, painted] }));
        assert.deepEqual(screen.rgba, after.rgba, `${label}: the painted display equals the exact display of the stored stroke (8-bit)`);
        assert.deepEqual(screen.image16, after.image16, `${label}: ... and its 16-bit plane`);
        // Outside the rectangles the exact display did not move.
        for (let p = 0; p < touched.length; p++) {
          if (touched[p]) continue;
          for (let c = 0; c < 4; c++) assert.equal(after.image16[p * 4 + c], before.image16[p * 4 + c], `${label}: nothing outside the rectangles changes`);
        }
        // What the delta composition gave instead, for the record.
        const workerAfter = await preview(sanitizeLocalExposureForSettings({ strokes: [...committed.strokes, painted] }), true);
        const composite = before.rgba.map((v, i) => (i % 4 === 3 ? v : Math.max(0, Math.min(255, v + workerAfter[i] - workerBefore[i]))));
        const area = new Uint8Array(touched.length);
        for (let p = 0; p < area.length; p++) {
          for (let c = 0; c < 3; c++) if (after.rgba[p * 4 + c] !== before.rgba[p * 4 + c]) area[p] = 1;
        }
        const delta = stats(composite, after.rgba, area);
        const outside = stats(workerAfter, before.rgba, touched.map(v => 1 - v));
        if (cases % 6 === 0) console.log(`${label}: worker frame vs display outside the stroke ${JSON.stringify(outside)}; delta composite vs exact frame in the stroke ${JSON.stringify(delta)}`);
        await send({ type: 'exposureLive', id: ++id, end: true, strokeId: 5 });
        cases++;
      }
    }
  }
}

// A stroke without its first request, a late end of another stroke, and a
// cached source that is not the frame's are refused.
{
  const source = negative(W, H, 3);
  const settings = { filmType: 'color', ...BASE.color, localExposure: null, localExposureGeometry: plain };
  const full = await send({ type: 'convert', id: ++id, width: W, height: H, image16: source.slice().buffer, settings,
    options: { forceFullProcess: true, includeAnalysisPreview: false, returnAnalysis: true, displayTarget: { width: 97, height: 64 } } });
  await send({ type: 'convert', id: ++id, cacheInput: true, reuseSource: false, reuseAnalysis: false, sourceSeq: 7, width: W, height: H, image16: source.slice().buffer,
    display: { target: { width: 97, height: 64 }, geometry: { sourceWidth: W, sourceHeight: H, k: 1 } }, settings, options: { preview: true, includeAnalysisPreview: false } });
  const live = { stops: 1, size: 0.2, feather: 0.5 };
  const exact = { settings, analysis: full.analysis, frame: { width: W, height: H }, display: { width: 97, height: 64, k: 1 }, geometry: { ...plain, width: W, height: H } };
  assert.equal((await send({ type: 'exposureExact', id: ++id, strokeId: 9, stroke: live, points: [{ x: 0.5, y: 0.5, p: 1 }] })).needsReset, true);
  // The client numbers its sources: another source of the same size is not this frame's.
  assert.equal((await send({ type: 'exposureExact', id: ++id, strokeId: 9, stroke: live, points: [{ x: 0.5, y: 0.5, p: 1 }], reset: true, exact, sourceSeq: 6 })).stale, true,
    'a source of the same size but another number is refused');
  assert.ok((await send({ type: 'exposureExact', id: ++id, strokeId: 9, stroke: live, points: [{ x: 0.5, y: 0.5, p: 1 }], reset: true, exact, sourceSeq: 7 })).rect);
  assert.equal((await send({ type: 'exposureLive', id: ++id, probe: true })).hasExact, true);
  await send({ type: 'exposureLive', id: ++id, end: true, strokeId: 8 });
  assert.equal((await send({ type: 'exposureLive', id: ++id, probe: true })).hasExact, true, 'a late end of another stroke keeps this one');
  await send({ type: 'exposureLive', id: ++id, end: true, strokeId: 9 });
  assert.equal((await send({ type: 'exposureLive', id: ++id, probe: true })).hasExact, false);
  // The worker's cached source moved on to another frame.
  const other = negative(80, 60, 4);
  await send({ type: 'convert', id: ++id, cacheInput: true, reuseSource: false, reuseAnalysis: false, width: 80, height: 60, image16: other.buffer,
    settings: { ...settings, localExposureGeometry: { ...plain, baseWidth: 80, baseHeight: 60, rotatedWidth: 80, rotatedHeight: 60 } }, options: { preview: true, includeAnalysisPreview: false } });
  assert.equal((await send({ type: 'exposureExact', id: ++id, strokeId: 10, stroke: live, points: [{ x: 0.5, y: 0.5, p: 1 }], reset: true, exact })).stale, true);
}

console.log(`conversionWorker exact: ${cases} cases (colour with and without a flat field, B&W, positive; plain and mirrored-crop geometry; bilinear and area displays; with and without an analysis sample): the painted display equals the exact display of the stored stroke in both planes, nothing outside the rectangles changes, and the worker's own frame differs from that display`);
