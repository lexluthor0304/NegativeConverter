import assert from 'node:assert/strict';
// #248 parts 3 and 4 in the conversion worker: display targets resampled from
// a cached level, the viewport-independent auto-WB sample, the display preview
// a full-resolution render brings along, and the uncached display resample.
globalThis.ImageData = class {
  constructor(dataOrWidth, width, height) {
    if (typeof dataOrWidth === 'number') Object.assign(this, { width: dataOrWidth, height: width, data: new Uint8ClampedArray(dataOrWidth * width * 4) });
    else Object.assign(this, { data: dataOrWidth, width, height });
  }
};
let received;
globalThis.self = { postMessage: (payload, transfers = []) => { received = structuredClone(payload, { transfer: transfers }); } };
await import('./conversionWorker.js');
const { convertFrameWithRouter } = await import('../pipeline/conversionRouter.js');
const {
  buildDisplayLevel, displayLevelGeometry, resampleDisplayLevel, filterDisplayImage, displayLevelFactor
} = await import('../app/displayPreview.js');
const { downsampleImageDataForMaxPixels } = await import('../app/imageDataOps.js');

function source(width, height, seed) {
  const data = new Uint16Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const p = i / 4;
    data.set([5000 + ((p * seed) % 45000), 3000 + ((p * seed * 3) % 31000), 1000 + ((p * seed * 7) % 23000), 65535], i);
  }
  return { width, height, data };
}
const asImageData = (plane) => {
  const image = new ImageData(plane.width, plane.height);
  for (let i = 0; i < plane.data.length; i++) image.data[i] = plane.data[i] >>> 8;
  image.__image16 = plane;
  return image;
};
let id = 0;
const send = async (message) => {
  await self.onmessage({ data: structuredClone(message) });
  assert.notEqual(received.type, 'error', received.message);
  return received;
};
const sameBytes = (a, b, label) => assert.ok(Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0, label);

const settings = { filmType: 'color', colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 }, exposure: 12 };
const options = { preview: true, includeAnalysisPreview: false };

// ---- Part 3: a display target converts the level's resample; a new size sends no pixels ----
for (const k of [1, 3]) {
  const base = source(96, 66, 37 + k);
  const level = k === 1 ? base : buildDisplayLevel(asImageData(base), k).__image16;
  const geometry = k === 1 ? { sourceWidth: 96, sourceHeight: 66, k: 1 } : displayLevelGeometry(buildDisplayLevel(asImageData(base), k));
  assert.equal(geometry.k, k);
  for (const [index, target] of [{ width: 40, height: 27 }, { width: 25, height: 17 }, { width: 40, height: 27 }].entries()) {
    const message = { type: 'convert', id: ++id, cacheInput: true, reuseSource: index > 0, reuseAnalysis: index > 0,
      width: level.width, height: level.height, settings, options: { ...options }, display: { target, geometry } };
    if (index === 0) message.image16 = level.data.buffer.slice(0);
    const reply = await send(message);
    assert.equal(reply.type, 'result');
    assert.deepEqual([reply.width, reply.height], [target.width, target.height], `k ${k}: converted at the display size`);
    const negative = resampleDisplayLevel(level, geometry, target);
    const expected = await convertFrameWithRouter({ imageData: negative, settings, options: { ...options, forceFullProcess: true } });
    sameBytes(new Uint16Array(reply.image16), expected.__image16.data, `k ${k}: the worker converts the level's resample (${target.width})`);
    sameBytes(new Uint8ClampedArray(reply.rgba), expected.data, `k ${k}: 8-bit plane`);
  }

  // prepare/analyze of a display target: without film-base compensation the
  // prepared plane is the display negative itself, sent as a copy.
  const target = { width: 40, height: 27 };
  const plain = { filmType: 'color', colorModel: 'standard' };
  const prepared = await send({ type: 'prepare', id: ++id, cacheInput: true, reuseSource: true, reuseAnalysis: true,
    width: level.width, height: level.height, settings: plain, options: { preview: true, histogramSamples: 100 }, display: { target, geometry } });
  assert.equal(prepared.type, 'prepared');
  sameBytes(new Uint16Array(prepared.pristine), resampleDisplayLevel(level, geometry, target).data, `k ${k}: the display negative is the prepared plane`);

  // The display negative for main's repaired preview: both planes, as
  // resizeDisplayPreview makes the 8-bit one from 16 bits.
  const copy = await send({ type: 'displayNegative', id: ++id, cacheInput: true, reuseSource: true, reuseAnalysis: true,
    width: level.width, height: level.height, settings, options: { preview: true }, display: { target, geometry } });
  const negative = resampleDisplayLevel(level, geometry, target);
  sameBytes(new Uint16Array(copy.image16), negative.data, `k ${k}: display negative copy`);
  sameBytes(new Uint8ClampedArray(copy.rgba), Uint8ClampedArray.from(negative.data, v => Math.round(v / 257)), `k ${k}: its 8-bit plane`);
}

