// Geometry chain stage 1 (#244): memoised restores, the adopted import
// rotation, and edits derived from the base by the total angle. Runs the real
// main.js functions in a vm; UI helpers are no-ops and the kernels are the
// real imageGeometry.js ones behind call counters.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const geometry = await import('./imageGeometry.js');
const { cropImageDataRegion } = await import('./imageDataOps.js');

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `runtime function exists: ${name}`);
  const end = source.indexOf('\n    }', match.index);
  return source.slice(match.index, end + '\n    }'.length);
}
function statementSource(start) {
  const index = source.indexOf(start);
  assert.ok(index >= 0, `runtime statement exists: ${start}`);
  return source.slice(index, source.indexOf('\n', index));
}

function makeBase(width, height, seed = 3) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; };
  const data16 = new Uint16Array(width * height * 4);
  const data8 = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data16.length; i += 4) {
    for (let c = 0; c < 3; c++) { data16[i + c] = rnd() % 65536; data8[i + c] = data16[i + c] >>> 8; }
    data16[i + 3] = 65535; data8[i + 3] = 255;
  }
  const image = new ImageData(data8, width, height);
  image.__image16 = { width, height, data: data16 };
  return image;
}

function samePixels(actual, expected, label) {
  assert.equal(actual.width, expected.width, `${label}: width`);
  assert.equal(actual.height, expected.height, `${label}: height`);
  assert.ok(Buffer.from(actual.data.buffer, actual.data.byteOffset, actual.data.byteLength)
    .equals(Buffer.from(expected.data.buffer, expected.data.byteOffset, expected.data.byteLength)), `${label}: 8-bit`);
  const a16 = actual.__image16.data, e16 = expected.__image16.data;
  assert.ok(Buffer.from(a16.buffer, a16.byteOffset, a16.byteLength)
    .equals(Buffer.from(e16.buffer, e16.byteOffset, e16.byteLength)), `${label}: 16-bit`);
}

const GEOMETRY_FUNCTIONS = ['geometryBaseId', 'effectiveGeometryAngle', 'geometryFrameSize', 'geometryKeyFor',
  'sameGeometryKey', 'installedGeometryKey', 'hasExactPlane16', 'takeAdoptedRotation', 'installedFramePlanes',
  'buildGeometryPlanes', 'installGeometryPlanes', 'applyGeometryFromBase', 'mapDraftRectToFrame',
  'rebuildGeometryFromBase', 'storedRotationDelta', 'applyRotation', 'applyMirror', 'mapCropRegionAfterRotation',
  'sanitizeCropRegionForImage', 'restoreSettings', 'offerAutoFrameRotation', 'invalidatePhotoActivation'];

function fixture(base) {
  const kernels = { rotate: 0, mirror: 0, crop: 0 };
  const displayed = [];
  const state = {
    loadedBaseImageData: base, originalImageData: base, croppedImageData: null,
    rotationAngle: 0, mirrored: false, cropRegion: null, currentStep: 1, cropping: false,
    autoFrame: { rotate180Default: false, lastDiagnostics: null },
    lensCorrection: { search: {} }, flatFields: {}, curvePoints: { r: [], g: [], b: [] }, dustRemoval: {}
  };
  const target = {
    state,
    normalizeAngleDegrees: geometry.normalizeAngleDegrees,
    rotatedDimensions: geometry.rotatedDimensions,
    sanitizeCropRect: geometry.sanitizeCropRect,
    applyRotationToImageData: (image, angle) => { kernels.rotate++; return geometry.applyRotationToImageData(image, angle); },
    mirrorImageDataHorizontal: image => { kernels.mirror++; return geometry.mirrorImageDataHorizontal(image); },
    cropImageDataRegion: (image, rect) => { kernels.crop++; return cropImageDataRegion(image, rect); },
    displayNegative: image => displayed.push(image),
    geometryMemo: new WeakMap(), geometryBaseIds: new WeakMap(), nextGeometryBaseId: 1, pendingImportRotation: null,
    // restoreSettings: settings are already sanitised in these scenarios.
    sanitizeSettings: settings => ({
      filmBase: {}, lensCorrection: { enabled: false, params: {}, modes: {} },
      curvePoints: { r: [], g: [], b: [] }, ...structuredClone(settings)
    }),
    EXPIRED_RESCUE_KEYS: [], sanitizePresetType: value => value,
    getLoadingOverlay: () => ({ hide() {} }),
  };
  const context = vm.createContext(new Proxy(target, {
    has: () => true,
    get(t, key) {
      if (key in t) return t[key];
      if (key in globalThis) return globalThis[key];
      if (typeof key === 'string' && /^[a-z]/.test(key)) return () => {};
      return undefined;
    }
  }));
  vm.runInContext(GEOMETRY_FUNCTIONS.map(functionSource).join('\n'), context);
  return { context, state, kernels, displayed, target };
}

