import assert from 'node:assert/strict';
import { convertFrameWithRouter } from '../pipeline/conversionRouter.js';
globalThis.ImageData = class {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
};
let received;
globalThis.self = { postMessage: (payload, transfers = []) => { received = structuredClone(payload, { transfer: transfers }); } };
await import('./conversionWorker.js');
function source(seed) {
  const data = new Uint16Array(40 * 30 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([5000 + i * seed % 45000, 3000 + i * seed % 31000, 1000 + i * seed % 23000, 65535], i);
  return { width: 40, height: 30, data };
}
let id = 0;
for (const filmType of ['color', 'bw', 'positive']) {
  const input = source(73);
  let analysis = source(37);
  const settings = { filmType, colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 } };
  for (const phase of ['first', 'reuse', 'reference-change', 'reference-clear', 'source-change']) {
    if (phase === 'reference-change') analysis = source(19);
    if (phase === 'reference-clear') analysis = null;
    const current = phase === 'source-change' ? source(11) : input;
    const options = { preview: true, includeAnalysisPreview: false, analysisImageData: analysis };
    const reuseSource = !['first', 'source-change'].includes(phase);
    const message = { type: 'convert', id: ++id, cacheInput: true, reuseSource, reuseAnalysis: phase === 'reuse',
      width: current.width, height: current.height, settings: { ...settings, exposure: id * 3 }, options: { ...options } };
    if (!reuseSource) message.image16 = current.data.buffer;
    if (message.reuseAnalysis) delete message.options.analysisImageData;
    await self.onmessage({ data: structuredClone(message) });
    assert.equal(received.type, 'result', received.message);
    const expected = await convertFrameWithRouter({ imageData: current, settings: message.settings, options: { ...options, forceFullProcess: true } });
    assert.deepEqual(new Uint16Array(received.image16), expected.__image16.data, `${filmType}/${phase}: 主スレッドと 16bit 完全一致`);
    assert.deepEqual(new Uint8ClampedArray(received.rgba), expected.data);
    assert.equal(current.data.byteLength, 40 * 30 * 8);
  }
}

// #233: interactive frames keep their 16-bit plane in the worker, reuse it as
// the next frame's work buffer, and hand it over on commit. The committed plane
// and the histogram sample must equal a non-interactive conversion exactly.
const { downsampleImageDataForMaxPixels } = await import('../app/imageDataOps.js');
const NativeUint16Array = Uint16Array;
let largePlanes = 0;
const planeLength = 40 * 30 * 4;
for (const filmType of ['color', 'bw', 'positive']) {
  const input = source(29);
  const settings = { filmType, colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 } };
  const options = { preview: true, includeAnalysisPreview: false, analysisImageData: source(17), retain16: true, histogramSamples: 100 };
  const frames = [];
  for (let frame = 0; frame < 3; frame++) {
    const message = { type: 'convert', id: ++id, cacheInput: true, reuseSource: frame > 0, reuseAnalysis: frame > 0, retain16: true,
      width: input.width, height: input.height, settings: { ...settings, exposure: frame * 7 - 5 }, options: { ...options } };
    if (frame === 0) message.image16 = input.data.buffer.slice(0);
    if (frame > 0) delete message.options.analysisImageData;
    // Count 16-bit image planes (not the 65536-entry curve tables) allocated
    // once the first frame has set up.
    if (frame > 0) {
      globalThis.Uint16Array = new Proxy(NativeUint16Array, {
        construct(target, args) {
          const created = Reflect.construct(target, args);
          if (created.length === planeLength) largePlanes++;
          return created;
        }
      });
    }
    try {
      await self.onmessage({ data: structuredClone(message) });
    } finally {
      globalThis.Uint16Array = NativeUint16Array;
    }
    assert.equal(received.type, 'result', received.message);
    assert.equal(received.retained16, true, `${filmType}: the plane stays in the worker`);
    assert.ok(!('image16' in received), `${filmType}: an interactive frame transfers no 16-bit plane`);
    assert.ok(received.histogram.width * received.histogram.height <= 100);
    frames.push({ id: message.id, settings: message.settings, histogram: received.histogram, rgba: received.rgba });
  }
  assert.equal(largePlanes, 0, `${filmType}: later frames write into the retained plane`);
  await self.onmessage({ data: { type: 'commit', id: ++id, resultId: frames[1].id } });
  assert.equal(received.type, 'committed');
  assert.equal(received.image16, null, `${filmType}: a superseded frame's plane is no longer there`);
  const last = frames.at(-1);
  await self.onmessage({ data: { type: 'commit', id: ++id, resultId: last.id } });
  assert.equal(received.type, 'committed');
  const expected = await convertFrameWithRouter({ imageData: input, settings: last.settings,
    options: { preview: true, includeAnalysisPreview: false, analysisImageData: source(17), forceFullProcess: true } });
  assert.deepEqual(new Uint16Array(received.image16), expected.__image16.data, `${filmType}: committed plane equals a fresh conversion`);
  assert.deepEqual(new Uint8ClampedArray(last.rgba), expected.data);
  const sample = downsampleImageDataForMaxPixels(expected, 100);
  assert.deepEqual(new Uint8ClampedArray(last.histogram.rgba), sample.data);
  assert.deepEqual(new Uint16Array(last.histogram.image16), sample.__image16.data, `${filmType}: histogram sample keeps 16 bits`);
  await self.onmessage({ data: { type: 'commit', id: ++id, resultId: last.id } });
  assert.equal(received.image16, null, 'a plane is handed over once');
}

{
  // A non-retaining request drops the retained plane; a small frame whose
  // histogram sample is the frame itself keeps its plane in the reply.
  const input = source(5);
  const settings = { filmType: 'color', colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 } };
  const retainedId = ++id;
  await self.onmessage({ data: { type: 'convert', id: retainedId, cacheInput: true, retain16: true, width: 40, height: 30,
    image16: input.data.buffer.slice(0), settings, options: { preview: true, includeAnalysisPreview: false, retain16: true, histogramSamples: 100 } } });
  assert.equal(received.retained16, true);
  await self.onmessage({ data: { type: 'convert', id: ++id, cacheInput: true, reuseSource: true, width: 40, height: 30,
    settings, options: { preview: true, includeAnalysisPreview: false } } });
  assert.ok(received.image16 && !received.retained16);
  await self.onmessage({ data: { type: 'commit', id: ++id, resultId: retainedId } });
  assert.equal(received.image16, null);
  await self.onmessage({ data: { type: 'convert', id: ++id, cacheInput: true, reuseSource: true, retain16: true, width: 40, height: 30,
    settings, options: { preview: true, includeAnalysisPreview: false, retain16: true } } });
  assert.ok(received.image16 && !received.retained16, 'a frame no larger than the histogram sample is sent whole');
}

console.log('conversionWorker: 実ルーター・転送後の再利用・解析参照切替・全モードの 16bit 一致、操作中の 16bit 保持と確定を検証');