// ---- Part 3: the auto-WB sample depends on the source and the settings only ----
{
  const base = source(1300, 900, 11);
  const wbTarget = { width: 1024, height: Math.floor(900 * 1024 / 1300) };
  const geometry = { sourceWidth: 1300, sourceHeight: 900, k: displayLevelFactor(1300, 900) };
  assert.equal(geometry.k, 1);
  const expectedSample = await convertFrameWithRouter({ imageData: resampleDisplayLevel(base, geometry, wbTarget), settings,
    options: { preview: false, scratch: true, forceFullProcess: true, includeAnalysisPreview: false } });
  const samples = [];
  // Two display sizes (two windows / DPRs) through the preview worker.
  for (const [index, target] of [{ width: 600, height: 415 }, { width: 900, height: 623 }].entries()) {
    const message = { type: 'convert', id: ++id, cacheInput: true, reuseSource: false, reuseAnalysis: false,
      width: 1300, height: 900, settings, options: { ...options }, display: { target, geometry }, wbSample: { geometry }, image16: base.data.buffer.slice(0) };
    if (index) message.image16 = base.data.buffer.slice(0);
    const reply = await send(message);
    samples.push(new Uint8ClampedArray(reply.wbSample.rgba));
    assert.deepEqual([reply.wbSample.width, reply.wbSample.height], [wbTarget.width, wbTarget.height]);
  }
  // A window where the whole source fits: the full-resolution client builds
  // the same sample from the frame itself.
  const full = await send({ type: 'convert', id: ++id, width: 1300, height: 900, settings,
    options: { preview: false, forceFullProcess: true, includeAnalysisPreview: false },
    wbSample: { fromSource: true, geometry: { sourceWidth: 1300, sourceHeight: 900, k: 1 } }, image16: base.data.buffer.slice(0) });
  samples.push(new Uint8ClampedArray(full.wbSample.rgba));
  for (const sample of samples) sameBytes(sample, expectedSample.data, 'the same auto-WB sample at every viewport and on both paths');

  // A 60 MP-shaped geometry uses the level's own box: a k 3 level of a
  // smaller frame behaves the same through both paths.
  const big = source(390, 270, 5);
  const bigImage = asImageData(big);
  const level = buildDisplayLevel(bigImage, 3);
  const levelGeometry = displayLevelGeometry(level);
  const small = { width: Math.floor(390 * Math.min(1, 1024 / 390)), height: Math.floor(270 * Math.min(1, 1024 / 390)) };
  const preview = await send({ type: 'convert', id: ++id, cacheInput: true, reuseSource: false, reuseAnalysis: false,
    width: level.width, height: level.height, settings, options: { ...options }, image16: level.__image16.data.buffer.slice(0),
    display: { target: { width: 100, height: 69 }, geometry: levelGeometry }, wbSample: { geometry: levelGeometry } });
  const expectedBig = await convertFrameWithRouter({ imageData: resampleDisplayLevel(level, levelGeometry, small), settings,
    options: { preview: false, scratch: true, forceFullProcess: true, includeAnalysisPreview: false } });
  sameBytes(new Uint8ClampedArray(preview.wbSample.rgba), expectedBig.data, 'k 3: the sample comes from the level');
}

