// #254 C in the preview worker: `exposureLive` requests paint a stroke over the
// live frame of the last interactive conversion, rectangle by rectangle, and the
// painted frame equals the conversion of the stored stroke. Stale frames and
// strokes without their first points are refused.
import assert from 'node:assert/strict';
import { convertFrameWithRouter } from '../pipeline/conversionRouter.js';
import { sanitizeLocalExposureForSettings, sanitizeLocalExposureStrokes } from '../app/localExposure.js';

globalThis.ImageData = class {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
};
let received;
globalThis.self = { postMessage: (payload, transfers = []) => { received = structuredClone(payload, { transfer: transfers }); } };
await import('./conversionWorker.js');

const W = 64, H = 48;
function source(seed) {
  const data = new Uint16Array(W * H * 4);
  for (let i = 0; i < data.length; i += 4) data.set([5000 + i * seed % 45000, 3000 + i * seed % 31000, 1000 + i * seed % 23000, 65535], i);
  return { width: W, height: H, data };
}
const geometry = { baseWidth: W, baseHeight: H, rotatedWidth: W, rotatedHeight: H, rotationAngle: 0, mirrored: false, cropRegion: null };
const stroke = (stops, size, feather, points) => sanitizeLocalExposureStrokes({ strokes: [{ stops, size, feather, points }] }).strokes[0];
const committed = sanitizeLocalExposureForSettings({ strokes: [stroke(0.7, 0.3, 0.5, [{ x: 0.3, y: 0.3, p: 1 }, { x: 0.6, y: 0.5, p: 1 }])] });

let id = 0;
async function send(message) {
  await self.onmessage({ data: structuredClone(message) });
  return received;
}

for (const filmType of ['color', 'bw', 'positive']) {
  const input = source(filmType === 'bw' ? 41 : 73);
  const settings = { filmType, colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 }, localExposure: committed, localExposureGeometry: geometry };
  const converted = await send({ type: 'convert', id: ++id, cacheInput: true, reuseSource: false, reuseAnalysis: false,
    width: W, height: H, image16: input.data.buffer.slice(0), settings, options: { preview: true, includeAnalysisPreview: false } });
  assert.equal(converted.type, 'result', converted.message);
  assert.deepEqual(converted.liveFrame && Object.keys(converted.liveFrame).sort(), ['seq', 'slot']);
  assert.equal(converted.liveFrame.slot, 'preview');
  const frame = new Uint8ClampedArray(converted.rgba);

  const painted = stroke(-1, 0.2, 0.3, Array.from({ length: 14 }, (_, k) => ({ x: 0.2 + k * 0.04, y: 0.7 - k * 0.02, p: 1 })));
  const live = { stops: painted.stops, size: painted.size, feather: painted.feather };
  let first = true;
  for (let k = 0; k < painted.points.length; k += 3) {
    const reply = await send({ type: 'exposureLive', id: ++id, slot: 'preview', frameSeq: converted.liveFrame.seq,
      stroke: live, points: painted.points.slice(k, k + 3), reset: first, withCommitted: false, ...(first ? { committed } : {}) });
    first = false;
    assert.equal(reply.type, 'exposureLive', reply.message);
    const { rect } = reply;
    const rgba = new Uint8ClampedArray(reply.rgba);
    for (let y = 0; y < rect.height; y++) frame.set(rgba.subarray(y * rect.width * 4, (y + 1) * rect.width * 4), ((rect.y + y) * W + rect.x) * 4);
  }
  const expected = await convertFrameWithRouter({ imageData: input,
    settings: { ...settings, localExposure: sanitizeLocalExposureForSettings({ strokes: [...committed.strokes, painted] }) },
    options: { scratch: true, includeAnalysisPreview: false } });
  assert.deepEqual(frame, expected.data, `${filmType}: the painted frame equals the stored stroke's frame`);

  // The whole stroke again (a source upload replaced the rectangles).
  const again = await send({ type: 'exposureLive', id: ++id, slot: 'preview', frameSeq: converted.liveFrame.seq, stroke: live, points: [], fullStroke: true });
  assert.ok(again.rect && again.rect.width > 0);

  // Pen-up and cancel release every live tile and the committed list.
  for (const reason of ['commit', 'cancel']) {
    const ended = await send({ type: 'exposureLive', id: ++id, end: true, reason });
    assert.equal(ended.ended, true);
    const probe = await send({ type: 'exposureLive', id: ++id, probe: true });
    assert.equal(probe.hasLive, false);
    assert.equal(probe.hasCommitted, false);
    const unstarted = await send({ type: 'exposureLive', id: ++id, slot: 'preview', frameSeq: converted.liveFrame.seq,
      stroke: live, points: [{ x: 0.5, y: 0.5, p: 1 }] });
    assert.equal(unstarted.needsReset, true, 'the next stroke starts empty');
    await send({ type: 'exposureLive', id: ++id, slot: 'preview', frameSeq: converted.liveFrame.seq,
      strokeId: 42, stroke: live, points: painted.points.slice(0, 2), reset: true, committed });
  }
  await send({ type: 'exposureLive', id: ++id, end: true, strokeId: 41 });
  assert.equal((await send({ type: 'exposureLive', id: ++id, probe: true })).hasLive, true, 'late end cannot clear the new stroke');
  await send({ type: 'exposureLive', id: ++id, end: true, strokeId: 42 });
  assert.equal((await send({ type: 'exposureLive', id: ++id, probe: true })).hasLive, false);

  // A request for another frame, and a stroke that never started, are refused.
  assert.equal((await send({ type: 'exposureLive', id: ++id, slot: 'preview', frameSeq: converted.liveFrame.seq + 1000, stroke: live, points: [] })).stale, true);
  assert.equal((await send({ type: 'exposureLive', id: ++id, slot: 'preview', frameSeq: converted.liveFrame.seq, stroke: live, points: [{ x: 0.5, y: 0.5, p: 1 }] })).needsReset, true);
  // A newer frame makes the old one stale.
  const next = await send({ type: 'convert', id: ++id, cacheInput: true, reuseSource: true, reuseAnalysis: true,
    width: W, height: H, settings: { ...settings, localExposure: null, contrast: 10 }, options: { preview: true, includeAnalysisPreview: false } });
  assert.notEqual(next.liveFrame.seq, converted.liveFrame.seq);
  assert.equal((await send({ type: 'exposureLive', id: ++id, slot: 'preview', frameSeq: converted.liveFrame.seq, stroke: live, points: [], reset: true })).stale, true);
}

// Forced conversions carry no live frame.
{
  const forced = await send({ type: 'convert', id: ++id, width: W, height: H, image16: source(5).data.buffer,
    settings: { filmType: 'color', localExposureGeometry: geometry }, options: { forceFullProcess: true } });
  assert.equal(forced.liveFrame, undefined);
}

console.log('conversionWorker.live: live rectangles over the preview frame equal the stored stroke; stale frames and unstarted strokes refused');
