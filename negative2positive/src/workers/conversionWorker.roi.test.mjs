import assert from 'node:assert/strict';
// #248 part 5: a detail region converted in the worker meets its base without
// a seam and, with an analysis sample, equals the same region of the export
// conversion byte for byte: with and without analysisImageData, with dodge and
// burn strokes, with a flat field, in positive mode, at an image edge.
globalThis.ImageData = class {
  constructor(dataOrWidth, width, height) {
    if (typeof dataOrWidth === 'number') Object.assign(this, { width: dataOrWidth, height: width, data: new Uint8ClampedArray(dataOrWidth * width * 4) });
    else Object.assign(this, { data: dataOrWidth, width, height });
  }
};
let received;
globalThis.self = { postMessage: (payload, transfers = []) => { received = structuredClone(payload, { transfer: transfers }); } };
await import('./conversionWorker.js');
const { convertFrameWithRouter, resolveConversionMode } = await import('../pipeline/conversionRouter.js');
const { analyzeSilverCorePreview, invalidateSilverCoreCache } = await import('../pipeline/silverAdapter.js');
const { resampleDisplayLevel } = await import('../app/displayPreview.js');
const { copyRegionRows, planDetailRegion, detailRegionServes, detailSlotSize, snapPanToDevicePixels, planDetailBands } = await import('../app/detailLayer.js');

const W = 160, H = 120;
function source(seed) {
  const data = new Uint16Array(W * H * 4);
  for (let i = 0; i < data.length; i += 4) {
    const p = i / 4, x = p % W, y = Math.floor(p / W);
    data.set([4000 + ((x * 311 + y * 97 + seed * 13) % 50000), 3000 + ((x * 173 + y * 211 + seed) % 40000),
      2000 + ((x * 59 + y * 389) % 30000), 65535], i);
  }
  return { width: W, height: H, data };
}
const frameGeometry = { baseWidth: W, baseHeight: H, rotationAngle: 0, mirrored: false, rotatedWidth: W, rotatedHeight: H, cropRegion: null };
const strokes = { strokes: [{ stops: 1.2, size: 0.3, feather: 0.6, points: [{ x: 0.25, y: 0.3, p: 1 }, { x: 0.55, y: 0.45, p: 1 }] },
  { stops: -0.8, size: 0.2, feather: 0.3, points: [{ x: 0.4, y: 0.6, p: 0.7 }] }] };
const flatGains = new Float32Array(5 * 4 * 3);
for (let i = 0; i < flatGains.length; i++) flatGains[i] = 0.8 + ((i * 37) % 11) / 20;
const flatField = { id: 'pad', width: 5, height: 4, gains: flatGains, stats: {} };

let id = 0;
async function send(message, transfers) {
  await self.onmessage({ data: structuredClone(message, transfers ? { transfer: transfers } : undefined) });
  return received;
}

