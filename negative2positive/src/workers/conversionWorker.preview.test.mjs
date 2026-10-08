// #239: the preview worker's `prepare` and `analyze` messages. They share the cached
// source, analysis sample and strokes of the preview contract, transfer only what the
// GPU uploads, never touch a retained plane, and the `convert` (frame) that follows
// them equals a forced conversion on the main thread exactly.
import assert from 'node:assert/strict';
import { convertFrameWithRouter } from '../pipeline/conversionRouter.js';
globalThis.ImageData = class {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
};
let received;
let transferred = [];
globalThis.self = { postMessage: (payload, transfers = []) => {
  transferred = transfers;
  received = structuredClone(payload, { transfer: transfers });
} };
await import('./conversionWorker.js');

function source(seed) {
  const data = new Uint16Array(40 * 30 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([5000 + i * seed % 45000, 3000 + i * seed % 31000, 1000 + i * seed % 23000, 65535], i);
  return { width: 40, height: 30, data };
}
const geometry = { baseWidth: 40, baseHeight: 30, rotatedWidth: 40, rotatedHeight: 30, rotationAngle: 0, mirrored: false };
const localExposure = { strokes: [{ stops: -0.6, size: 0.4, feather: 0.4, points: [{ x: 0.5, y: 0.5, p: 1 }] }] };

let id = 0;
for (const filmType of ['color', 'bw', 'positive']) {
  const input = source(61);
  const analysis = source(23);
  const settings = { filmType, colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 }, localExposure, localExposureGeometry: geometry };
  const options = { preview: true, includeAnalysisPreview: false, analysisImageData: analysis, histogramSamples: 300 };

  // prepare: the first message carries the source, the sample and the strokes.
  const prepare = { type: 'prepare', id: ++id, cacheInput: true, reuseSource: false, reuseAnalysis: false, reuseLocalExposure: false,
    width: 40, height: 30, image16: input.data.buffer.slice(0), settings: { ...settings }, options: { ...options } };
  await self.onmessage({ data: structuredClone(prepare) });
  assert.equal(received.type, 'prepared', received.message);
  assert.equal(received.width, 40);
  if (filmType === 'color') assert.equal(received.pristine.byteLength, 40 * 30 * 8, 'colour: the film-base compensated plane');
  else assert.equal(received.pristine, null, `${filmType}: no compensation, main uploads its own plane`);
  assert.equal(received.stops.byteLength, 40 * 30 * 4, 'the stops map');
  assert.ok(received.histogram.width * received.histogram.height <= 300);
  assert.ok(transferred.every(buffer => buffer.byteLength === 0), 'every buffer is transferred, not copied');

  // analyze: from the cached source, sample and strokes.
  const analyze = { type: 'analyze', id: ++id, cacheInput: true, reuseSource: true, reuseAnalysis: true, reuseLocalExposure: true,
    width: 40, height: 30, key: 'k1', settings: { ...settings, localExposure: null }, options: { preview: true, includeAnalysisPreview: false } };
  await self.onmessage({ data: structuredClone(analyze) });
  assert.equal(received.type, 'analyzed', received.message);
  assert.equal(received.key, 'k1');
  assert.equal(received.channelData.length, 3);
  assert.ok(Number.isFinite(received.channelData[0].whitePointOrigin));
  if (filmType === 'positive') assert.ok(received.positiveAnalysis && received.autoColor === null);
  else assert.ok(received.autoColor && received.positiveAnalysis === null);
  assert.ok(JSON.stringify(received).length < 2000, 'a few hundred bytes');

  // The frame after them equals a forced main-thread conversion.
  const frame = { type: 'convert', id: ++id, cacheInput: true, reuseSource: true, reuseAnalysis: true, reuseLocalExposure: true,
    width: 40, height: 30, settings: { ...settings, localExposure: null, exposure: 30 }, options: { preview: true, includeAnalysisPreview: false } };
  await self.onmessage({ data: structuredClone(frame) });
  assert.equal(received.type, 'result', received.message);
  const expected = await convertFrameWithRouter({ imageData: input, settings: { ...settings, exposure: 30 },
    options: { ...options, forceFullProcess: true } });
  assert.deepEqual(new Uint16Array(received.image16), expected.__image16.data, `${filmType}: frame after prepare/analyze`);
  assert.deepEqual(new Uint8ClampedArray(received.rgba), expected.data);
}

// A retained interactive plane survives prepare/analyze and is still committed.
{
  const input = source(7);
  const settings = { filmType: 'color', colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 } };
  const frame = { type: 'convert', id: ++id, cacheInput: true, reuseSource: false, reuseAnalysis: false, retain16: true,
    width: 40, height: 30, image16: input.data.buffer.slice(0), settings, options: { preview: true, includeAnalysisPreview: false, retain16: true, histogramSamples: 100 } };
  await self.onmessage({ data: structuredClone(frame) });
  assert.equal(received.retained16, true);
  const resultId = frame.id;
  for (const type of ['prepare', 'analyze']) {
    await self.onmessage({ data: { type, id: ++id, cacheInput: true, reuseSource: true, reuseAnalysis: true, width: 40, height: 30,
      settings: { ...settings, preSaturation: 120 }, options: { preview: true } } });
    assert.notEqual(received.type, 'error', received.message);
  }
  await self.onmessage({ data: { type: 'commit', id: ++id, resultId } });
  assert.equal(received.type, 'committed');
  assert.equal(received.image16.byteLength, 40 * 30 * 8, 'prepare/analyze leave the retained plane alone');
}

// Errors come back as errors: a missing cached source.
await self.onmessage({ data: { type: 'analyze', id: ++id, cacheInput: true, reuseSource: true, width: 13, height: 7, settings: {}, options: {} } });
assert.equal(received.type, 'error');

console.log('conversionWorker.preview: prepare/analyze share the preview cache, transfer their planes and leave frames and retained planes exact');
