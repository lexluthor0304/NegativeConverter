// Standalone Node test: the geometry core (#244) must reproduce HEAD's
// rotate -> mirror -> crop bit for bit, whole or in row bands built from
// source slices only (as the worker pool runs it). Run with:
// node negative2positive/src/app/imageGeometry.chain.test.mjs
import assert from 'node:assert/strict';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const {
  applyRotationToImageData, mirrorImageDataHorizontal, rotateImageDataRightAngle, applyGeometryChainToImageData,
  planGeometry, planGeometryBands, sliceGeometrySource, renderGeometryRows, renderGeometry, geometrySourceRect,
  wrapGeometryOutput, sanitizeCropRect, normalizeAngleDegrees
} = await import('./imageGeometry.js');
const { cropImageDataRegion, downsampleImageDataByStep } = await import('./imageDataOps.js');
const head = await import('./imageGeometry.reference.mjs');

const headSteps = {
  rotate: head.headApplyRotationToImageData,
  mirror: head.headMirrorImageDataHorizontal,
  crop: (image, cropRegion, bounds = image) => {
    const rect = sanitizeCropRect(cropRegion, bounds);
    if (!image) return rect;
    return rect ? head.headCropImageDataRegion(image, rect) : image;
  }
};
const steps = {
  rotate: applyRotationToImageData,
  mirror: mirrorImageDataHorizontal,
  crop: (image, cropRegion, bounds = image) => {
    const rect = sanitizeCropRect(cropRegion, bounds);
    if (!image) return rect;
    return rect ? cropImageDataRegion(image, rect) : image;
  }
};

// Deterministic pseudo-random 16-bit source with its >>> 8 view. Some pixels
// are all 0xFFFF: as a float64 that bit pattern is a NaN.
function makeSource(width, height, { seed = 7, eightBitOnly = false } = {}) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; };
  const data16 = new Uint16Array(width * height * 4);
  const data8 = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data16.length; i += 4) {
    const white = rnd() % 17 === 0;
    for (let c = 0; c < 3; c++) { data16[i + c] = white ? 65535 : rnd() % 65536; data8[i + c] = data16[i + c] >>> 8; }
    // Some translucent pixels: crops make the 8-bit copy opaque, never the 16-bit one.
    const alpha = rnd() % 5 === 0 ? rnd() % 65536 : 65535;
    data16[i + 3] = alpha; data8[i + 3] = alpha >>> 8;
  }
  const image = new ImageData(data8, width, height);
  if (!eightBitOnly) image.__image16 = { width, height, data: data16 };
  return image;
}

function bytesOf(array) { return Buffer.from(array.buffer, array.byteOffset, array.byteLength); }
function assertSame(actual, expected, label) {
  assert.equal(actual.width, expected.width, `${label}: width`);
  assert.equal(actual.height, expected.height, `${label}: height`);
  assert.ok(bytesOf(actual.data).equals(bytesOf(expected.data)), `${label}: 8-bit pixels`);
  assert.equal(Boolean(actual.__image16), Boolean(expected.__image16), `${label}: 16-bit plane present`);
  if (expected.__image16) {
    assert.deepEqual([actual.__image16.width, actual.__image16.height], [expected.__image16.width, expected.__image16.height], `${label}: 16-bit size`);
    assert.ok(bytesOf(actual.__image16.data).equals(bytesOf(expected.__image16.data)), `${label}: 16-bit pixels`);
  }
}

// HEAD's step chain with the restore threshold (angles up to 0.001° ignored).
function headStepChain(image, geometry) {
  let working = image;
  const angle = normalizeAngleDegrees(Number(geometry.rotationAngle) || 0);
  if (Math.abs(angle) > 0.001) working = head.headApplyRotationToImageData(working, angle);
  if (geometry.mirrored) working = head.headMirrorImageDataHorizontal(working);
  if (geometry.cropRegion) working = headSteps.crop(working, geometry.cropRegion);
  return working;
}