const target = { width: 80, height: 60 };
const geometry = { sourceWidth: W, sourceHeight: H, k: 1 };
const cases = [];
for (const filmType of ['color', 'bw', 'positive']) {
  for (const withReference of [true, false]) {
    for (const extras of ['plain', 'strokes', 'flat']) cases.push({ filmType, withReference, extras });
  }
}
const rects = [{ x: 30, y: 20, width: 50, height: 40 }, { x: 118, y: 90, width: 42, height: 30 }];
let checked = 0;
for (const { filmType, withReference, extras } of cases) {
  invalidateSilverCoreCache();
  const base = source(filmType.length);
  const reference = withReference ? source(3) : null;
  const settings = { filmType, colorModel: 'standard', exposure: 14, contrast: 9, preSaturation: 110 };
  if (filmType === 'color') settings.filmBase = { r: 210, g: 140, b: 90 };
  if (extras === 'strokes') Object.assign(settings, { localExposure: strokes, localExposureGeometry: frameGeometry });
  if (extras === 'flat') Object.assign(settings, { flatField, flatFieldGeometry: frameGeometry });
  // The base: the preview worker converts the display target of the level.
  const baseMessage = { type: 'convert', id: ++id, cacheInput: true, reuseSource: false, reuseAnalysis: false, width: W, height: H,
    settings, options: { preview: true, includeAnalysisPreview: false, analysisImageData: reference }, display: { target, geometry },
    image16: base.data.buffer.slice(0) };
  const baseReply = await send(baseMessage);
  assert.equal(baseReply.type, 'result', baseReply.message);
  // The analysis the base used, as the worker's preview slot computes it.
  const negative = resampleDisplayLevel(base, geometry, target);
  const mode = resolveConversionMode(settings);
  for (const rect of rects) {
    const region = { ...rect, frameWidth: W, frameHeight: H, outWidth: rect.width, outHeight: rect.height,
      fromLevel: false, levelFactor: 1, slotWidth: 64, slotHeight: 64 };
    const rows = copyRegionRows(base.data, W, rect);
    const reply = await send({ type: 'roi', id: ++id, settings, region, base: { levelWidth: W, levelHeight: H, display: { target, geometry } },
      image16: rows.buffer }, [rows.buffer]);
    assert.equal(reply.type, 'roi', reply.message);
    const label = `${filmType}/${withReference ? 'sample' : 'no sample'}/${extras}/${rect.x}`;
    let expected;
    if (withReference) {
      // The export conversion itself (analysed from the sample), cropped.
      expected = await convertFrameWithRouter({ imageData: base, settings,
        options: { preview: false, forceFullProcess: true, includeAnalysisPreview: false, analysisImageData: reference } });
    } else {
      // The whole frame with the base's analysis, cropped: the region equals
      // it, so it meets the base without a seam.
      invalidateSilverCoreCache();
      const analysis = await analyzeSilverCorePreview(negative, settings, mode, { preview: true, analysisImageData: null });
      expected = await convertFrameWithRouter({ imageData: base, settings,
        options: { preview: false, forceFullProcess: true, includeAnalysisPreview: false,
          sharedAnalysis: { channelData: analysis.channelData, positiveAnalysis: analysis.positiveAnalysis } } });
      // Put the worker's cache back for the next region.
      await send({ ...baseMessage, id: ++id, image16: base.data.buffer.slice(0) });
    }
    const crop = copyRegionRows(expected.data, W, rect);
    assert.deepEqual([reply.width, reply.height], [rect.width, rect.height]);
    assert.ok(Buffer.compare(Buffer.from(new Uint8Array(reply.rgba)), Buffer.from(crop.buffer)) === 0, `${label}: the region equals the frame's pixels`);
    checked++;
  }
}
assert.equal(checked, cases.length * rects.length);

// Below full density the region is decimated and converted with the same
// analysis; the level path crops the cached level instead of native rows.
{
  invalidateSilverCoreCache();
  const base = source(9);
  const settings = { filmType: 'color', colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 } };
  await send({ type: 'convert', id: ++id, cacheInput: true, reuseSource: false, reuseAnalysis: false, width: W, height: H,
    settings, options: { preview: true, includeAnalysisPreview: false }, display: { target, geometry }, image16: base.data.buffer.slice(0) });
  const rect = { x: 20, y: 10, width: 100, height: 80 };
  const rows = copyRegionRows(base.data, W, rect);
  const reply = await send({ type: 'roi', id: ++id, settings, base: { levelWidth: W, levelHeight: H, display: { target, geometry } },
    region: { ...rect, frameWidth: W, frameHeight: H, outWidth: 45, outHeight: 36, fromLevel: false, levelFactor: 1, slotWidth: 64, slotHeight: 64 },
    image16: rows.buffer }, [rows.buffer]);
  assert.equal(reply.type, 'roi', reply.message);
  assert.deepEqual([reply.width, reply.height], [45, 36]);
  // A missing base (the worker holds another source) is an error, not a guess.
  const stale = await send({ type: 'roi', id: ++id, settings, base: { levelWidth: 10, levelHeight: 10, display: null },
    region: { ...rect, frameWidth: W, frameHeight: H, outWidth: 100, outHeight: 80, fromLevel: false, levelFactor: 1, slotWidth: 128, slotHeight: 128 },
    image16: copyRegionRows(base.data, W, rect).buffer });
  assert.equal(stale.type, 'error');
  // Warm-up converts a small patterned plane at idle and answers.
  const warm = await send({ type: 'roi', id: ++id, settings, warm: true, region: { slotWidth: 64, slotHeight: 64 } });
  assert.equal(warm.warm, true);
}

