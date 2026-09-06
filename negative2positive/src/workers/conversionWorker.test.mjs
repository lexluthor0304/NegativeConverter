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
console.log('conversionWorker: 実ルーター・転送後の再利用・解析参照切替・全モードの 16bit 一致を検証');