// Bands built only from their source slices, the way pool workers see them.
function renderBanded(source, plan, count) {
  if (plan.identity) return source;
  const out8 = new Uint8ClampedArray(plan.outWidth * plan.outHeight * 4);
  const out16 = plan.has16 ? new Uint16Array(out8.length) : null;
  for (const band of planGeometryBands(plan, count)) {
    const slice = sliceGeometrySource(source, plan, band.rect);
    if (plan.kind === 'bilinear') assert.equal(slice.data8, null, 'bilinear bands post the 16-bit plane only');
    const rows = band.y1 - band.y0;
    const part8 = new Uint8ClampedArray(rows * plan.outWidth * 4);
    const part16 = out16 ? new Uint16Array(part8.length) : null;
    renderGeometryRows(plan, slice, { data8: part8, data16: part16 }, band.y0, band.y1);
    out8.set(part8, band.y0 * plan.outWidth * 4);
    if (out16) out16.set(part16, band.y0 * plan.outWidth * 4);
  }
  return wrapGeometryOutput(plan, out8, out16);
}

const angles = [0, 0.001, 0.3, -0.3, 1.3, -1.3, 7.9, -44.5, 89.9995, 90, -90, 180, -179.9995, 37, -123.4];
const crops = [null, { left: 3, top: 2, width: 20, height: 13 }, { left: 0, top: 0, width: 9999, height: 9999 }, { left: 'x', top: 0, width: 5, height: 5 }];
let cases = 0;
for (const [width, height] of [[37, 23], [23, 37]]) {
  const source = makeSource(width, height, { seed: width * 31 + height });
  for (const rotationAngle of angles) {
    for (const mirrored of [false, true]) {
      for (const cropRegion of crops) {
        const geometry = { rotationAngle, mirrored, cropRegion };
        const label = `${width}x${height} ${JSON.stringify(geometry)}`;
        const expected = headStepChain(source, geometry);
        // HEAD's own one-pass chain agreed with the steps; so must the core.
        assertSame(head.headApplyGeometryChainToImageData(source, geometry, headSteps), expected, `HEAD chain ${label}`);
        const chained = applyGeometryChainToImageData(source, geometry, steps);
        assertSame(chained, expected, `chain ${label}`);
        const plan = planGeometry(source, geometry);
        assert.ok(plan, `planned ${label}`);
        if (plan.identity) assert.equal(chained, source, 'no geometry returns the source object');
        for (let bands = 1; bands <= 6; bands++) assertSame(renderBanded(source, plan, bands), expected, `${bands} bands ${label}`);
        cases++;
      }
    }
  }
}
assert.ok(cases >= 240);

// Every single-step export equals HEAD's, and applyRotationToImageData keeps
// rotating from exactly 0.001°.
{
  const source = makeSource(29, 17, { seed: 99 });
  for (const angle of [...angles, 0.0009, 360, -270, 725.5]) {
    const actual = applyRotationToImageData(source, angle);
    const expected = head.headApplyRotationToImageData(source, angle);
    assertSame(actual, expected, `rotate ${angle}`);
    if (expected === source) assert.equal(actual, source);
  }
  assertSame(mirrorImageDataHorizontal(source), head.headMirrorImageDataHorizontal(source), 'mirror');
  for (const angle of [90, -90, 180, -180]) assertSame(rotateImageDataRightAngle(source, angle), head.headRotateImageDataRightAngle(source, angle), `right angle ${angle}`);
  const rect = { left: 2, top: 3, width: 11, height: 9 };
  const cropPlan = planGeometry(source, { cropRegion: rect });
  assertSame(renderGeometry(source, cropPlan), head.headCropImageDataRegion(source, rect), 'crop');
}

