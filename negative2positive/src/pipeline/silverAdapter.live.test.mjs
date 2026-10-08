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
  createLiveStrokeCoverage,
  addLiveStrokePoints,
  rasterizeExposureStops,
} from '../app/localExposure.js';
import { resampleStrokePoints } from '../app/brushFeedback.js';

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

// A stroke of more than 400 points (#254 A.6): painted live with every point,
// stored resampled to 400 (sanitizeRepairStrokes's index formula) so it keeps
// its end. The settled frame may then differ from the last live frame at the
// stroke's edge. Uniform pressure (mouse, trackpad) and slowly changing pen
// pressure stay within the acceptance bound: at most 2/255 per channel in
// 99.9 % of the stroke's pixels (measured: within 1/255 and 2/255). Pen
// pressure that changes within a few hundred samples cannot be carried by 400
// points (a segment paints with the larger of its two pressures): measured
// 91-99.6 % within 2/255, up to 31/255 at the feather edge; logged here and
// flagged in the #254 notes, not asserted against the bound.
const resampled = [];
{
  const W2 = 480, H2 = 320;
  const geometry = { baseWidth: W2, baseHeight: H2, rotatedWidth: W2, rotatedHeight: H2, rotationAngle: 0, mirrored: false, cropRegion: null };
  const uniform = () => 1;
  const slowPen = (k) => 0.4 + 0.6 * Math.abs(Math.sin(k / 400));
  const fastPen = (k) => 0.4 + 0.6 * Math.abs(Math.sin(k / 40));
  for (const [label, pressure, feather, bounded] of [['mouse', uniform, 0, true], ['mouse', uniform, 0.3, true], ['mouse', uniform, 0.5, true],
    ['mouse', uniform, 1, true], ['slow pen', slowPen, 0.3, true], ['slow pen', slowPen, 0.5, true], ['fast pen', fastPen, 0.3, false]]) {
    invalidateSilverCoreCache();
    const image = negative(1, W2, H2);
    const committedStrokes = [sanitisedStroke(0.6, 0.2, 0.5, [{ x: 0.7, y: 0.7, p: 1 }, { x: 0.8, y: 0.75, p: 1 }])];
    const settingsFor = (strokes) => ({ ...BASE.color, contrast: 8, localExposure: sanitizeLocalExposureForSettings({ strokes }), localExposureGeometry: geometry });
    const before = await convertColorWithSilverCore(image, structuredClone(settingsFor(committedStrokes)), { preview: true, includeAnalysisPreview: false });
    // A 5 s stroke at 120 Hz: 600 samples about a working pixel apart.
    const points = [];
    let x = 0.1, y = 0.3, angle = 0.3;
    for (let k = 0; k < 600; k++) {
      points.push({ x, y, p: pressure(k) });
      angle += Math.sin(k / 55) * 0.02;
      x += Math.cos(angle) * 1.1 / W2; y += Math.sin(angle) * 1.1 / H2;
    }
    const stops = feather === 1 ? -1.3 : 1.2;
    // The live request sends every point, each sanitised as the stored ones.
    const live = { ...sanitisedStroke(stops, 0.12, feather, points.slice(0, 1)),
      points: points.map(point => sanitisedStroke(stops, 0.12, feather, [point]).points[0]) };
    const frame = new Uint8ClampedArray(before.data);
    paint(frame, 'preview', before.__liveFrame, settingsFor(committedStrokes).localExposure, live, Array(120).fill(5), W2);
    const stored = sanitisedStroke(stops, 0.12, feather, resampleStrokePoints(points));
    assert.equal(stored.points.length, 400);
    assert.deepEqual(stored.points.at(-1), live.points.at(-1), 'the stored stroke keeps its end point');
    const after = await convertColorWithSilverCore(image, structuredClone(settingsFor([...committedStrokes, stored])), { scratch: true, includeAnalysisPreview: false });
    // The stroke's pixels: covered by the live or the stored stroke.
    const working = { ...geometry, width: W2, height: H2 };
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
    const result = { label, feather, area, within1: +(100 * within1 / area).toFixed(3), within2: +(100 * within2 / area).toFixed(3), max };
    assert.ok(area > 5000, `the stroke covers ${area} px`);
    if (bounded) assert.ok(within2 / area >= 0.999, `${label} feather ${feather}: outside the pen-up bound ` + JSON.stringify(result));
    resampled.push(result);
  }
}

// Forced (full-resolution) frames are not live.
{
  invalidateSilverCoreCache();
  const forced = await convertColorWithSilverCore(negative(1), { ...BASE.color, localExposureGeometry: geometries[0] }, { forceFullProcess: true });
  assert.equal(forced.__liveFrame, undefined);
}

console.log(`silverAdapter.live: ${checks} painted strokes equal their stored frames (colour, B&W, positive; mouse and pen; every feather; quick second strokes); 600-point strokes vs their 400-point stored frames: ${JSON.stringify(resampled)}`);