// ---- Planning ----
{
  // 60 MP at DPR 2 in a 1110 x 700 CSS canvas: the base (4 MP cap) is soft
  // from about 1.25x fit; at true 100 % the region is native.
  const view = { sourceWidth: 9536, sourceHeight: 6336, baseWidth: 1809, fit: 1090 / 9536, dpr: 2, panX: 0, panY: 0,
    baseX: 10, baseY: (700 - 6336 * 1090 / 9536) / 2, containerWidth: 1110, containerHeight: 700, levelFactor: 3, zoom: 1 };
  assert.equal(planDetailRegion(view), null, 'at fit the base is enough');
  const zoom100 = 1 / (view.fit * 2);
  const plan = planDetailRegion({ ...view, zoom: zoom100, panX: -(zoom100 - 1) * 545, panY: -(zoom100 - 1) * 362 });
  assert.equal(plan.density, 1);
  assert.equal(plan.fromLevel, false);
  assert.equal(plan.outWidth, plan.width, 'one output pixel per source pixel');
  assert.ok(plan.width <= 1110 * 2 + 2 * 128 + 2 && plan.height <= 700 * 2 + 2 * 128 + 2, 'the visible rect plus the margin');
  const slot = detailSlotSize(1110, 700, 2);
  assert.ok(slot.width >= plan.outWidth && slot.height >= plan.outHeight && slot.width % 256 === 0);
  // Moderate zoom on 60 MP (1.5x fit, 0.34 device px per source px): the
  // level (k 3) holds the detail, no native rows.
  const lowPlan = planDetailRegion({ ...view, zoom: 1.5 });
  assert.ok(lowPlan && lowPlan.fromLevel && lowPlan.x % 3 === 0 && lowPlan.width % 3 === 0, 'from the level, on its grid');
  // Between the level's density and half density, prefer full coverage from
  // the level over a native cut that cannot fill the view.
  const midPlan = planDetailRegion({ ...view, zoom: 2 });
  assert.ok(midPlan && midPlan.fromLevel && midPlan.density < 0.5);
  assert.ok(detailRegionServes(midPlan, midPlan), 'the oversized plan serves its entire view');
  // A pan inside the margin keeps the region; out of it asks for a new one.
  assert.equal(detailRegionServes(plan, planDetailRegion({ ...view, zoom: zoom100, panX: -(zoom100 - 1) * 545 + 30, panY: -(zoom100 - 1) * 362 })), true);
  assert.equal(detailRegionServes(plan, planDetailRegion({ ...view, zoom: zoom100, panX: -(zoom100 - 1) * 545 + 400, panY: -(zoom100 - 1) * 362 })), false);
  // The pan snaps the region's corner to a whole device pixel, by at most half of one.
  const snapped = snapPanToDevicePixels(-123.37, 10, zoom100, plan.x * view.fit, 2);
  const device = (10 + snapped + zoom100 * plan.x * view.fit) * 2;
  assert.ok(Math.abs(device - Math.round(device)) < 1e-6 && Math.abs(snapped + 123.37) <= 0.25 + 1e-9);
}

console.log('conversionWorker.roi: detail regions equal the frame (sample) or meet the base (no sample) byte for byte with strokes, flat field, positive and edges; planning, slot and pan snap');

