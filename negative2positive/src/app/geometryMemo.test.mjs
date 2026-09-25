// Geometry chain (#244) stages 1 and 3a: memoised restores, the adopted import
// rotation, edits derived from the base by the total angle, and the frame
// descriptor beside a crop. Runs the real main.js functions in a vm with the
// real geometry core and pool (geometryTestHarness.mjs).
import assert from 'node:assert/strict';
import {
  createHarness, makeBase, samePixels, exportChain, settle, geometry, imageDataOps, backingBuffers
} from './geometryTestHarness.mjs';

const settingsFor = state => ({ rotationAngle: state.rotationAngle, mirrored: state.mirrored, cropRegion: state.cropRegion ? { ...state.cropRegion } : null });
const plain = value => JSON.parse(JSON.stringify(value));

// ---- 1.1 memo: settings-only refreshes make zero kernel calls ----
{
  const base = makeBase(61, 43);
  const h = createHarness(base), c = h.context;
  const recipe = { rotationAngle: 1.3, mirrored: true, cropRegion: { left: 4, top: 3, width: 40, height: 30 } };
  c.restoreSettings(recipe);
  // Scalars change at once; the planes follow from the pool.
  assert.deepEqual(plain(h.state.cropRegion), { left: 4, top: 3, width: 40, height: 30 });
  assert.equal(h.state.geometryPending, true);
  assert.equal(h.state.croppedImageData, null, 'nothing is built on the calling task');
  assert.equal(await h.state.geometryReady, true);
  assert.equal(h.jobs(), 1, 'first restore builds the chain once');
  samePixels(h.state.croppedImageData, exportChain(base, recipe), 'restore equals the export chain');
  // 3a: beside a crop the frame is a size-only descriptor; no plane of the
  // rotated frame's size is reachable from state.
  const frame = h.state.originalImageData;
  assert.ok(frame.__geometryFrame, 'frame descriptor');
  assert.deepEqual([frame.width, frame.height], [geometry.rotatedDimensions(61, 43, 1.3).width, geometry.rotatedDimensions(61, 43, 1.3).height]);
  const frameBytes = frame.width * frame.height * 4;
  for (const buffer of backingBuffers(h.state)) {
    assert.ok(buffer.byteLength !== frameBytes && buffer.byteLength !== frameBytes * 2, 'no rotated-frame-sized buffer outside crop mode');
  }
  assert.equal(h.target.geometryDiagnostics.frameSyncReads, 0, 'walking state does not build the frame');

  const installed = h.state.croppedImageData;
  // Roll analysis completion, roll film type, roll reference without "apply
  // crop" and Auto Frame Selected returning the current frame all restore
  // the current geometry with other settings changed.
  for (const caller of ['rollAnalysis', 'rollFilmType', 'rollReference', 'autoFrameSelected']) {
    const before = h.jobs();
    const rotations = geometry.geometryCounters.rotations;
    h.displayed.length = 0;
    c.restoreSettings({ ...settingsFor(h.state), filmType: caller === 'rollFilmType' ? 'bw' : 'color', rollFrame: { caller } });
    assert.equal(h.state.geometryPending, false, `${caller}: no build is started`);
    await settle();
    assert.equal(h.jobs(), before, `${caller}: unchanged geometry makes no kernel call`);
    assert.equal(geometry.geometryCounters.rotations, rotations);
    assert.equal(h.state.croppedImageData, installed, `${caller}: the installed planes are kept`);
    assert.equal(h.displayed.at(-1), installed, `${caller}: refreshDisplay is still honoured`);
  }
  // A changed geometry (roll reference with "apply crop", a new Auto Frame
  // result) rebuilds exactly once.
  let before = h.jobs();
  c.restoreSettings({ rotationAngle: 1.3, mirrored: true, cropRegion: { left: 6, top: 3, width: 40, height: 30 } });
  await h.state.geometryReady;
  assert.equal(h.jobs(), before + 1, 'a new crop rebuilds once');
  before = h.jobs();
  c.restoreSettings({ rotationAngle: -0.7, mirrored: false, cropRegion: { left: 6, top: 3, width: 40, height: 30 } });
  await h.state.geometryReady;
  assert.equal(h.jobs(), before + 1, 'a new angle rebuilds once');
  samePixels(h.state.croppedImageData, exportChain(base, settingsFor(h.state)), 'rebuilt planes');
  // Undo installs other objects, which invalidates the memo implicitly.
  before = h.jobs();
  h.state.croppedImageData = imageDataOps.cropImageDataRegion(makeBase(80, 60), { left: 0, top: 0, width: 40, height: 30 });
  c.restoreSettings(settingsFor(h.state));
  await h.state.geometryReady;
  assert.equal(h.jobs(), before + 1, 'an object installed elsewhere carries no key');
  // A new base (heavy-RAW upgrade, another file) never matches.
  before = h.jobs();
  h.state.loadedBaseImageData = makeBase(61, 43, 9);
  c.restoreSettings(settingsFor(h.state));
  await h.state.geometryReady;
  assert.equal(h.jobs(), before + 1);
}