const reset = kernels => { kernels.rotate = kernels.mirror = kernels.crop = 0; };
const settingsFor = state => ({ rotationAngle: state.rotationAngle, mirrored: state.mirrored, cropRegion: state.cropRegion ? { ...state.cropRegion } : null });

// ---- 1.1 memo: settings-only refreshes make zero kernel calls ----
{
  const base = makeBase(61, 43);
  const f = fixture(base), c = f.context;
  c.restoreSettings({ rotationAngle: 1.3, mirrored: true, cropRegion: { left: 4, top: 3, width: 40, height: 30 } });
  assert.deepEqual(f.kernels, { rotate: 1, mirror: 1, crop: 1 }, 'first restore builds the chain once');
  const expected = geometry.applyGeometryChainToImageData(base, { rotationAngle: 1.3, mirrored: true, cropRegion: { left: 4, top: 3, width: 40, height: 30 } }, {
    rotate: geometry.applyRotationToImageData, mirror: geometry.mirrorImageDataHorizontal,
    crop: (image, crop, bounds = image) => { const rect = geometry.sanitizeCropRect(crop, bounds); return image ? cropImageDataRegion(image, rect) : rect; }
  });
  samePixels(f.state.croppedImageData, expected, 'restore equals the export chain');
  const installed = f.state.croppedImageData;
  // Roll analysis completion, roll film type, roll reference without "apply
  // crop" and Auto Frame Selected returning the current frame all restore
  // the current geometry with other settings changed.
  for (const caller of ['rollAnalysis', 'rollFilmType', 'rollReference', 'autoFrameSelected']) {
    reset(f.kernels);
    f.displayed.length = 0;
    c.restoreSettings({ ...settingsFor(f.state), filmType: caller === 'rollFilmType' ? 'bw' : 'color', rollFrame: { caller } });
    assert.deepEqual(f.kernels, { rotate: 0, mirror: 0, crop: 0 }, `${caller}: unchanged geometry makes no kernel call`);
    assert.equal(f.state.croppedImageData, installed, `${caller}: the installed planes are kept`);
    assert.equal(f.displayed.at(-1), installed, `${caller}: refreshDisplay is still honoured`);
  }
  reset(f.kernels);
  c.restoreSettings({ ...settingsFor(f.state) }, { refreshDisplay: false });
  assert.deepEqual(f.kernels, { rotate: 0, mirror: 0, crop: 0 });
  // A changed geometry (roll reference with "apply crop", a new Auto Frame
  // result) rebuilds exactly once.
  reset(f.kernels);
  c.restoreSettings({ rotationAngle: 1.3, mirrored: true, cropRegion: { left: 6, top: 3, width: 40, height: 30 } });
  assert.deepEqual(f.kernels, { rotate: 1, mirror: 1, crop: 1 }, 'a new crop rebuilds once');
  reset(f.kernels);
  c.restoreSettings({ rotationAngle: -0.7, mirrored: false, cropRegion: { left: 6, top: 3, width: 40, height: 30 } });
  assert.deepEqual(f.kernels, { rotate: 1, mirror: 0, crop: 1 }, 'a new angle rebuilds once');
  // Undo installs other objects, which invalidates the memo implicitly.
  reset(f.kernels);
  f.state.croppedImageData = cropImageDataRegion(f.state.originalImageData, f.state.cropRegion);
  c.restoreSettings({ ...settingsFor(f.state) });
  assert.equal(f.kernels.rotate, 1, 'an object installed elsewhere carries no key');
  // A new base (heavy-RAW upgrade, another file) never matches.
  reset(f.kernels);
  f.state.loadedBaseImageData = makeBase(61, 43, 9);
  c.restoreSettings({ ...settingsFor(f.state) });
  assert.equal(f.kernels.rotate, 1);
}

// restoreSettings keeps HEAD's 0.001° threshold.
{
  const f = fixture(makeBase(20, 10));
  f.context.restoreSettings({ rotationAngle: 0.001, mirrored: false, cropRegion: null });
  assert.equal(f.kernels.rotate, 0);
  assert.equal(f.state.originalImageData, f.state.loadedBaseImageData);
  assert.equal(f.state.rotationAngle, 0.001, 'the stored angle itself is untouched');
}

