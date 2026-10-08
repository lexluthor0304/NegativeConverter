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


// Unchanged dodge-and-burn strokes are posted once: later preview frames use
// the retained copy and still match a conversion that receives them.
{
  const input = source(53);
  const strokes = { strokes: [{ stops: 1.5, size: 0.3, feather: 0.5, points: [{ x: 0.3, y: 0.4, p: 1 }, { x: 0.7, y: 0.6, p: 1 }] }] };
  const settings = { filmType: 'color', colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 },
    localExposureGeometry: { baseWidth: 40, baseHeight: 30, rotatedWidth: 40, rotatedHeight: 30, rotationAngle: 0, mirrored: false, cropRegion: null } };
  const options = { preview: true, includeAnalysisPreview: false };
  const post = async (phase, localExposure, reuseLocalExposure) => {
    const message = { type: 'convert', id: ++id, cacheInput: true, reuseSource: phase !== 'first', reuseAnalysis: false,
      reuseLocalExposure, width: input.width, height: input.height,
      settings: { ...settings, exposure: id * 2, localExposure }, options: { ...options } };
    if (phase === 'first') message.image16 = input.data.buffer;
    await self.onmessage({ data: structuredClone(message) });
    return message;
  };
  for (const phase of ['first', 'reuse', 'reuse again']) {
    const reuse = phase !== 'first';
    const message = await post(phase, reuse ? null : strokes, reuse);
    assert.equal(received.type, 'result', received.message);
    const expected = await convertFrameWithRouter({ imageData: input, settings: { ...message.settings, localExposure: strokes },
      options: { ...options, forceFullProcess: true } });
    const plain = await convertFrameWithRouter({ imageData: input, settings: { ...message.settings, localExposure: null },
      options: { ...options, forceFullProcess: true } });
    assert.deepEqual(new Uint16Array(received.image16), expected.__image16.data, `${phase}: retained strokes are applied exactly`);
    assert.notDeepEqual(expected.__image16.data, plain.__image16.data, 'the stroke changes the fixture');
  }
  await post('clear', null, false);
  assert.equal(received.type, 'result');
  await post('stale', null, true);
  assert.equal(received.type, 'error', 'a reuse without retained strokes fails instead of converting without them');
}
{
  // The import warm-up answers without touching the cached preview source:
  // the next reuse still converts the source cached before it.
  const cached = source(11);
  const settings = { filmType: 'color', colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 }, exposure: 5 };
  const options = { preview: true, includeAnalysisPreview: false, analysisImageData: null };
  await self.onmessage({ data: { type: 'convert', id: ++id, cacheInput: true, width: 40, height: 30,
    image16: cached.data.buffer.slice(0), settings, options: { ...options } } });
  assert.equal(received.type, 'result', received.message);
  await self.onmessage({ data: { type: 'warm-up', id: ++id } });
  assert.deepEqual(received, { type: 'ready', id });
  await self.onmessage({ data: { type: 'convert', id: ++id, cacheInput: true, reuseSource: true, reuseAnalysis: false,
    width: 40, height: 30, settings, options: { ...options } } });
  assert.equal(received.type, 'result', received.message);
  const expected = await convertFrameWithRouter({ imageData: cached, settings, options: { ...options, forceFullProcess: true } });
  assert.deepEqual(new Uint16Array(received.image16), expected.__image16.data, 'warm-up keeps the cached source');
}
console.log('conversionWorker: 実ルーター・転送後の再利用・解析参照切替・全モードの 16bit 一致、操作中の 16bit 保持と確定、ウォームアップ後のキャッシュ維持を検証');