// 8-bit sources: right angles, mirror and crop run in the core (no 16-bit
// plane appears); arbitrary angles stay on the canvas path.
{
  const source = makeSource(19, 11, { seed: 5, eightBitOnly: true });
  for (const geometry of [{ rotationAngle: 90, mirrored: true, cropRegion: { left: 1, top: 2, width: 7, height: 9 } },
    { rotationAngle: 180, mirrored: false, cropRegion: null }, { rotationAngle: 0, mirrored: true, cropRegion: { left: 4, top: 1, width: 6, height: 6 } }]) {
    const expected = headStepChain(source, geometry);
    const plan = planGeometry(source, geometry);
    assert.equal(plan.has16, false);
    assertSame(applyGeometryChainToImageData(source, geometry, steps), expected, `8-bit ${JSON.stringify(geometry)}`);
    for (let bands = 1; bands <= 4; bands++) assertSame(renderBanded(source, plan, bands), expected, `8-bit ${bands} bands`);
  }
  assert.equal(planGeometry(source, { rotationAngle: 3 }), null, '8-bit arbitrary angles are not planned');
  const calls = [];
  const spy = {
    // 8-bit sources rotate through a canvas, which Node lacks; the order of calls is what matters here.
    rotate: (image, angle) => { calls.push(['rotate', angle]); return image; },
    mirror: image => { calls.push(['mirror']); return mirrorImageDataHorizontal(image); },
    crop: (image, cropRegion, bounds = image) => { calls.push(['crop', Boolean(image)]); return steps.crop(image, cropRegion, bounds); }
  };
  applyGeometryChainToImageData(source, { rotationAngle: 3, mirrored: true, cropRegion: { left: 1, top: 1, width: 5, height: 5 } }, spy);
  assert.deepEqual(calls, [['rotate', 3], ['mirror'], ['crop', true]], '8-bit arbitrary angles keep the step order');
  calls.length = 0;
  applyGeometryChainToImageData(makeSource(9, 9), { rotationAngle: 90, mirrored: true, cropRegion: { left: 1, top: 1, width: 5, height: 5 } }, spy);
  assert.deepEqual(calls, [['crop', false]], 'the core only asks the caller to sanitise the crop');
}

// A 16-bit plane that disagrees with the 8-bit view keeps HEAD's copies.
{
  const source = makeSource(8, 6, { seed: 3 });
  source.__image16 = { width: 6, height: 8, data: makeSource(6, 8).__image16.data };
  assert.equal(planGeometry(source, { mirrored: true }), null);
  assertSame(mirrorImageDataHorizontal(source), head.headMirrorImageDataHorizontal(source), 'inconsistent mirror');
  assertSame(applyRotationToImageData(source, 90), head.headApplyRotationToImageData(source, 90), 'inconsistent right angle');
}

// Unaligned typed arrays take the scalar index path with identical output.
{
  const source = makeSource(13, 7, { seed: 21 });
  const plan = planGeometry(source, { rotationAngle: -90, mirrored: true, cropRegion: { left: 1, top: 2, width: 5, height: 9 } });
  const expected = renderGeometry(source, plan);
  const shifted8 = new Uint8ClampedArray(source.data.length + 2); shifted8.set(source.data, 2);
  const shifted16 = new Uint16Array(source.__image16.data.length + 1); shifted16.set(source.__image16.data, 1);
  const out8 = new Uint8ClampedArray(plan.outWidth * plan.outHeight * 4 + 2);
  const out16 = new Uint16Array(plan.outWidth * plan.outHeight * 4 + 1);
  const view8 = out8.subarray(2), view16 = out16.subarray(1);
  renderGeometryRows(plan, { x: 0, y: 0, width: 13, height: 7, data8: shifted8.subarray(2), data16: shifted16.subarray(1) }, { data8: view8, data16: view16 }, 0, plan.outHeight);
  assert.ok(bytesOf(view8).equals(bytesOf(expected.data)) && bytesOf(view16).equals(bytesOf(expected.__image16.data)), 'unaligned scalar path');
}