// ---- 1.3 the import adopts the auto-frame worker's rotation ----
{
  const base = makeBase(50, 30);
  const f = fixture(base), c = f.context;
  const workerFrame = geometry.applyRotationToImageData(makeBase(50, 30), 2.4); // a copy, as the worker's
  c.pendingImportRotation = { base, angle: 2.4, image: workerFrame };
  c.restoreSettings({ rotationAngle: 2.4, mirrored: false, cropRegion: { left: 3, top: 2, width: 30, height: 20 } });
  assert.equal(f.kernels.rotate, 0, 'no second full-resolution rotation');
  assert.equal(f.state.originalImageData, workerFrame, 'the worker frame is the working frame');
  assert.equal(c.pendingImportRotation, null, 'the side channel is consumed');
  reset(f.kernels);
  c.restoreSettings({ rotationAngle: 2.4, mirrored: false, cropRegion: { left: 3, top: 2, width: 30, height: 20 } });
  assert.equal(f.kernels.crop, 0, 'the adopted build is memoised');

  // Wrong base, wrong angle, rotate180Default, or an 8-bit frame: not adopted.
  for (const variant of ['base', 'angle', 'eight']) {
    const g = fixture(base);
    const image = variant === 'eight' ? new ImageData(workerFrame.data, workerFrame.width, workerFrame.height) : workerFrame;
    g.context.pendingImportRotation = { base: variant === 'base' ? makeBase(50, 30) : base, angle: variant === 'angle' ? 2.5 : 2.4, image };
    g.context.restoreSettings({ rotationAngle: 2.4, mirrored: false, cropRegion: null });
    assert.equal(g.kernels.rotate, 1, `${variant}: rotated on this thread`);
    assert.equal(g.context.pendingImportRotation, null, `${variant}: slot cleared`);
  }
  const g = fixture(base);
  g.state.autoFrame.rotate180Default = true;
  g.context.offerAutoFrameRotation({ rotatedImageData: workerFrame }, 2.4, base);
  assert.equal(g.context.pendingImportRotation, null, 'a 180° flip invalidates the detector frame');
  g.context.pendingImportRotation = { base, angle: 2.4, image: workerFrame };
  g.context.invalidatePhotoActivation();
  assert.equal(g.context.pendingImportRotation, null, 'a new activation drops an unused frame');
}

// ---- 1.4 edits derive from the base by the total angle ----
function exportChain(base, geometryState) {
  return geometry.applyGeometryChainToImageData(base, geometryState, {
    rotate: geometry.applyRotationToImageData, mirror: geometry.mirrorImageDataHorizontal,
    crop: (image, crop, bounds = image) => {
      const rect = geometry.sanitizeCropRect(crop, bounds);
      if (!image) return rect;
      return rect ? cropImageDataRegion(image, rect) : image;
    }
  });
}
{
  const base = makeBase(73, 41);
  for (const mirrored of [false, true]) {
    const f = fixture(base), c = f.context;
    c.restoreSettings({ rotationAngle: 1.3, mirrored, cropRegion: { left: 5, top: 4, width: 50, height: 28 } });
    const tilted = f.state.originalImageData;
    c.applyRotation(90);
    assert.equal(f.state.rotationAngle, mirrored ? -88.7 : 91.3);
    // Single export (the live planes) now equals batch export and restore.
    samePixels(f.state.croppedImageData, exportChain(base, settingsFor(f.state)), `rotate 90 on a tilted frame (mirror ${mirrored})`);
    // HEAD permuted the tilted frame instead: the flagged change. The sample
    // positions are the same; only cos/sin roundings of a+90° can differ.
    const head = geometry.applyRotationToImageData(tilted, 90);
    const fresh = f.state.originalImageData;
    assert.deepEqual([head.width, head.height], [fresh.width, fresh.height], 'same frame size');
    let differing = 0, worst = 0;
    for (let i = 0; i < head.__image16.data.length; i++) {
      const delta = Math.abs(head.__image16.data[i] - fresh.__image16.data[i]);
      if (delta) { differing++; worst = Math.max(worst, delta); }
    }
    assert.ok(differing <= head.__image16.data.length * 0.01 && worst <= 1,
      `rotate 90 of a tilted frame differs from HEAD only by rare 1-LSB roundings (${differing} samples, max ${worst})`);
  }
  // Untilted: right angles stay pure permutations, identical to HEAD.
  for (const mirrored of [false, true]) {
    const f = fixture(base), c = f.context;
    c.restoreSettings({ rotationAngle: 0, mirrored, cropRegion: { left: 5, top: 4, width: 50, height: 28 } });
    // HEAD: permute the current frame, map the crop, crop again.
    const frameBefore = f.state.originalImageData;
    const headFrame = geometry.applyRotationToImageData(frameBefore, -90);
    const headCrop = c.mapCropRegionAfterRotation(f.state.cropRegion, frameBefore.width, frameBefore.height, headFrame.width, headFrame.height, -90);
    c.applyRotation(-90);
    assert.deepEqual({ ...f.state.cropRegion }, { ...headCrop });
    samePixels(f.state.croppedImageData, cropImageDataRegion(headFrame, headCrop), `untilted rotate (mirror ${mirrored}) is unchanged`);
    reset(f.kernels);
    c.restoreSettings(settingsFor(f.state));
    assert.equal(f.kernels.rotate + f.kernels.crop, 0, 'the rotated planes carry their key');
  }
  // Mirror flips the crop box across the base-derived frame.
  const f = fixture(base), c = f.context;
  c.restoreSettings({ rotationAngle: -3.1, mirrored: false, cropRegion: { left: 5, top: 4, width: 50, height: 28 } });
  c.applyMirror();
  samePixels(f.state.croppedImageData, exportChain(base, settingsFor(f.state)), 'mirror equals the export chain');
  assert.equal(f.state.cropRegion.left, f.state.originalImageData.width - 55);
}