// #270: a region converted in row bands, each from its own rows and with the
// base's analysis as main passes it, equals the whole region byte for byte:
// native rows at full density, a bilinear and a box + resample reduction of
// native rows, and level blocks; colour with strokes and a flat field, B&W and
// positive; with and without an analysis sample; 2 to 5 bands.
{
  const { resampleDisplayLevel: resample, buildDisplayLevel } = await import('../app/displayPreview.js');
  const k = 2;
  const cases = [];
  for (const filmType of ['color', 'bw', 'positive']) {
    for (const withReference of [false, true]) cases.push({ filmType, withReference });
  }
  let bandsChecked = 0;
  for (const { filmType, withReference } of cases) {
    invalidateSilverCoreCache();
    const base = source(filmType.length + 5);
    const reference = withReference ? source(11) : null;
    const settings = { filmType, colorModel: 'standard', exposure: 9, contrast: 12, preSaturation: 104,
      localExposure: strokes, localExposureGeometry: frameGeometry, flatField, flatFieldGeometry: frameGeometry };
    if (filmType === 'color') settings.filmBase = { r: 205, g: 150, b: 95 };
    // Two caches: the source itself (k 1), and a level of it (k 2).
    const level = buildDisplayLevel({ width: W, height: H, __image16: { width: W, height: H, data: base.data } }, k);
    const levelPlane = level.__image16;
    for (const cached of ['source', 'level']) {
      const geometry = cached === 'level' ? { sourceWidth: W, sourceHeight: H, k } : { sourceWidth: W, sourceHeight: H, k: 1 };
      const held = cached === 'level' ? levelPlane : base;
      const display = { target, geometry };
      const baseMessage = { type: 'convert', id: ++id, cacheInput: true, reuseSource: false, reuseAnalysis: false, width: held.width, height: held.height,
        settings, options: { preview: true, includeAnalysisPreview: false, analysisImageData: reference }, display, image16: held.data.buffer.slice(0) };
      assert.equal((await send(baseMessage)).type, 'result');
      // Main's analysis request: the preview worker answers with the base's.
      const analyzed = await send({ ...baseMessage, type: 'analyze', id: ++id, reuseSource: true, reuseAnalysis: true, image16: undefined,
        options: { preview: true, analysisImageData: null } });
      assert.equal(analyzed.type, 'analyzed', analyzed.message);
      const analysis = { channelData: analyzed.channelData, positiveAnalysis: analyzed.positiveAnalysis };
      const regions = cached === 'level'
        ? [{ x: 20, y: 10, width: 120, height: 96, outWidth: 70, outHeight: 57, fromLevel: true, levelFactor: k },
          { x: 0, y: 24, width: 160, height: 96, outWidth: 101, outHeight: 61, fromLevel: true, levelFactor: k }]
        : [{ x: 30, y: 20, width: 50, height: 40, outWidth: 50, outHeight: 40, fromLevel: false, levelFactor: 1 },
          { x: 13, y: 7, width: 101, height: 83, outWidth: 71, outHeight: 58, fromLevel: false, levelFactor: 1 },
          { x: 2, y: 9, width: 150, height: 104, outWidth: 47, outHeight: 33, fromLevel: false, levelFactor: 1 }];
      for (const rect of regions) {
        const region = { ...rect, frameWidth: W, frameHeight: H, slotWidth: 256, slotHeight: 256 };
        const whole = await send({ type: 'roi', id: ++id, settings, region, base: { levelWidth: held.width, levelHeight: held.height, display },
          image16: region.fromLevel ? undefined : copyRegionRows(base.data, W, region).buffer });
        assert.equal(whole.type, 'roi', whole.message);
        const expected = Buffer.from(new Uint8Array(whole.rgba));
        for (const count of [2, 3, 5]) {
          const bands = planDetailBands(region, count, { minRows: 1 });
          assert.equal(bands.length, count);
          const out = new Uint8Array(region.outWidth * region.outHeight * 4);
          for (const band of bands) {
            const rows = band.input === 'level'
              ? copyRegionRows(levelPlane.data, levelPlane.width, { x: region.x / k, y: region.y / k + band.rowY, width: region.width / k, height: band.rows })
              : copyRegionRows(base.data, W, { x: region.x, y: region.y + band.rowY, width: region.width, height: band.rows });
            const reply = await send({ type: 'roi', id: ++id, settings, region, band, analysis, image16: rows.buffer }, [rows.buffer]);
            assert.equal(reply.type, 'roi', reply.message);
            assert.deepEqual([reply.width, reply.height], [region.outWidth, band.y1 - band.y0]);
            out.set(new Uint8Array(reply.rgba), band.y0 * region.outWidth * 4);
          }
          const label = `${filmType}/${withReference ? 'sample' : 'no sample'}/${cached}/${rect.width}x${rect.height}->${rect.outWidth}x${rect.outHeight}/${count} bands`;
          assert.ok(Buffer.compare(Buffer.from(out), expected) === 0, `${label}: the bands equal the whole region`);
          bandsChecked++;
        }
      }
    }
  }
  assert.equal(bandsChecked, cases.length * 5 * 3);
  // An 8-bit source (a JPEG or PNG): bands of 8-bit native rows.
  {
    invalidateSilverCoreCache();
    const eight = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < eight.length; i += 4) {
      const p = i / 4, x = p % W, y = Math.floor(p / W);
      eight.set([60 + ((x * 7 + y * 3) % 180), 50 + ((x * 3 + y * 5) % 160), 40 + ((x + y * 11) % 140), 255], i);
    }
    const settings = { filmType: 'color', colorModel: 'standard', exposure: 6, filmBase: { r: 205, g: 150, b: 95 },
      localExposure: strokes, localExposureGeometry: frameGeometry };
    const display = { target, geometry: { sourceWidth: W, sourceHeight: H, k: 1 } };
    const baseMessage = { type: 'convert', id: ++id, cacheInput: true, reuseSource: false, reuseAnalysis: false, width: W, height: H,
      settings, options: { preview: true, includeAnalysisPreview: false }, display, rgba: eight.buffer.slice(0) };
    assert.equal((await send(baseMessage)).type, 'result');
    const analyzed = await send({ ...baseMessage, type: 'analyze', id: ++id, reuseSource: true, reuseAnalysis: true, rgba: undefined,
      options: { preview: true, analysisImageData: null } });
    const analysis = { channelData: analyzed.channelData, positiveAnalysis: analyzed.positiveAnalysis };
    for (const rect of [{ x: 30, y: 20, width: 50, height: 40, outWidth: 50, outHeight: 40 }, { x: 2, y: 9, width: 150, height: 104, outWidth: 47, outHeight: 33 }]) {
      const region = { ...rect, fromLevel: false, levelFactor: 1, frameWidth: W, frameHeight: H, slotWidth: 256, slotHeight: 256 };
      const whole = await send({ type: 'roi', id: ++id, settings, region, base: { levelWidth: W, levelHeight: H, display },
        rgba: copyRegionRows(eight, W, region).buffer });
      assert.equal(whole.type, 'roi', whole.message);
      const out = new Uint8Array(region.outWidth * region.outHeight * 4);
      for (const band of planDetailBands(region, 3, { minRows: 1 })) {
        const rows = copyRegionRows(eight, W, { x: region.x, y: region.y + band.rowY, width: region.width, height: band.rows });
        const reply = await send({ type: 'roi', id: ++id, settings, region, band, analysis, rgba: rows.buffer }, [rows.buffer]);
        assert.equal(reply.type, 'roi', reply.message);
        out.set(new Uint8Array(reply.rgba), band.y0 * region.outWidth * 4);
      }
      assert.ok(Buffer.compare(Buffer.from(out), Buffer.from(new Uint8Array(whole.rgba))) === 0, `8-bit ${rect.width}x${rect.height}: bands equal the whole region`);
      bandsChecked++;
    }
  }
  // A band without its rows or the analysis is an error, not a guess.
  const region = { x: 0, y: 0, width: 50, height: 40, outWidth: 50, outHeight: 40, fromLevel: false, levelFactor: 1, frameWidth: W, frameHeight: H, slotWidth: 64, slotHeight: 64 };
  const missing = await send({ type: 'roi', id: ++id, settings: { filmType: 'color' }, region, band: { y0: 0, y1: 20, rowY: 0, rows: 20, input: 'native' },
    image16: new Uint16Array(50 * 20 * 4).buffer });
  assert.equal(missing.type, 'error');
  console.log(`conversionWorker.roi: ${bandsChecked} banded regions equal the whole region byte for byte`);
}

// Cancelled queued work must release its rows and never run behind a newer
// conversion. No timer or large fixture is needed to hold the serial queue.
{
  const before = received;
  const cancelledId = ++id;
  const pending = self.onmessage({ data: { type: 'roi', id: cancelledId, settings: {}, region: {}, image16: new ArrayBuffer(64) } });
  self.onmessage({ data: { type: 'cancel', id: cancelledId } });
  await pending;
  assert.equal(received, before, 'a cancelled queued ROI emits no result/error');
}