// ---- Part 4: a full-resolution render brings its display preview ----
{
  const base = source(300, 200, 23);
  const target = { width: 120, height: 80 };
  const reply = await send({ type: 'convert', id: ++id, width: 300, height: 200, settings,
    options: { preview: false, forceFullProcess: true, includeAnalysisPreview: false, displayTarget: target, histogramSamples: 500 },
    image16: base.data.buffer.slice(0) });
  const result = new ImageData(new Uint8ClampedArray(reply.rgba), 300, 200);
  result.__image16 = { width: 300, height: 200, data: new Uint16Array(reply.image16) };
  const expected = filterDisplayImage(result, target);
  const built = reply.displayPreview;
  assert.deepEqual([built.width, built.height], [120, 80]);
  sameBytes(new Uint16Array(built.image16), expected.__image16.data, 'the display preview equals the main-thread filter of the same result (16-bit)');
  sameBytes(new Uint8ClampedArray(built.rgba), expected.data, '8-bit plane');
  const sample = downsampleImageDataForMaxPixels(expected, 500);
  sameBytes(new Uint8ClampedArray(built.histogram.rgba), sample.data, 'and the histogram sample main would take of it');
  // The full-resolution pixels are unchanged by it.
  const plain = await convertFrameWithRouter({ imageData: base, settings, options: { preview: false, forceFullProcess: true, includeAnalysisPreview: false } });
  sameBytes(new Uint16Array(reply.image16), plain.__image16.data, 'export pixels untouched');
  // A result that already fits brings nothing.
  const small = await send({ type: 'convert', id: ++id, width: 300, height: 200, settings,
    options: { preview: false, forceFullProcess: true, includeAnalysisPreview: false, displayTarget: { width: 300, height: 200 } },
    image16: base.data.buffer.slice(0) });
  assert.equal(small.displayPreview, undefined);
}

// ---- Part 4: the uncached display resample keeps the cached level ----
{
  const base = source(64, 48, 9);
  const geometry = { sourceWidth: 64, sourceHeight: 48, k: 1 };
  const target = { width: 30, height: 22 };
  await send({ type: 'convert', id: ++id, cacheInput: true, reuseSource: false, reuseAnalysis: false, width: 64, height: 48,
    settings, options: { ...options }, display: { target, geometry }, image16: base.data.buffer.slice(0) });
  const frame = source(200, 150, 3);
  const reply = await send({ type: 'resample', id: ++id, width: 200, height: 150, image16: frame.data.buffer.slice(0), target: { width: 70, height: 52 } });
  assert.equal(reply.type, 'resampled');
  const image = { width: 200, height: 150, data: null, __image16: frame };
  const expected = filterDisplayImage(image, { width: 70, height: 52 });
  sameBytes(new Uint16Array(reply.image16), expected.__image16.data, 'the resample is the display filter');
  sameBytes(new Uint8ClampedArray(reply.rgba), expected.data);
  // The next preview tick still reuses the cached level.
  const again = await send({ type: 'convert', id: ++id, cacheInput: true, reuseSource: true, reuseAnalysis: true, width: 64, height: 48,
    settings, options: { preview: true, includeAnalysisPreview: false }, display: { target, geometry } });
  assert.equal(again.type, 'result', 'the cached level survives the resample');
}

console.log('conversionWorker.display: display targets from a cached level, prepared/negative copies, a viewport-independent auto-WB sample, prebuilt display previews and the uncached resample');