// Apply Crop: the rectangle drawn on the twice-rotated draft (D) maps onto the
// frame derived once from the base (F) by ((Fw - Dw) / 2, (Fh - Dh) / 2).
{
  const f = fixture(makeBase(4, 4));
  const { rotatedDimensions } = geometry;
  const F0 = rotatedDimensions(9536, 6336, 0.8);
  const D = rotatedDimensions(F0.width, F0.height, -0.5);
  const F = rotatedDimensions(9536, 6336, 0.3);
  const offset = [(F.width - D.width) / 2, (F.height - D.height) / 2];
  assert.ok(Math.abs(offset[0]) > 40 && Math.abs(offset[1]) > 70, `+0.8° then -0.5° drifted by ${offset} px at HEAD`);
  const rect = { left: 1000.4, top: 900.6, width: 7000.9, height: 4600.2 };
  const mapped = f.context.mapDraftRectToFrame(rect, D, F);
  assert.ok(Math.abs(mapped.left - (rect.left + offset[0])) <= 1 && Math.abs(mapped.top - (rect.top + offset[1])) <= 1);
  assert.deepEqual({ ...f.context.mapDraftRectToFrame(rect, F, F) }, { ...f.context.sanitizeCropRegionForImage(rect, F) }, 'no straighten: HEAD rectangle');

  // Geometric check on pixels: a marker lands at the same place in D and F
  // once the translation is applied.
  const w = 181, h = 121;
  const marker = makeBase(w, h, 5);
  marker.__image16.data.fill(0); marker.data.fill(0);
  for (let i = 3; i < marker.data.length; i += 4) { marker.data[i] = 255; marker.__image16.data[i] = 65535; }
  const put = (x, y) => { const i = (y * w + x) * 4; marker.__image16.data[i] = 65535; marker.data[i] = 255; };
  for (let y = 70; y < 76; y++) for (let x = 120; x < 126; x++) put(x, y);
  const centroid = image => {
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
      const v = image.__image16.data[(y * image.width + x) * 4];
      if (v > 20000) { sx += x * v; sy += y * v; n += v; }
    }
    return [sx / n, sy / n];
  };
  const drafted = geometry.applyRotationToImageData(geometry.applyRotationToImageData(marker, 6), -9);
  const once = geometry.applyRotationToImageData(marker, -3);
  const [dx, dy] = centroid(drafted), [fx, fy] = centroid(once);
  const shift = [(once.width - drafted.width) / 2, (once.height - drafted.height) / 2];
  assert.ok(Math.abs(dx + shift[0] - fx) < 0.75 && Math.abs(dy + shift[1] - fy) < 0.75,
    `translated draft position ${[dx + shift[0], dy + shift[1]]} matches the base-derived frame ${[fx, fy]}`);
}

console.log('geometry memo tests passed');
