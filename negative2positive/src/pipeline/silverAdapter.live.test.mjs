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
} from '../app/localExposure.js';

const {
  convertColorWithSilverCore, convertBwWithSilverCore, convertPositiveWithSilverCore,
  renderLiveExposureRect, liveExposureGeometry, invalidateSilverCoreCache, getSilverCoreCacheStats,
} = adapter;
const CONVERT = { color: convertColorWithSilverCore, bw: convertBwWithSilverCore, positive: convertPositiveWithSilverCore };

const W = 96, H = 64;
function negative(seed) {
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

// Paints `stroke` over `frame` (its 8-bit data, updated in place) in chunks.
function paint(frame, which, frameSeq, committed, stroke, chunks) {
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
      frame.set(reply.rgba.subarray(y * rect.width * 4, (y + 1) * rect.width * 4), ((rect.y + y) * W + rect.x) * 4);
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

// Forced (full-resolution) frames are not live.
{
  invalidateSilverCoreCache();
  const forced = await convertColorWithSilverCore(negative(1), { ...BASE.color, localExposureGeometry: geometries[0] }, { forceFullProcess: true });
  assert.equal(forced.__liveFrame, undefined);
}

console.log(`silverAdapter.live: ${checks} painted strokes equal their stored frames (colour, B&W, positive; mouse and pen; every feather; quick second strokes)`);