// restoreSettings keeps HEAD's 0.001° threshold.
{
  const h = createHarness(makeBase(20, 10));
  h.context.restoreSettings({ rotationAngle: 0.001, mirrored: false, cropRegion: null });
  assert.equal(h.state.geometryPending, false);
  assert.equal(h.state.originalImageData, h.state.loadedBaseImageData);
  assert.equal(h.state.rotationAngle, 0.001, 'the stored angle itself is untouched');
}

// ---- 1.3 the import adopts the auto-frame worker's rotation ----
{
  const base = makeBase(50, 30);
  const h = createHarness(base), c = h.context;
  const workerFrame = geometry.applyRotationToImageData(makeBase(50, 30), 2.4); // a copy, as the worker's
  c.pendingImportRotation = { base, angle: 2.4, image: workerFrame };
  const rotations = h.pool.counters.rotations;
  const recipe = { rotationAngle: 2.4, mirrored: false, cropRegion: { left: 3, top: 2, width: 30, height: 20 } };
  c.restoreSettings(recipe);
  await h.state.geometryReady;
  assert.equal(h.pool.counters.rotations, rotations, 'no second full-resolution rotation');
  assert.equal(h.pool.counters.copies, 1, 'the crop is copied from the worker frame');
  assert.equal(h.target.geometryDiagnostics.adoptedRotations, 1);
  assert.equal(c.pendingImportRotation, null, 'the side channel is consumed');
  samePixels(h.state.croppedImageData, exportChain(base, recipe), 'adopted planes equal the export chain');
  assert.ok(h.state.originalImageData.__geometryFrame, 'the worker frame is not retained beside the crop');
  const jobs = h.jobs();
  c.restoreSettings(recipe);
  await settle();
  assert.equal(h.jobs(), jobs, 'the adopted build is memoised');
  // Without a crop the worker frame is the working frame.
  const g = createHarness(base);
  g.context.pendingImportRotation = { base, angle: 2.4, image: workerFrame };
  g.context.restoreSettings({ rotationAngle: 2.4, mirrored: false, cropRegion: null });
  await g.state.geometryReady;
  assert.equal(g.state.originalImageData, workerFrame);
  assert.equal(g.jobs(), 0);

  // Wrong base, wrong angle, or an 8-bit frame: not adopted.
  for (const variant of ['base', 'angle', 'eight']) {
    const k = createHarness(base);
    const image = variant === 'eight' ? new ImageData(workerFrame.data, workerFrame.width, workerFrame.height) : workerFrame;
    k.context.pendingImportRotation = { base: variant === 'base' ? makeBase(50, 30) : base, angle: variant === 'angle' ? 2.5 : 2.4, image };
    k.context.restoreSettings({ rotationAngle: 2.4, mirrored: false, cropRegion: null });
    await k.state.geometryReady;
    assert.equal(k.pool.counters.rotations, 1, `${variant}: rotated in the pool`);
    assert.equal(k.context.pendingImportRotation, null, `${variant}: slot cleared`);
  }
  const k = createHarness(base);
  k.state.autoFrame.rotate180Default = true;
  k.context.offerAutoFrameRotation({ rotatedImageData: workerFrame }, 2.4, base);
  assert.equal(k.context.pendingImportRotation, null, 'a 180° flip invalidates the detector frame');
}

