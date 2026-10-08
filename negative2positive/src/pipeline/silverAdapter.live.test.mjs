// #254 C: live dodge-and-burn rectangles. A stroke painted over an interactive
// frame, converted one rectangle at a time, must give exactly the frame the
// stroke gets once it is stored and converted, for colour, B&W (grey plane)
// and positives, uniform and pen pressure, every feather, with a quick second
// stroke before the first one's frame has run; and the committed-only
// rectangle equals the frame on screen.
import assert from 'node:assert/strict';
import { live as adapter } from './oracle/adapterParity.mjs';
import {
  sanitizeLocalExposureForSettings,
  sanitizeLocalExposureStrokes,
  sanitizeStrokePoint,
  createLiveStrokeCoverage,
  addLiveStrokePoints,
  rasterizeExposureStops,
  strokeBrush,
  workingPointToBase,
  MAX_STROKE_POINTS,
} from '../app/localExposure.js';
import { resampleStrokePoints, createStrokeRecorder, DENSE_STROKE_POINTS } from '../app/brushFeedback.js';

const {
  convertColorWithSilverCore, convertBwWithSilverCore, convertPositiveWithSilverCore,
  renderLiveExposureRect, liveExposureGeometry, invalidateSilverCoreCache, getSilverCoreCacheStats,
} = adapter;
const CONVERT = { color: convertColorWithSilverCore, bw: convertBwWithSilverCore, positive: convertPositiveWithSilverCore };

const W = 96, H = 64;
function negative(seed, W = 96, H = 64) {
  const data = new Uint16Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const t = (x + y * 0.7 + seed * 3) / (W + H);
      data[i] = Math.min(65535, Math.round(52000 - 30000 * t + ((x * 131 + y * 71 * seed) % 1900)));
      data[i + 1] = Math.min(65535, Math.round(36000 - 22000 * t + ((x * 97 + y * 53 * seed) % 1700)));
      data[i + 2] = Math.min(65535, Math.round(24000 - 15000 * t + ((x * 61 + y * 89 * seed) % 1500)));
      data[i + 3] = (x < 3 && y < 3) ? 0 : 65535;
    }
  }
  return { width: W, height: H, data };
}

let seed = 2549;
const random = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
function path(count, pen) {
  const points = [];
  let x = 0.2 + random() * 0.6, y = 0.2 + random() * 0.6, angle = random() * 6.28;
  for (let k = 0; k < count; k++) {
    points.push({ x, y, p: pen ? 0.1 + random() * 0.9 : 1 });
    angle += (random() - 0.5) * 1.2;
    x += Math.cos(angle) * 0.03; y += Math.sin(angle) * 0.03;
  }
  return points;
}
// A stroke as the Retouch tab stores it, and as the live request sends it.
function sanitisedStroke(stops, size, feather, points) {
  return sanitizeLocalExposureStrokes({ strokes: [{ stops, size, feather, points }] }).strokes[0];
}

const geometries = [
  { baseWidth: W, baseHeight: H, rotatedWidth: W, rotatedHeight: H, rotationAngle: 0, mirrored: false, cropRegion: null },
  { baseWidth: 110, baseHeight: 80, rotatedWidth: 110, rotatedHeight: 80, rotationAngle: 0, mirrored: true, cropRegion: { left: 6, top: 9, width: W, height: H } },
];
const BASE = { color: { colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 } }, bw: { colorModel: 'standard', bwMix: 'red' }, positive: { positiveMode: 'correct' } };

// Paints `stroke` over `frame` (its 8-bit data, `width` wide, updated in place) in chunks.
function paint(frame, which, frameSeq, committed, stroke, chunks, width = W) {
  const geometry = liveExposureGeometry(which, frameSeq);
  assert.ok(geometry, 'the frame is live');
  const store = createLiveStrokeCoverage({ stops: stroke.stops, size: stroke.size, feather: stroke.feather }, geometry);
  let index = 0;
  let rects = 0;
  for (const size of [...chunks, Infinity]) {
    const points = stroke.points.slice(index, index + size);
    index += points.length;
    const rect = addLiveStrokePoints(store, points);
    if (!rect) continue;
    const reply = renderLiveExposureRect(which, { frameSeq, committed, store, rect, withCommitted: true });
    assert.ok(!reply.stale);
    for (let y = 0; y < rect.height; y++) {
      frame.set(reply.rgba.subarray(y * rect.width * 4, (y + 1) * rect.width * 4), ((rect.y + y) * width + rect.x) * 4);
    }
    rects++;
  }
  assert.equal(index, stroke.points.length);
  return rects;
}