// #261: the live loupe converts in its own worker. For the same 640x360 camera
// frame and recipe, the worker's adjusted RGBA equals the main-thread path it
// replaces, in every mode; the recipe is posted once and reused.
{
  const { applyPreparedAdjustmentsToBuffer, createAdjustmentLutScratch } = await import('../app/adjustmentPipeline.js');
  const { convertAdjustedFrame } = await import('../pipeline/adjustedFrame.js');
  const LOUPE_OPTIONS = { preview: true, scratch: true, includeAnalysisPreview: false };
  // The main-thread loupe before #261 (main.js convertLoupeFrame): the router,
  // then the adjustment stage into a fresh ImageData at preview quality.
  const mainThreadLoupeFrame = async (frame, router, prepared) => {
    const converted = await convertFrameWithRouter({ imageData: frame, settings: router, options: { ...LOUPE_OPTIONS } });
    const output = new ImageData(new Uint8ClampedArray(converted.width * converted.height * 4), converted.width, converted.height);
    applyPreparedAdjustmentsToBuffer(converted, prepared, output, { quality: 'preview', lutScratch: createAdjustmentLutScratch() });
    return output;
  };
  // An orange-masked negative with a gradient, a dense patch and sensor noise.
  const cameraFrame = seed => {
    const width = 640, height = 360, data = new Uint8ClampedArray(width * height * 4);
    let noise = seed;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      noise = (noise * 1103515245 + 12345) >>> 0;
      const grain = (noise >>> 24) % 9 - 4;
      const dense = x > 120 && x < 300 && y > 80 && y < 220 ? 70 : 0;
      const i = (y * width + x) * 4;
      data[i] = 215 - x / 8 - dense + grain;
      data[i + 1] = 150 - y / 6 - dense * 0.7 + grain;
      data[i + 2] = 100 - (x + y) / 14 - dense * 0.4 + grain;
      data[i + 3] = 255;
    }
    return new ImageData(data, width, height);
  };
  const curve = gamma => Uint8Array.from({ length: 256 }, (_, i) => Math.round(255 * Math.pow(i / 255, gamma)));
  const identity = Uint8Array.from({ length: 256 }, (_, i) => i);
  const prepared = {
    exposure: 0.15, contrast: 12, highlights: -10, shadows: 8, temperature: 6, tint: -4, saturation: 15, vibrance: 10,
    cyan: 3, magenta: -2, yellow: 4, wbR: 1.03, wbG: 1, wbB: 0.96,
    curves: { r: curve(0.9), g: identity, b: curve(1.1) },
    look: { matrix: [1.02, 0.01, -0.02, 0, 0.99, 0.01, -0.01, 0.02, 1.01], offset: [1, 0, -1], curves: { r: curve(0.95), g: curve(1.02), b: identity } },
    expiredEnabled: false,
  };
  const lutScratch = createAdjustmentLutScratch();
  await self.onmessage({ data: { type: 'convert', id: ++id, reuseRecipe: true, width: 640, height: 360,
    rgba: cameraFrame(1).data.buffer, options: { ...LOUPE_OPTIONS } } });
  assert.equal(received.type, 'error', 'a reused recipe that was never posted fails');
  assert.match(received.message, /Missing loupe recipe/);
  for (const filmType of ['color', 'bw', 'positive']) {
    const router = { filmType, colorModel: 'standard', filmBase: { r: 215, g: 150, b: 100 }, exposure: 12, contrast: 8 };
    const adjust = filmType === 'bw' ? { ...prepared, look: null } : prepared;
    for (const [phase, seed] of [['recipe posted', 11], ['recipe reused', 29]]) {
      const frame = cameraFrame(seed);
      const expected = await mainThreadLoupeFrame(new ImageData(frame.data.slice(), 640, 360), router, adjust);
      const message = { type: 'convert', id: ++id, width: 640, height: 360, rgba: frame.data.buffer, options: { ...LOUPE_OPTIONS } };
      if (phase === 'recipe posted') Object.assign(message, { cacheRecipe: true, settings: router, adjust });
      else message.reuseRecipe = true;
      await self.onmessage({ data: structuredClone(message, { transfer: [message.rgba] }) });
      assert.equal(received.type, 'result', received.message);
      assert.equal(received.width, 640);
      assert.equal(received.height, 360);
      assert.ok(!('image16' in received), `${filmType}: the loupe gets the adjusted 8-bit frame only`);
      assert.deepEqual(new Uint8ClampedArray(received.rgba), expected.data, `${filmType}/${phase}: worker RGBA equals the main-thread loupe`);
      const fallback = await convertAdjustedFrame({ imageData: new ImageData(cameraFrame(seed).data, 640, 360), settings: router, adjust, options: { ...LOUPE_OPTIONS }, lutScratch });
      assert.deepEqual(fallback.data, expected.data, `${filmType}/${phase}: the main-thread fallback gives the same RGBA`);
    }
    const plain = await mainThreadLoupeFrame(cameraFrame(11), router, { ...adjust, curves: { r: identity, g: identity, b: identity }, look: null, exposure: 0, contrast: 0, saturation: 0 });
    const adjusted = await mainThreadLoupeFrame(cameraFrame(11), router, adjust);
    assert.notDeepEqual(plain.data, adjusted.data, `${filmType}: the recipe's adjustments change the fixture`);
  }
  console.log('conversionWorker: live-loupe frames match the main-thread path byte for byte (color, B&W, positive), recipe posted once');
}