// ---- 1.4 edits derive from the base by the total angle ----
{
  const base = makeBase(73, 41);
  for (const mirrored of [false, true]) {
    const h = createHarness(base), c = h.context;
    c.restoreSettings({ rotationAngle: 1.3, mirrored, cropRegion: { left: 5, top: 4, width: 50, height: 28 } });
    await h.state.geometryReady;
    const tilted = geometry.applyRotationToImageData(base, 1.3);
    const tiltedFrame = mirrored ? geometry.mirrorImageDataHorizontal(tilted) : tilted;
    const pending = c.applyRotation(90);
    assert.equal(h.state.rotationAngle, mirrored ? -88.7 : 91.3);
    // The new framing shows at once as a CSS turn of the current display.
    assert.match(h.target.canvasTransformWrapper.style.transform, /rotate\(90deg\)/);
    await pending;
    assert.equal(h.target.canvasTransformWrapper.style.transform, 'matrix(1, 0, 0, 1, 0, 0)', 'the first paint of the new planes removes it');
    // Single export (the live planes) now equals batch export and restore.
    samePixels(h.state.croppedImageData, exportChain(base, settingsFor(h.state)), `rotate 90 on a tilted frame (mirror ${mirrored})`);
    // HEAD permuted the tilted frame instead: the flagged change. The sample
    // positions are the same; only cos/sin roundings of a+90° can differ.
    const head = geometry.applyRotationToImageData(tiltedFrame, 90);
    const fresh = exportChain(base, { ...settingsFor(h.state), cropRegion: null });
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
    const h = createHarness(base), c = h.context;
    c.restoreSettings({ rotationAngle: 0, mirrored, cropRegion: { left: 5, top: 4, width: 50, height: 28 } });
    await h.state.geometryReady;
    // HEAD: permute the current frame, map the crop, crop again.
    const frameBefore = mirrored ? geometry.mirrorImageDataHorizontal(base) : base;
    const headFrame = geometry.applyRotationToImageData(frameBefore, -90);
    const headCrop = c.mapCropRegionAfterRotation(h.state.cropRegion, frameBefore.width, frameBefore.height, headFrame.width, headFrame.height, -90);
    await c.applyRotation(-90);
    assert.deepEqual(plain(h.state.cropRegion), plain(headCrop));
    samePixels(h.state.croppedImageData, imageDataOps.cropImageDataRegion(headFrame, headCrop), `untilted rotate (mirror ${mirrored}) is unchanged`);
    const jobs = h.jobs();
    c.restoreSettings(settingsFor(h.state));
    await settle();
    assert.equal(h.jobs(), jobs, 'the rotated planes carry their key');
  }
  // Mirror flips the crop box across the base-derived frame.
  const h = createHarness(base), c = h.context;
  c.restoreSettings({ rotationAngle: -3.1, mirrored: false, cropRegion: { left: 5, top: 4, width: 50, height: 28 } });
  await h.state.geometryReady;
  const pending = c.applyMirror();
  assert.match(h.target.canvasTransformWrapper.style.transform, /scaleX\(-1\)/);
  await pending;
  samePixels(h.state.croppedImageData, exportChain(base, settingsFor(h.state)), 'mirror equals the export chain');
  assert.equal(h.state.cropRegion.left, h.state.originalImageData.width - 55);
}