let checks = 0;
for (const mode of ['color', 'bw', 'positive']) {
  for (const geometry of geometries) {
    for (const pen of [false, true]) {
      invalidateSilverCoreCache();
      const image = negative(mode === 'bw' ? 2 : 1);
      const committedStrokes = [
        sanitisedStroke(0.8, 0.25, 0.5, path(8, pen)),
        sanitisedStroke(-0.6, 0.12, 0.3, path(1, pen)),
      ];
      const settingsFor = (strokes) => ({ ...BASE[mode], contrast: 8,
        localExposure: strokes.length ? sanitizeLocalExposureForSettings({ strokes }) : null,
        localExposureGeometry: geometry });
      const options = { preview: true, includeAnalysisPreview: false };
      const convert = (strokes) => CONVERT[mode](image, structuredClone(settingsFor(strokes)), options);

      const before = await convert(committedStrokes);
      const frameSeq = before.__liveFrame;
      assert.ok(Number.isInteger(frameSeq), 'an interactive frame is live');
      const shown = new Uint8ClampedArray(before.data);

      // The committed-only rectangle is the frame itself.
      {
        const store = createLiveStrokeCoverage({ stops: 1, size: 0.2, feather: 0.5 }, liveExposureGeometry('preview', frameSeq));
        const rect = addLiveStrokePoints(store, [{ x: 0.5, y: 0.5, p: 1 }]);
        const reply = renderLiveExposureRect('preview', { frameSeq, committed: settingsFor(committedStrokes).localExposure, store, rect, withCommitted: true });
        for (let y = 0; y < rect.height; y++) {
          assert.deepEqual(reply.committedRgba.subarray(y * rect.width * 4, (y + 1) * rect.width * 4),
            shown.subarray(((rect.y + y) * W + rect.x) * 4, ((rect.y + y) * W + rect.x + rect.width) * 4), `${mode} committed rectangle`);
        }
      }

      for (const feather of [0, 0.3, 0.5, 1]) {
        const stroke = sanitisedStroke(feather === 1 ? -1.2 : 1.4, 0.05 + random() * 0.25, feather, path(3 + Math.floor(random() * 30), pen));
        const frame = new Uint8ClampedArray(shown);
        const rects = paint(frame, 'preview', frameSeq, settingsFor(committedStrokes).localExposure, stroke, [1, 1, 2, 5, 100]);
        assert.ok(rects >= 1);
        // The frame of the stored stroke (converted in a scratch slot, so the
        // preview slot keeps the frame the stroke was painted over).
        const after = await CONVERT[mode](image, structuredClone(settingsFor([...committedStrokes, stroke])), { scratch: true, includeAnalysisPreview: false });
        assert.deepEqual(frame, after.data, `${mode} ${pen ? 'pen' : 'mouse'} feather ${feather}: live frame equals the stored stroke's frame`);
        checks++;
      }

      // A quick second stroke: the first is stored (the committed list names it)
      // before any frame of it ran; the worker adds it to its map first.
      {
        const first = sanitisedStroke(1, 0.2, 0.5, path(12, pen));
        const second = sanitisedStroke(-0.8, 0.15, 0.3, path(9, pen));
        const frame = new Uint8ClampedArray(shown);
        paint(frame, 'preview', frameSeq, settingsFor(committedStrokes).localExposure, first, [4, 8]);
        const extendedBefore = getSilverCoreCacheStats().exposureMaps.extended;
        paint(frame, 'preview', frameSeq, settingsFor([...committedStrokes, first]).localExposure, second, [2, 7]);
        assert.equal(getSilverCoreCacheStats().exposureMaps.extended, extendedBefore + 1, 'the stored first stroke extends the map in place');
        const after = await CONVERT[mode](image, structuredClone(settingsFor([...committedStrokes, first, second])), { scratch: true, includeAnalysisPreview: false });
        assert.deepEqual(frame, after.data, `${mode}: two strokes in quick succession`);
        // The preview slot's next frame (the pen-up render of the first stroke) is exact.
        const penUp = await convert([...committedStrokes, first]);
        const reference = await CONVERT[mode](image, structuredClone(settingsFor([...committedStrokes, first])), { scratch: true, includeAnalysisPreview: false });
        assert.deepEqual(penUp.data, reference.data, `${mode}: the pen-up frame after a live extension`);
        checks++;
      }

      // Another conversion in the slot: the old frame is stale.
      const next = await CONVERT[mode](image, { ...structuredClone(settingsFor(committedStrokes)), contrast: 20 }, options);
      assert.equal(liveExposureGeometry('preview', frameSeq), null);
      const store = createLiveStrokeCoverage({ stops: 1, size: 0.2, feather: 0.5 }, geometry.cropRegion ? { ...geometry, width: W, height: H } : { ...geometry, width: W, height: H });
      const rect = addLiveStrokePoints(store, [{ x: 0.5, y: 0.5, p: 1 }]);
      assert.deepEqual(renderLiveExposureRect('preview', { frameSeq, committed: null, store, rect }), { stale: true });
      assert.notEqual(next.__liveFrame, frameSeq);
    }
  }
}