// Source rectangles: a band never reads outside its slice, and bands of a
// small straighten read little more than their own rows.
{
  const plan = planGeometry({ width: 9536, height: 6336, data: { length: 9536 * 6336 * 4 }, __image16: { width: 9536, height: 6336, data: new Uint16Array(4) } }, { rotationAngle: 0.5 });
  assert.equal(plan, null, 'a truncated plane is inconsistent');
  const big = { width: 9536, height: 6336, data: { length: 9536 * 6336 * 4 } };
  big.__image16 = { width: 9536, height: 6336, data: Object.create(Uint16Array.prototype, { length: { value: 9536 * 6336 * 4 } }) };
  const tilted = planGeometry(big, { rotationAngle: 0.5, cropRegion: { left: 200, top: 150, width: 9000, height: 6000 } });
  const bands = planGeometryBands(tilted, 6);
  assert.equal(bands.length, 6);
  const margin = Math.ceil(9000 * Math.sin(0.5 * Math.PI / 180)) + 8;
  for (const band of bands) assert.ok(band.rect.height <= band.y1 - band.y0 + margin, `band rows ${band.rect.height}`);
  const quarter = planGeometry({ width: 40, height: 30, data: new Uint8ClampedArray(4800) }, { rotationAngle: 90 });
  const rect = geometrySourceRect(quarter, 0, 10);
  assert.deepEqual([rect.x, rect.width, rect.y, rect.height], [0, 10, 0, 30], 'a +90° band is a column block');
}

// Strided plans equal the chain followed by the step downsampler, which is
// how readers that downsample anyway derive their input.
{
  const source = makeSource(41, 29, { seed: 8 });
  for (const geometry of [{ rotationAngle: 1.3, mirrored: true, cropRegion: { left: 3, top: 4, width: 30, height: 20 } },
    { rotationAngle: -44.5, mirrored: false, cropRegion: null }, { rotationAngle: 90, mirrored: false, cropRegion: null },
    { rotationAngle: 0, mirrored: true, cropRegion: null }]) {
    for (const step of [2, 3, 5]) {
      const expected = downsampleImageDataByStep(headStepChain(source, geometry), step);
      const plan = planGeometry(source, geometry, { step });
      assertSame(renderGeometry(source, plan), expected, `step ${step} ${JSON.stringify(geometry)}`);
      for (let bands = 1; bands <= 3; bands++) assertSame(renderBanded(source, plan, bands), expected, `step ${step} in ${bands} bands`);
    }
  }
}

// The crop-area detection's strided sample of the frame Apply installs
// (#245's sampleRotatedGrid): for the angles the issue lists it equals the
// step downsampler run on the full rotation, and `with16: false` keeps the
// 8-bit bytes while dropping the 16-bit plane (rendered band by band into a
// scratch buffer, so bands wider than the scratch are covered too).
{
  const source = makeSource(157, 103, { seed: 11 });
  for (const angle of [0.7, -2.3, 13, 91.5, 90, -90, 180]) {
    for (const mirrored of [false, true]) {
      for (const step of [2, 3]) {
        const geometry = { rotationAngle: angle, mirrored, cropRegion: null };
        const expected = downsampleImageDataByStep(headStepChain(source, geometry), step);
        const plan = planGeometry(source, geometry, { step });
        assertSame(renderGeometry(source, plan), expected, `sample ${angle} step ${step}`);
        const eight = renderGeometry(source, plan, { with16: false });
        assert.equal(eight.__image16, undefined, `sample ${angle}: no 16-bit plane`);
        assertSame(eight, downsampleImageDataByStep(expected, 1, { with16: false }), `sample ${angle} step ${step} 8-bit only`);
      }
    }
  }
  const tall = makeSource(37, 300, { seed: 12 });
  const plan = planGeometry(tall, { rotationAngle: 3.1 }, { step: 1 });
  assert.ok(plan.outHeight > 64 * 4, 'several scratch bands');
  assert.ok(bytesOf(renderGeometry(tall, plan, { with16: false }).data).equals(bytesOf(renderGeometry(tall, plan).data)), 'banded 8-bit rows');
}

console.log(`imageGeometry chain tests passed (${cases} chain cases x 6 band counts)`);