// Apply Crop: the rectangle drawn on the twice-rotated draft (D) maps onto the
// frame derived once from the base (F) by ((Fw - Dw) / 2, (Fh - Dh) / 2).
{
  const h = createHarness(makeBase(4, 4));
  const { rotatedDimensions } = geometry;
  const F0 = rotatedDimensions(9536, 6336, 0.8);
  const D = rotatedDimensions(F0.width, F0.height, -0.5);
  const F = rotatedDimensions(9536, 6336, 0.3);
  const offset = [(F.width - D.width) / 2, (F.height - D.height) / 2];
  assert.ok(Math.abs(offset[0]) > 40 && Math.abs(offset[1]) > 70, `+0.8° then -0.5° drifted by ${offset} px at HEAD`);
  const rect = { left: 1000.4, top: 900.6, width: 7000.9, height: 4600.2 };
  const mapped = h.context.mapDraftRectToFrame(rect, D, F);
  assert.ok(Math.abs(mapped.left - (rect.left + offset[0])) <= 1 && Math.abs(mapped.top - (rect.top + offset[1])) <= 1);
  assert.deepEqual(plain(h.context.mapDraftRectToFrame(rect, F, F)), plain(h.context.sanitizeCropRegionForImage(rect, F)), 'no straighten: HEAD rectangle');

  // Geometric check on pixels: a marker lands at the same place in D and F
  // once the translation is applied.
  const w = 181, hgt = 121;
  const marker = makeBase(w, hgt, 5);
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

// ---- 3a: frame readers ----
{
  const base = makeBase(57, 39, 4);
  const h = createHarness(base), c = h.context;
  const recipe = { rotationAngle: -7.9, mirrored: true, cropRegion: { left: 6, top: 5, width: 40, height: 25 } };
  c.restoreSettings(recipe);
  await h.state.geometryReady;
  const full = exportChain(base, { ...recipe, cropRegion: null });
  // Samples of the whole frame, built from the base (crop draft, crop-area
  // detection) equal downsampling the frame itself.
  for (const maxPixels of [300, 700, 5000]) {
    samePixels(c.renderFrameSample(maxPixels), imageDataOps.downsampleImageDataForMaxPixels(full, maxPixels), `frame sample ${maxPixels}`);
  }
  samePixels(c.renderFrameSample(500, { base, rotationAngle: 11, mirrored: false }),
    imageDataOps.downsampleImageDataForMaxPixels(exportChain(base, { rotationAngle: 11 }), 500), 'a sample of another angle');
  // The rare reader of the whole frame gets it from the pool; state keeps none.
  const jobs = h.jobs();
  samePixels(await c.geometryFramePixels(), full, 'geometryFramePixels');
  assert.equal(h.jobs(), jobs + 1);
  assert.ok(h.state.originalImageData.__geometryFrame);
  // A synchronous read still works, counted as a fallback.
  samePixels({ width: h.state.originalImageData.width, height: h.state.originalImageData.height,
    data: h.state.originalImageData.data, __image16: h.state.originalImageData.__image16 }, full, 'descriptor fallback');
  assert.equal(h.target.geometryDiagnostics.frameSyncReads, 1);
  // Without a crop the working frame is real pixels and samples reuse it.
  c.restoreSettings({ ...recipe, cropRegion: null });
  await h.state.geometryReady;
  samePixels(h.state.originalImageData, full, 'no-crop working frame');
  samePixels(c.renderFrameSample(700), imageDataOps.downsampleImageDataForMaxPixels(full, 700), 'sample of the installed frame');
}

// ---- Apply Crop builds only the crop window, from the base ----
{
  const { applyCropHandlerSource } = await import('./geometryTestHarness.mjs');
  const { imageAreaFromWorkingRect } = await import('./analysisRegion.js');
  const { isSameAnalysisFrame, workingPointsToBase, buildCropDetectionInput } = await import('./cropColorAnalysis.js');
  const vm = await import('node:vm');
  const base = makeBase(90, 64, 21);
  for (const scenario of ['straighten', 'plain', 'analysis', 'mirrored']) {
    const h = createHarness(base), c = h.context;
    const mirrored = scenario === 'mirrored';
    c.restoreSettings({ rotationAngle: 1.3, mirrored, cropRegion: { left: 6, top: 5, width: 70, height: 45 } });
    await h.state.geometryReady;
    const detections = [];
    Object.assign(h.target, {
      applyCropBtn: { disabled: false }, cancelCropBtn: { disabled: false },
      getLoadingOverlay: () => ({ show: async () => {}, hide() {} }),
      requestAnimationFrame: callback => setTimeout(callback, 0),
      studioWorkspace: { sync() {}, text: key => key },
      imageAreaFromWorkingRect, isSameAnalysisFrame, workingPointsToBase,
      // The detection's input is built on the page; the OpenCV half (the
      // worker) misses.
      buildCropDetectionInput: (image, crop, options) => { detections.push({ image, crop, options }); return buildCropDetectionInput(image, crop, options); },
      runOpenCvTask: async (type, task) => { await task.build(); return null; },
      exitCropMode: () => { h.state.cropping = false; h.state.cropDraft = null; }
    });
    vm.runInContext(applyCropHandlerSource(), c);
    const draftAngle = scenario === 'plain' || scenario === 'analysis' ? 0 : -0.5;
    const frameBefore = h.state.originalImageData;
    const preview = c.renderFrameSample(700_000);
    const rotatedPreview = draftAngle ? geometry.applyRotationToImageData(preview, draftAngle) : preview;
    const rect = { left: 11.3, top: 7.8, width: 52.4, height: 37.1 };
    h.state.cropping = true;
    h.state.cropDraft = {
      sourceImageData: frameBefore, rotatedSize: { width: rotatedPreview.width, height: rotatedPreview.height },
      rect, rotationBase: 0, straightenAngle: draftAngle, analysisOnly: scenario === 'analysis'
    };
    const cropBefore = { ...h.state.cropRegion };
    await c.applyCropHandler();
    await settle();
    if (scenario === 'analysis') {
      assert.equal(h.state.rotationAngle, 1.3, 'analysis only: geometry unchanged');
      assert.deepEqual(plain(h.state.cropRegion), plain(cropBefore));
      assert.equal(detections.length, 0);
      continue;
    }
    const total = geometry.normalizeAngleDegrees(1.3 + (mirrored ? 0.5 : -0.5) * (draftAngle ? 1 : 0));
    assert.equal(h.state.rotationAngle, total);
    const draftFrame = geometry.rotatedDimensions(frameBefore.width, frameBefore.height, draftAngle);
    const frame = geometry.rotatedDimensions(90, 64, total);
    const expectedCrop = c.mapDraftRectToFrame(c.scaleCropRect(rect, draftFrame.width / rotatedPreview.width, draftFrame.height / rotatedPreview.height), draftFrame, frame);
    assert.deepEqual(plain(h.state.cropRegion), plain(expectedCrop), `${scenario}: rectangle mapped onto the base-derived frame`);
    samePixels(h.state.croppedImageData, exportChain(base, settingsFor(h.state)), `${scenario}: planes equal the export chain`);
    assert.ok(h.state.originalImageData.__geometryFrame, `${scenario}: the rotated frame is not kept`);
    // The crop-area detector got exactly the <=1 MP sample of the new frame
    // (8-bit only: it never read the 16-bit plane).
    assert.equal(detections.length, 1);
    assert.deepEqual([detections[0].image.width, detections[0].image.height], [frame.width, frame.height]);
    const expectedSample = imageDataOps.downsampleImageDataForMaxPixels(exportChain(base, { rotationAngle: total, mirrored }), 1_000_000);
    assert.deepEqual([detections[0].options.preview.width, detections[0].options.preview.height], [expectedSample.width, expectedSample.height]);
    assert.ok(Buffer.from(detections[0].options.preview.data.buffer).equals(Buffer.from(expectedSample.data.buffer)), `${scenario}: detection sample`);
    assert.equal(detections[0].options.preview.__image16, undefined, `${scenario}: no 16-bit plane in the sample`);
    assert.equal(h.target.geometryDiagnostics.frameSyncReads, 0);
  }
}

console.log('geometry memo tests passed');