// A stroke of more than 400 points (#254 A.6, #280), recorded as main.js
// records it (createStrokeRecorder): every point up to 400; past that a pen
// stroke keeps one point per eighth of the brush radius, the live effect paints
// exactly the points kept and the pen-up stores them, so the settled frame is
// the last live frame. A stroke of one pressure (mouse, trackpad) keeps every
// point and is resampled to 400 at pen-up, as before #280. Every case meets
// the acceptance bound (at most 2/255 per channel in 99.9 % of the stroke's
// pixels), and pen strokes are exact. Before #280 pen strokes were resampled
// to 400 too: the fast-pressure stroke had 93.0 % of its pixels within 2/255
// (up to 19/255 at the feather edge) and 95.6 % in the frame that holds all
// of it, where no choice of 400 of its 600 points reaches 99.9 % (a greedy
// search with exact coverage costs: 97.6 %, up to 8/255).
const uniform = () => 1;
const slowPen = (k) => 0.4 + 0.6 * Math.abs(Math.sin(k / 400));
const fastPen = (k) => 0.4 + 0.6 * Math.abs(Math.sin(k / 40));
// A 5 s stroke at 120 Hz: 600 samples about a working pixel apart, in working
// pixels as main.js records them. In 480 x 320 it leaves the frame after about
// 290 samples; the 960 x 640 frame (half the brush size, the same radius in
// pixels) holds all of it.
function loopPath(count, pressure) {
  const samples = [];
  let x = 48, y = 96, angle = 0.3;
  for (let k = 0; k < count; k++) {
    samples.push({ x, y, p: pressure(k) });
    angle += Math.sin(k / 55) * 0.02;
    x += Math.cos(angle) * 1.1; y += Math.sin(angle) * 1.1;
  }
  return samples;
}
// A stroke that goes on past MAX_STROKE_POINTS (a long one with a small brush),
// inside the frame.
function longPath(count, pressure) {
  return Array.from({ length: count }, (_, k) => ({ x: 480 + 380 * Math.sin(k / 260), y: 320 + 240 * Math.sin(k / 190 + 0.5), p: pressure(k) }));
}
const longStrokes = [];
for (const { W2, H2, size, path = loopPath, count = 600, cases } of [
  { W2: 480, H2: 320, size: 0.12, cases: [['mouse', uniform, 0], ['mouse', uniform, 0.3], ['mouse', uniform, 0.5], ['mouse', uniform, 1],
    ['slow pen', slowPen, 0.3], ['slow pen', slowPen, 0.5], ['fast pen', fastPen, 0.3]] },
  { W2: 960, H2: 640, size: 0.06, cases: [['mouse', uniform, 0.3], ['slow pen', slowPen, 0.3], ['fast pen', fastPen, 0.3], ['fast pen', fastPen, 0.5]] },
  // Past the cap the pen stroke is resampled to MAX_STROKE_POINTS: logged, not
  // bounded (docs/darkroom.md, Limits).
  { W2: 960, H2: 640, size: 0.03, path: longPath, count: 2400, cases: [['long fast pen', fastPen, 0.3]] },
]) {
  const geometry = { baseWidth: W2, baseHeight: H2, rotatedWidth: W2, rotatedHeight: H2, rotationAngle: 0, mirrored: false, cropRegion: null };
  const working = { ...geometry, width: W2, height: H2 };
  const image = negative(1, W2, H2);
  for (const [label, pressure, feather] of cases) {
    invalidateSilverCoreCache();
    const committedStrokes = [sanitisedStroke(0.6, 0.2, 0.5, [{ x: 0.7, y: 0.7, p: 1 }, { x: 0.8, y: 0.75, p: 1 }])];
    const settingsFor = (strokes) => ({ ...BASE.color, contrast: 8, localExposure: sanitizeLocalExposureForSettings({ strokes }), localExposureGeometry: geometry });
    const before = await convertColorWithSilverCore(image, structuredClone(settingsFor(committedStrokes)), { preview: true, includeAnalysisPreview: false });
    const samples = path(count, pressure);
    const stops = feather === 1 ? -1.3 : 1.2;
    const pen = label !== 'mouse';
    // The brush as the live request sends it (sanitised) and the recorder main.js uses.
    const parameters = sanitisedStroke(stops, size, feather, [{ x: 0.5, y: 0.5 }]);
    const brush = { stops: parameters.stops, size: parameters.size, feather: parameters.feather };
    const recorder = createStrokeRecorder({ spacing: strokeBrush(brush, working).radius / 8, decimate: pen });
    const painted = samples.filter(point => recorder.add(point));
    const end = recorder.finish();
    if (end) painted.push(end);
    // The live request sends the painted points, each sanitised as stored ones.
    const toBase = (point) => ({ ...workingPointToBase(point, working), p: point.p });
    const live = { ...brush, points: painted.map(point => sanitizeStrokePoint(toBase(point))) };
    const frame = new Uint8ClampedArray(before.data);
    paint(frame, 'preview', before.__liveFrame, settingsFor(committedStrokes).localExposure, live, Array(Math.ceil(painted.length / 5)).fill(5), W2);
    // The pen-up stores the stroke as main.js does.
    const stored = sanitisedStroke(stops, size, feather, resampleStrokePoints(recorder.points, pen ? MAX_STROKE_POINTS : DENSE_STROKE_POINTS).map(toBase));
    assert.deepEqual(stored.points.at(-1), sanitizeStrokePoint(toBase(samples.at(-1))), `${label}: the stored stroke keeps its end point`);
    const capped = recorder.points.length > MAX_STROKE_POINTS;
    if (!pen) assert.equal(stored.points.length, DENSE_STROKE_POINTS, 'a mouse stroke is resampled to 400 points, as before');
    else if (!capped) {
      assert.deepEqual(stored.points, live.points, `${label}: the stored stroke is the painted one`);
      assert.ok(stored.points.length > DENSE_STROKE_POINTS, `${label}: ${stored.points.length} points, more than 400`);
      assert.deepEqual(stored.points.slice(0, DENSE_STROKE_POINTS), samples.slice(0, DENSE_STROKE_POINTS).map(point => sanitizeStrokePoint(toBase(point))),
        `${label}: the first 400 samples are kept as recorded`);
    } else assert.equal(stored.points.length, MAX_STROKE_POINTS);
    const after = await convertColorWithSilverCore(image, structuredClone(settingsFor([...committedStrokes, stored])), { scratch: true, includeAnalysisPreview: false });
    // The stroke's pixels: covered by the live or the stored stroke.
    const coverLive = rasterizeExposureStops({ strokes: [{ ...live, stops: 1 }] }, working);
    const coverStored = rasterizeExposureStops({ strokes: [{ ...stored, stops: 1 }] }, working);
    let area = 0, within1 = 0, within2 = 0, max = 0;
    for (let i = 0; i < W2 * H2; i++) {
      if (!coverLive[i] && !coverStored[i]) continue;
      area++;
      let d = 0;
      for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(frame[i * 4 + c] - after.data[i * 4 + c]));
      if (d <= 1) within1++;
      if (d <= 2) within2++;
      if (d > max) max = d;
    }
    const result = { label, frame: `${W2}x${H2}`, feather, samples: samples.length, stored: stored.points.length, area,
      within1: +(100 * within1 / area).toFixed(3), within2: +(100 * within2 / area).toFixed(3), max };
    assert.ok(area > 5000, `the stroke covers ${area} px`);
    if (!capped) {
      assert.ok(within2 / area >= 0.999, `${label} feather ${feather}: outside the pen-up bound ` + JSON.stringify(result));
      if (pen) assert.deepEqual(frame, after.data, `${label} feather ${feather}: the settled frame is the last live frame`);
    }
    longStrokes.push(result);
  }
}

// Forced (full-resolution) frames are not live.
{
  invalidateSilverCoreCache();
  const forced = await convertColorWithSilverCore(negative(1), { ...BASE.color, localExposureGeometry: geometries[0] }, { forceFullProcess: true });
  assert.equal(forced.__liveFrame, undefined);
}

console.log(`silverAdapter.live: ${checks} painted strokes equal their stored frames (colour, B&W, positive; mouse and pen; every feather; quick second strokes); long strokes, settled vs last live frame: ${JSON.stringify(longStrokes)}`);
