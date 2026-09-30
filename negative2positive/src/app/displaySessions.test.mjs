// Display-resolution photo sessions (#249) on the real main.js functions:
// Tier A (the conversion source without the base), Tier B (display planes
// only), demotion on eviction, the spill, ensureBase/ensureSource and the
// rule that a display proxy never becomes a base, a plane or a source.
import assert from 'node:assert/strict';

// ImageData in both constructor forms (the harness's stand-in has only one).
globalThis.ImageData = class ImageData {
  constructor(dataOrWidth, width, height) {
    if (typeof dataOrWidth === 'number') {
      this.width = dataOrWidth; this.height = width; this.data = new Uint8ClampedArray(dataOrWidth * width * 4);
    } else {
      this.data = dataOrWidth; this.width = width; this.height = height;
    }
  }
};
const { createHarness, makeBase, samePixels, exportChain, settle, createPhotoSessionCache, backingBuffers } = await import('./geometryTestHarness.mjs');
const { buildDisplayLevel, displayLevelGeometry, isDisplayTarget, displayPreviewSize } = await import('./displayPreview.js');
const { createDisplayProxySpill, createDisplayProxyPort, createDisplayProxyWorkerCore, createDisplayProxyStore, displayProxyFileKey, sha256Hex } = await import('./displayProxyStore.js');
const { decodeDisplayProxyRecord } = await import('./displayProxy.js');

const settingsFor = state => ({ rotationAngle: state.rotationAngle, mirrored: state.mirrored, cropRegion: state.cropRegion ? { ...state.cropRegion } : null });
const CROP = { left: 10, top: 8, width: 60, height: 40 };
const AREA = [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }];
const bytesOf = images => [...backingBuffers(images)].reduce((sum, buffer) => sum + buffer.byteLength, 0);

// The display level (#248) is the display proxy: 16-bit only, with its
// source geometry.
function sameLevel(actual, expected, label) {
  assert.ok(actual && expected, `${label}: levels exist`);
  assert.deepEqual([actual.width, actual.height], [expected.width, expected.height], `${label}: size`);
  assert.ok(Buffer.from(actual.__image16.data.buffer, actual.__image16.data.byteOffset, actual.__image16.data.byteLength)
    .equals(Buffer.from(expected.__image16.data.buffer, expected.__image16.data.byteOffset, expected.__image16.data.byteLength)), `${label}: 16-bit`);
  assert.deepEqual({ ...displayLevelGeometry(actual) }, { ...displayLevelGeometry(expected) }, `${label}: geometry`);
}

// A photo converted as a large frame: its crop is the conversion source, a
// 30x20 display level (k = 2) the proxy, a display target on it the
// conversion preview, and the preview conversion on screen.
async function convertedPhoto({ sessionBudget, base = makeBase(96, 64, 5), largeImagePixels = 1000, name = 'a.dng', id = 1, filmEdge = true } = {}) {
  const h = createHarness(base, { sessionBudget, realProcessNegative: true, displayLevels: true }), c = h.context;
  h.target.largeImagePixels = largeImagePixels;
  h.target.usesSilverCoreConversion = () => true;
  h.target.photoSessions = createPhotoSessionCache({ maxBytes: sessionBudget, onEvict: (item, value) => c.demoteDisplaySession(item, value) });
  h.state.autoFrame.lastDiagnostics = { imageArea: AREA, appliedMode: 'crop' };
  c.restoreSettings({ rotationAngle: 1.3, mirrored: false, cropRegion: CROP });
  await h.state.geometryReady;
  const crop = h.state.croppedImageData;
  const proxy = buildDisplayLevel(crop, 2);
  const processed = makeBase(30, 20, 9);
  // The viewport a display target of 30 x 20 serves (getDisplayPreviewSize's inputs).
  h.target.getCanvasContainerSize = () => ({ width: 50, height: 40 });
  h.target.previewTierMaxPixels = () => 600;
  Object.assign(h.state, {
    currentStep: 3, conversionSourceImageData: crop, displayLevelImageData: proxy,
    conversionPreviewImageData: c.conversionTargetFor(crop, proxy, 'normal'), processedImageData: processed,
    previewSourceImageData: processed, histogramSourceImageData: processed, webglSourceImageData: processed,
    processedImageDataIsPreview: true, fullResolutionPending: true
  });
  // The sample the conversion read, cached for the base as getColorAnalysisSample does.
  const sample = c.getColorAnalysisSample(h.state);
  assert.ok(sample?.data, 'the colour-analysis sample of the image area');
  assert.ok(isDisplayTarget(h.state.conversionPreviewImageData), 'a display target on the level');
  const item = { id, file: { name }, settings: { ...settingsFor(h.state), autoFrameMeta: { imageArea: AREA }, filmEdge: filmEdge ? { checked: true } : null } };
  h.state.loadedFile = item.file;
  return { h, c, base, crop, proxy, processed, sample, item };
}

// Switches in the harness: the other photo "decodes" a small base of its own.
function wireSwitching(h, items) {
  const c = h.context;
  h.state.fileQueue = items;
  h.state.currentFileIndex = items.findIndex(item => item.file === h.state.loadedFile);
  h.target.getCurrentQueueItem = () => {
    const item = h.state.fileQueue[h.state.currentFileIndex];
    return item?.file === h.state.loadedFile ? item : null;
  };
  h.target.persistCurrentFileSettings = () => {
    const item = h.target.getCurrentQueueItem();
    if (item) item.settings = { ...item.settings, ...settingsFor(h.state) };
  };
  h.target.loadFile = async file => {
    const other = makeBase(20, 16, 3);
    Object.assign(h.state, {
      loadedFile: file, loadedBaseImageData: other, originalImageData: other, croppedImageData: null, cropRegion: null,
      rotationAngle: 0, mirrored: false, baseDescriptor: null, sourcePending: null, processedImageData: null,
      conversionSourceImageData: null, conversionPreviewImageData: null, previewSourceImageData: null, currentStep: 1
    });
    h.target.undoStack.length = 0; h.target.redoStack.length = 0;
    return { status: 'loaded' };
  };
  return c;
}

// ---- Tier A: the source without the base; back without a decode ----
{
  // Full: base + crop + proxy + preview; Tier A: crop + proxy + preview.
  const probe = await convertedPhoto({ sessionBudget: 1 << 30 });
  const full = bytesOf([probe.base, probe.crop, probe.proxy, probe.processed]);
  const tierA = bytesOf([probe.crop, probe.proxy, probe.processed]);
  const { h, c, base, crop, processed, item } = await convertedPhoto({ sessionBudget: Math.floor((full + tierA) / 2) });
  c.pushUndo('exposure');
  h.state.exposure = 5;
  const itemB = { id: 2, file: { name: 'b.dng' }, settings: null };
  wireSwitching(h, [item, itemB]);

  await c.switchToFile(1);
  const entry = h.target.photoSessions.get(item);
  assert.equal(entry.tier, 'A', 'the full session does not fit; Tier A does');
  assert.equal(entry.base, null, 'Tier A drops the base');
  assert.equal(entry.snapshot.refs.originalImageData.released, true, 'and the whole rotated frame');
  assert.equal(entry.snapshot.refs.croppedImageData, crop, 'the conversion source is kept');
  assert.equal(entry.undo.length, 1);
  assert.equal(entry.undo[0].refs.cold, undefined, 'a slider step keeps its planes: they are all kept');
  assert.equal(entry.undo[0].refs.originalImageData.released, true, 'its frame is a stand-in too');
  assert.ok(entry.display, 'it carries its display form for a demotion');
  assert.equal(h.target.displaySessionDiagnostics.tierA, 1);
  assert.ok(h.target.photoSessions.bytes <= Math.floor((full + tierA) / 2), 'the budget holds');

  const jobs = h.jobs();
  await c.switchToFile(0);
  assert.equal(h.state.loadedBaseImageData, null, 'no decode on the way back');
  assert.equal(h.target.baseDecodes, undefined);
  assert.equal(h.state.croppedImageData, crop, 'the same conversion source: exports are unchanged');
  assert.equal(h.state.conversionSourceImageData, crop);
  assert.equal(h.state.processedImageData, processed, 'the settled preview is back in the same task');
  assert.equal(h.state.baseDescriptor.width, base.width);
  assert.equal(h.target.undoStack.length, 1, 'the undo depth survives');
  assert.equal(h.jobs(), jobs, 'no geometry was built');
  assert.equal(h.target.displaySessionDiagnostics.ramHits, 1);
  assert.equal(h.target.document.body.dataset.photoSwitching, undefined, 'no veil');

  // A settings-only refresh (roll analysis completion, roll film type) with
  // the same geometry keeps the crop and builds nothing.
  c.restoreSettings(item.settings);
  assert.deepEqual({ ...h.state.cropRegion }, CROP, 'the crop is not cleared without a base');
  assert.equal(h.state.croppedImageData, crop);
  assert.equal(h.state.geometryPending, false);
  assert.equal(h.jobs(), jobs);

  // A geometry edit waits for the base, then builds from it exactly.
  h.target.decodeBase = () => base;
  const rotating = c.applyRotation(90);
  assert.equal(h.state.geometryPending, true, 'the rotation waits for the original');
  assert.equal(h.target.document.body.dataset.studioPreparing, 'original', 'with a visible pending state');
  await rotating;
  await settle();
  assert.equal(h.target.baseDecodes, 1, 'one decode');
  // Inside a foreground reservation of its own (#258), released once it returned.
  const { claim } = h.target.decodeOpens.at(-1).context;
  assert.equal(claim.priority, 'foreground', 'the photo on screen waits for it: never a background claim');
  assert.equal(claim.released, true);
  assert.equal(h.state.loadedBaseImageData, base, 'the base is back');
  assert.equal(h.state.baseDescriptor, null);
  assert.equal(h.target.document.body.dataset.studioPreparing, undefined);
  samePixels(h.state.croppedImageData, exportChain(base, settingsFor(h.state)), 'the rotated crop equals the export chain');
  // Undoing it reproduces the pre-switch planes (a hot entry: a reference swap).
  c.performUndo();
  assert.equal(h.state.croppedImageData, crop, 'undo gives back the pre-switch pixels');
  assert.ok(h.state.originalImageData.__geometryFrame, 'with the base back, the frame is a descriptor of it again');
}

// ---- Recipe changed while away (a roll commit): the kept planes convert
// under the new recipe behind the veil, with no decode; a Tier B photo
// converts its proxy ----
for (const tier of ['A', 'B']) {
  const probe = await convertedPhoto({ sessionBudget: 1 << 30 });
  const full = bytesOf([probe.base, probe.crop, probe.proxy, probe.processed]);
  const tierA = bytesOf([probe.crop, probe.proxy, probe.processed]);
  const tierB = bytesOf([probe.proxy, probe.processed, probe.sample]);
  const budget = tier === 'A' ? Math.floor((full + tierA) / 2) : Math.floor((tierA + tierB) / 2);
  const { h, c, crop, proxy, item } = await convertedPhoto({ sessionBudget: budget });
  c.pushUndo('exposure');
  wireSwitching(h, [item, { id: 2, file: { name: 'b.dng' }, settings: null }]);
  await c.switchToFile(1);
  assert.equal(h.target.photoSessions.get(item).tier, tier);
  item.settings = { ...item.settings, exposure: 12 };
  const converted = [];
  h.target.convertFromCurrentSource = async (settings, options) => {
    converted.push(options.preview ? h.state.conversionPreviewImageData.__displayOf || h.state.conversionPreviewImageData : h.state.conversionSourceImageData);
    return makeBase(30, 20, 13);
  };
  let feedback = null;
  h.target.prepareStudioPhoto = async () => {
    feedback = h.target.document.body.dataset.photoSwitching;
    await c.processNegative({ quiet: true });
  };
  h.target.restoreSettings = settings => { h.state.exposure = settings.exposure; };
  await c.switchToFile(0);
  assert.equal(h.target.displaySessionDiagnostics.recipeChanged, 1, `Tier ${tier}: recipe changed`);
  assert.equal(feedback, 'true', 'converted behind the veil');
  assert.equal(h.state.exposure, 12, 'under the recipe the item has now');
  assert.equal(h.target.baseDecodes, undefined, 'no decode');
  assert.equal(h.target.undoStack.length, 1, 'history kept');
  if (tier === 'A') {
    assert.equal(h.state.croppedImageData, crop);
    assert.equal(converted.length, 1);
  } else {
    assert.equal(converted.at(-1), proxy, 'the level converted');
    assert.equal(h.state.conversionSourceImageData, null);
  }
  assert.equal(h.target.document.body.dataset.photoSwitching, undefined);
}

// ---- Tier A: a history entry that pinned the base goes cold; undoing it
// decodes the base and rebuilds exactly ----
{
  const probe = await convertedPhoto({ sessionBudget: 1 << 30 });
  const full = bytesOf([probe.base, probe.crop, probe.proxy, probe.processed]);
  const tierA = bytesOf([probe.crop, probe.proxy, probe.processed]);
  const { h, c, base, crop, item } = await convertedPhoto({ sessionBudget: Math.floor((full + tierA) / 2) });
  // An entry of the uncropped, unrotated photo: its frame is the base.
  const uncropped = { label: 'crop', settings: { ...h.target.captureSnapshot('x').settings, rotationAngle: 0, cropRegion: null },
    refs: { originalImageData: base, croppedImageData: null, processedImageData: null, conversionSourceImageData: base } };
  h.target.undoStack.push(uncropped);
  const itemB = { id: 2, file: { name: 'b.dng' }, settings: null };
  wireSwitching(h, [item, itemB]);
  await c.switchToFile(1);
  const entry = h.target.photoSessions.get(item);
  assert.equal(entry.tier, 'A');
  assert.equal(entry.undo[0].refs.cold, true, 'an entry that pins the base keeps its scalars only');
  await c.switchToFile(0);
  assert.equal(h.state.croppedImageData, crop);
  h.target.decodeBase = () => base;
  await c.performUndo();
  await settle();
  assert.equal(h.target.baseDecodes, 1);
  assert.equal(h.state.cropRegion, null);
  assert.equal(h.state.originalImageData, base, 'the uncropped frame is the base again');
}

// ---- Tier B: display planes only; previews convert the proxy; the source
// comes back through ensureSource(), exactly ----
{
  const probe = await convertedPhoto({ sessionBudget: 1 << 30 });
  const tierB = bytesOf([probe.proxy, probe.processed, probe.sample]);
  const tierA = bytesOf([probe.crop, probe.proxy, probe.processed]);
  const budget = Math.floor((tierA + tierB) / 2);
  const { h, c, base, crop, proxy, processed, sample, item } = await convertedPhoto({ sessionBudget: budget });
  const itemB = { id: 2, file: { name: 'b.dng' }, settings: null };
  wireSwitching(h, [item, itemB]);
  await c.switchToFile(1);
  const entry = h.target.photoSessions.get(item);
  assert.equal(entry.tier, 'B', 'neither the full session nor Tier A fits');
  for (const key of ['originalImageData', 'croppedImageData']) assert.equal(entry.snapshot.refs[key].released, true, `${key} is a stand-in`);
  assert.equal(entry.snapshot.refs.conversionSourceImageData, null, 'no source');
  assert.equal(entry.snapshot.refs.displayLevelImageData, proxy, 'the display level is the proxy');
  assert.ok(isDisplayTarget(entry.snapshot.refs.conversionPreviewImageData), 'with a display target on it');
  assert.equal(entry.sample, sample, 'the colour-analysis sample');
  assert.ok(entry.undo.every(snapshot => snapshot.refs.cold));
  assert.ok(h.target.photoSessions.bytes <= budget);

  await c.switchToFile(0);
  assert.equal(h.state.processedImageData, processed, 'the settled preview in the same task');
  assert.equal(h.state.conversionSourceImageData, null);
  assert.equal(h.state.displayLevelImageData, proxy);
  assert.equal(h.state.conversionPreviewImageData.__displayOf, proxy);
  assert.equal(h.state.sourcePending.width, crop.width);
  assert.equal(h.target.baseDecodes, undefined, 'no decode');
  assert.equal(h.target.document.body.dataset.photoSwitching, undefined, 'an in-RAM Tier B hit shows no veil');
  assert.equal(c.hasSeparateConversionPreview(), true, 'export still owes the full-resolution frame');
  assert.equal(c.getColorAnalysisSample(h.state), sample, 'conversions read the kept sample');
  assert.deepEqual({ ...h.state.cropRegion }, CROP);

  // The preview half converts the proxy (no decode) while it matches.
  const converted = [];
  h.target.convertFromCurrentSource = async (settings, options) => {
    converted.push({ image: options.preview ? h.state.conversionPreviewImageData.__displayOf : h.state.conversionSourceImageData, options });
    return makeBase(30, 20, 11);
  };
  assert.equal(c.displayProxyMatches(item), true);
  await c.processNegative({ quiet: true });
  assert.equal(converted.at(-1).image, proxy, 'the preview conversion reads the level');
  assert.equal(converted.at(-1).options.wbSample, true, 'with the viewport-independent WB sample of the level');
  assert.equal(converted.at(-1).options.preview, true);
  assert.equal(h.target.autoMeasurements, 1, 'automatic measurements run as on a cold open');
  assert.equal(h.target.baseDecodes, undefined);
  assert.equal(h.state.fullResolutionPending, true);

  // ensureSource() rebuilds the source from the base exactly; the self-check
  // finds the proxy equal to the one the new source gives.
  h.target.decodeBase = () => base;
  assert.equal(await c.ensureSource(), true);
  await settle();
  assert.equal(h.state.sourcePending, null);
  assert.equal(h.state.baseDescriptor, null);
  samePixels(h.state.conversionSourceImageData, crop, 'the rebuilt source equals the one left behind');
  assert.equal(h.state.displayLevelImageData, proxy, 'the proxy stays the display level');
  for (let i = 0; i < 40 && !h.target.displaySessionDiagnostics.selfChecks; i++) await settle();
  assert.equal(h.target.displaySessionDiagnostics.selfChecks, 1);
  assert.equal(h.target.displaySessionDiagnostics.selfCheckMismatches, 0);
}

// ---- Undo on a Tier B photo: a slider step converts the proxy again, with
// no decode; a geometry step waits for the original ----
{
  const probe = await convertedPhoto({ sessionBudget: 1 << 30 });
  const budget = bytesOf([probe.proxy, probe.processed, probe.sample]) + 64;
  const { h, c, base, crop, proxy, item } = await convertedPhoto({ sessionBudget: budget });
  wireSwitching(h, [item, { id: 2, file: { name: 'b.dng' }, settings: null }]);
  await c.switchToFile(1);
  await c.switchToFile(0);
  assert.ok(h.state.sourcePending);
  const converted = [];
  h.target.convertFromCurrentSource = async (settings, options) => {
    converted.push(options.preview ? h.state.conversionPreviewImageData.__displayOf : h.state.conversionSourceImageData);
    return makeBase(30, 20, 17);
  };
  h.state.exposure = 3;
  c.pushUndo('exposure');
  assert.equal(h.target.undoStack.at(-1).refs.cold, true, 'a Tier B session has no planes to refer to');
  h.state.exposure = 7;
  await c.performUndo();
  await settle();
  assert.equal(h.state.exposure, 3, 'the scalars come back');
  assert.equal(converted.at(-1), proxy, 'the level converts again');
  assert.equal(h.target.baseDecodes, undefined, 'without waiting for the source');
  assert.equal(h.state.displayLevelImageData, proxy, 'the level stays');
  // A geometry step waits for the original, then builds exactly.
  h.target.decodeBase = () => base;
  c.pushUndo('rotation');
  const rotating = c.applyRotation(90);
  await rotating;
  await settle();
  await c.performUndo();
  await settle();
  assert.equal(h.target.baseDecodes, 1);
  samePixels(h.state.croppedImageData, crop, 'undoing the rotation rebuilds the planes left behind');
}

// ---- Another window size needs no source: the level serves any display
// target; another analysis area is a key miss and rebuilds the source ----
{
  const probe = await convertedPhoto({ sessionBudget: 1 << 30 });
  const budget = bytesOf([probe.proxy, probe.processed, probe.sample]) + 64;
  const { h, c, base, crop, proxy, item } = await convertedPhoto({ sessionBudget: budget });
  wireSwitching(h, [item, { id: 2, file: { name: 'b.dng' }, settings: null }]);
  await c.switchToFile(1);
  await c.switchToFile(0);
  assert.ok(h.state.sourcePending);
  const converted = [];
  h.target.convertFromCurrentSource = async (settings, options) => {
    converted.push(options.preview ? h.state.conversionPreviewImageData : h.state.conversionSourceImageData);
    return makeBase(30, 20, 11);
  };
  // A smaller window: 12 x 8 CSS pixels at DPR 2 fits 24 x 16.
  h.target.getCanvasContainerSize = () => ({ width: 32, height: 28 });
  assert.equal(c.displayProxyMatches(item), true, 'a window size is not a key part');
  await c.processNegative({ quiet: true });
  assert.equal(h.target.baseDecodes, undefined, 'no decode');
  assert.equal(converted.at(-1).__displayOf, proxy, 'the level converts at the new target');
  assert.deepEqual([converted.at(-1).width, converted.at(-1).height], [24, 16], 'a target of the new size');
  h.state.autoFrame.lastDiagnostics = { imageArea: [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.1, y: 0.9 }] };
  assert.equal(c.displayProxyMatches(item), false, 'another analysis area misses');
  h.target.decodeBase = () => base;
  await c.processNegative({ quiet: true });
  assert.equal(h.target.displaySessionDiagnostics.provisional, 1);
  assert.equal(h.target.baseDecodes, 1, 'the exact path decoded');
  samePixels(h.state.conversionSourceImageData, crop, 'and converted the rebuilt source');
}

// ---- Demotion: an evicted Tier A becomes its Tier B form, filed oldest ----
{
  const probe = await convertedPhoto({ sessionBudget: 1 << 30 });
  const tierA = bytesOf([probe.crop, probe.proxy, probe.processed]);
  const tierB = bytesOf([probe.proxy, probe.processed, probe.sample]);
  const budget = tierA + tierB + 64;
  const { h, c, item } = await convertedPhoto({ sessionBudget: budget });
  const other = { id: 9, file: { name: 'z.dng' } };
  h.state.fileQueue = [item, other];
  assert.equal(c.rememberPhotoSession(item), true);
  assert.equal(h.target.photoSessions.get(item).tier, 'A');
  // Another photo's larger session takes the room.
  h.target.photoSessions.put(other, { base: new Uint8Array(tierA) });
  const demoted = h.target.photoSessions.get(item);
  assert.ok(demoted, 'not dropped');
  assert.equal(demoted.tier, 'B', 'demoted to its display form');
  assert.equal(h.target.photoSessions.keys()[0], item, 'filed as the oldest entry');
  assert.ok(h.target.photoSessions.bytes <= budget);
  assert.equal(h.target.displaySessionDiagnostics.demotions, 1);
}

// ---- The spill: a Tier B entry that does not fit is written through the
// worker core and opened again without a decode, the proxy byte-identical ----
{
  const probe = await convertedPhoto({ sessionBudget: 1 << 30 });
  const records = new Map();
  const backend = {
    async put(key, value) { records.set(key, value); }, async get(key) { return records.get(key) || null; },
    async delete(key) { records.delete(key); }, async clear() { records.clear(); }
  };
  const { h, c, base, crop, proxy, sample, item } = await convertedPhoto({ sessionBudget: 1024 });
  h.target.displayProxySpill = createDisplayProxySpill({ port: createDisplayProxyPort({ core: createDisplayProxyWorkerCore({ backend }) }) });
  const itemB = { id: 2, file: { name: 'b.dng' }, settings: null };
  wireSwitching(h, [item, itemB]);
  await c.switchToFile(1);
  assert.equal(h.target.photoSessions.has(item), false, 'too large for RAM');
  await h.target.displayProxySpill.settled();
  assert.equal(h.target.displaySessionDiagnostics.spillWrites, 1);
  assert.equal(h.target.displayProxySpill.has(item.id), true);
  const stored = decodeDisplayProxyRecord(records.values().next().value);
  assert.equal(stored.plane.channels, 3, 'stored as RGB16');
  assert.equal(stored.plane.only16, true, 'a 16-bit level, without an 8-bit plane');
  assert.deepEqual(stored.sample, { ...sample }, 'with the sample');

  let prepared = 0;
  h.target.prepareStudioPhoto = async () => { prepared++; };
  await c.switchToFile(0);
  assert.equal(prepared, 1, 'prepared as a cold open would be');
  assert.equal(h.target.displaySessionDiagnostics.spillHits, 1);
  assert.equal(h.target.baseDecodes, undefined, 'no decode');
  const restored = h.state.displayLevelImageData;
  assert.notEqual(restored, proxy);
  sameLevel(restored, proxy, 'the spilled level is byte-identical, with its geometry');
  assert.equal(h.state.conversionPreviewImageData.__displayOf, restored, 'the conversion preview is a target on it');
  assert.equal(h.state.croppedImageData.released, true);
  assert.equal(h.state.sourcePending.key, h.target.displayProxySpill.proxyKey(item.id));
  assert.deepEqual(c.getColorAnalysisSample(h.state), sample, 'with its sample');
  assert.equal(c.displayProxyMatches(item), true, 'the stored key matches the live photo');
  h.target.decodeBase = () => base;
  assert.equal(await c.ensureSource(), true);
  samePixels(h.state.conversionSourceImageData, crop, 'the source is rebuilt exactly');
  // Queue removal drops it.
  await h.target.displayProxySpill.retain([]);
  assert.equal(records.size, 0);
}

// ---- Eligibility: a recipe without its film-edge read is not a Tier B entry ----
{
  const probe = await convertedPhoto({ sessionBudget: 1 << 30 });
  const budget = bytesOf([probe.proxy, probe.processed, probe.sample]) + 64;
  const { h, c, item } = await convertedPhoto({ sessionBudget: budget, filmEdge: false });
  c.rememberPhotoSession(item);
  assert.notEqual(h.target.photoSessions.get(item)?.tier, 'B', 'a frame whose film edge was never read is not a display session');
  assert.equal(h.target.displaySessionDiagnostics.tierB + h.target.displaySessionDiagnostics.spills, 0);
  // And a frame of 16 MP or less (here: the default threshold) is not either.
  const small = await convertedPhoto({ sessionBudget: budget, largeImagePixels: 16_000_000 });
  small.c.rememberPhotoSession(small.item);
  assert.notEqual(small.h.target.photoSessions.get(small.item)?.tier, 'B');
}

// ---- A decode that differs from the stored base reopens the photo cold ----
{
  const probe = await convertedPhoto({ sessionBudget: 1 << 30 });
  const budget = bytesOf([probe.proxy, probe.processed, probe.sample]) + 64;
  const { h, c, item } = await convertedPhoto({ sessionBudget: budget });
  wireSwitching(h, [item, { id: 2, file: { name: 'b.dng' }, settings: null }]);
  await c.switchToFile(1);
  await c.switchToFile(0);
  let reopened = 0;
  h.target.reactivateReleasedPhoto = () => { reopened++; };
  h.target.decodeBase = () => makeBase(95, 64, 5);
  assert.equal(await c.ensureBase(), null);
  assert.equal(h.target.displaySessionDiagnostics.baseMismatches, 1);
  assert.equal(reopened, 1);
}

// ---- No proxy ever reaches the base, a plane or the conversion source ----
{
  const probe = await convertedPhoto({ sessionBudget: 1 << 30 });
  const records = new Map();
  const backend = {
    async put(key, value) { records.set(key, value); }, async get(key) { return records.get(key) || null; },
    async delete(key) { records.delete(key); }, async clear() { records.clear(); }
  };
  const budget = bytesOf([probe.proxy, probe.processed, probe.sample]) + 64;
  const { h, c, base, proxy, item } = await convertedPhoto({ sessionBudget: budget });
  h.target.displayProxySpill = createDisplayProxySpill({ port: createDisplayProxyPort({ core: createDisplayProxyWorkerCore({ backend }) }) });
  // A level's 16-bit plane is what marks it: the spill's read is adopted
  // into a fresh level object around the same pixels.
  const proxies = new WeakSet([proxy.__image16.data]);
  const isProxy = image => Boolean(image?.__image16 && proxies.has(image.__image16.data));
  for (const key of ['loadedBaseImageData', 'originalImageData', 'croppedImageData', 'conversionSourceImageData']) {
    let value = h.state[key];
    Object.defineProperty(h.state, key, {
      get: () => value,
      set: next => {
        assert.ok(!isProxy(next), `a display proxy was assigned to ${key}`);
        value = next;
      }
    });
  }
  // Every proxy the spill hands back is marked, then the flows run.
  const read = h.target.displayProxySpill.get.bind(h.target.displayProxySpill);
  h.target.displayProxySpill.get = async (...args) => {
    const stored = await read(...args);
    if (stored) proxies.add(stored.image.__image16.data);
    return stored;
  };
  wireSwitching(h, [item, { id: 2, file: { name: 'b.dng' }, settings: null }]);
  h.target.convertFromCurrentSource = async () => makeBase(30, 20, 11);
  h.target.prepareStudioPhoto = async () => { await c.processNegative({ quiet: true }); };
  await c.switchToFile(1);
  await c.switchToFile(0);            // Tier B from RAM
  await c.processNegative({ quiet: true });
  h.target.photoSessions = createPhotoSessionCache({ maxBytes: 16 });
  await c.switchToFile(1);            // spilled
  await h.target.displayProxySpill.settled();
  await c.switchToFile(0);            // from the spill
  h.target.decodeBase = () => base;
  await c.ensureSource();
  await settle();
  assert.ok(isProxy(h.state.displayLevelImageData), 'the proxy stayed the display level only');
}

// ---- Fill parity: a proxy filled from a lane's or roll analysis' decode is
// the display level a cold open's processNegative builds (tilted, mirrored,
// right-angle and plain crops), with getColorAnalysisSample's sample; the
// first open finds its key. Lens-corrected frames are skipped ----
{
  const { sampleAnalysisArea } = await import('./analysisRegion.js');
  const geometries = [
    { rotationAngle: 1.3, mirrored: false, cropRegion: { left: 9, top: 7, width: 96, height: 60 } },
    { rotationAngle: -0.7, mirrored: true, cropRegion: { left: 5, top: 4, width: 100, height: 66 } },
    { rotationAngle: 90, mirrored: false, cropRegion: { left: 3, top: 6, width: 70, height: 100 } },
    { rotationAngle: 0, mirrored: true, cropRegion: { left: 10, top: 10, width: 90, height: 60 } },
    { rotationAngle: 0, mirrored: false, cropRegion: { left: 12, top: 8, width: 88, height: 58 } }
  ];
  for (const geometry of geometries) {
    const base = makeBase(120, 80, 21);
    const h = createHarness(base, { sessionBudget: 1 << 30 }), c = h.context;
    const records = new Map();
    const backend = {
      async put(key, value) { records.set(key, value); }, async get(key) { return records.get(key) || null; },
      async delete(key) { records.delete(key); }, async clear() { records.clear(); }
    };
    h.target.displayProxySpill = createDisplayProxySpill({ port: createDisplayProxyPort({ core: createDisplayProxyWorkerCore({ backend }) }) });
    h.target.largeImagePixels = 1000;
    // These small frames stand in for large ones: a level of k = 2.
    h.target.displayLevelFactor = () => 2;
    const item = { id: 7, file: { name: 'roll-07.dng' }, settings: { ...geometry, autoFrameMeta: { imageArea: AREA }, filmEdge: { checked: true } } };
    h.state.fileQueue = [{ id: 1, file: { name: 'open.dng' } }, item];
    h.state.currentFileIndex = 0;
    const shape = { width: 120, height: 80, has16: true, route: 'libraw16' };
    const planned = c.displayProxyFillPlan(item, shape, item.settings);
    assert.equal(planned.kept, false, 'a fill is planned from the size alone (#252 held frames)');
    assert.equal(await c.fillDisplayProxy(item, base, item.settings), true, `filled ${JSON.stringify(geometry)}`);
    assert.equal(h.target.displaySessionDiagnostics.fills, 1);
    const again = c.displayProxyFillPlan(item, shape, item.settings);
    assert.equal(again.proxyKey, planned.proxyKey);
    assert.equal(again.proxyKey, h.target.displayProxySpill.proxyKey(item.id), 'the planned key is the one the fill kept');
    assert.equal(again.kept, true, 'then kept: a held frame is not asked for its planes again');
    const stored = await h.target.displayProxySpill.get(item.id);
    // What processNegative builds on a cold open: the display level of the
    // (lens-free) conversion source, whatever the window.
    const source = exportChain(base, geometry);
    const expected = buildDisplayLevel(source, 2);
    const entry = c.spilledDisplayEntry(item, stored);
    sameLevel(entry.planes.level, expected, `fill parity ${JSON.stringify(geometry)}`);
    assert.deepEqual(stored.sample, { ...sampleAnalysisArea(base, AREA) }, 'the sample getColorAnalysisSample reads');
    // The first open: the spilled entry installs, the recipe restores and the key matches.
    h.state.loadedBaseImageData = null;
    Object.assign(h.state, { loadedFile: item.file, baseDescriptor: entry.baseDescriptor, sourcePending: entry.sourcePending,
      originalImageData: entry.planes.frame, croppedImageData: entry.planes.crop, displayLevelImageData: entry.planes.level,
      conversionSourceImageData: null, currentFileIndex: 1 });
    h.target.getCurrentQueueItem = () => item;
    h.state.autoFrame.lastDiagnostics = { imageArea: AREA };
    c.restoreSettings(item.settings);
    assert.equal(h.state.geometryPending, false, 'the recipe geometry is the proxy geometry');
    assert.equal(c.displayProxyMatches(item), true, `the open finds the proxy ${JSON.stringify(geometry)}`);
  }
  // Lens correction and repairs are not filled; nor is an 8-bit fallback decode.
  const base = makeBase(120, 80, 21);
  const h = createHarness(base, { sessionBudget: 1 << 30 }), c = h.context;
  h.target.displayProxySpill = createDisplayProxySpill({ port: createDisplayProxyPort({ core: createDisplayProxyWorkerCore({ backend: { async put() {}, async get() { return null; }, async delete() {}, async clear() {} } }) }) });
  h.target.largeImagePixels = 1000;
  h.target.displayLevelFactor = () => 2;
  const item = { id: 8, file: { name: 'x.dng' }, settings: { ...geometries[0], autoFrameMeta: { imageArea: AREA }, filmEdge: { checked: true } } };
  h.state.fileQueue = [item];
  h.target.lensCorrectionActive = () => true;
  assert.equal(await c.fillDisplayProxy(item, base, item.settings), false, 'lens-corrected frames are skipped');
  assert.equal(c.displayProxyFillPlan(item, { width: 120, height: 80, has16: true, route: 'libraw16' }, item.settings).skip, true,
    'and planned as skipped');
  h.target.lensCorrectionActive = () => false;
  assert.equal(await c.fillDisplayProxy(item, base, { ...item.settings, repairStrokes: [{}] }), false, 'repaired frames are skipped');
  const eight = makeBase(120, 80, 21);
  delete eight.__image16;
  assert.equal(await c.fillDisplayProxy(item, eight, item.settings), false, 'an 8-bit RAW fallback is not reproducible');
  assert.equal(c.displayProxyFillPlan(item, c.displayProxyShape(item, eight), item.settings).skip, true);
  assert.equal(await c.fillDisplayProxy(item, base, { ...item.settings, filmEdge: null }), false, 'undecided recipes are skipped');
  h.target.displayLevelFactor = () => 1;
  assert.equal(await c.fillDisplayProxy(item, base, item.settings), false, 'a frame that is its own level needs no proxy');
  // A spilled frame that is its own level (k = 1, a debug threshold) comes back as its plane.
  const plane = makeBase(40, 30, 3);
  const own = c.spilledDisplayEntry(item, { image: plane, sample: null, meta: {
    base: { width: 120, height: 80, has16: true, route: 'libraw16' },
    geometry: { angle: 0, mirrored: false, crop: null, frameWidth: 120, frameHeight: 80 }, cropSize: null,
    source: { width: 40, height: 30 }, area: null, level: { sourceWidth: 40, sourceHeight: 30, k: 1 }, rawMetadata: null, filmEdge: null
  } }, { proxyKey: 'own' });
  assert.equal(own.planes.level, plane, 'a k = 1 level is the plane itself');
}

// ---- Persistence: a frame filled (or left) in one session opens from the
// store in the next, keyed by its content, with no decode ----
{
  const records = new Map();
  const memoryRecords = {
    async write(name, record) { records.set(name, new Uint8Array(record instanceof ArrayBuffer ? record : record.buffer).slice()); },
    async read(name) { return records.has(name) ? records.get(name).slice().buffer : null; },
    async delete(name) { records.delete(name); }, async clear() { records.clear(); },
    async list() { return [...records].map(([name, bytes]) => ({ name, bytes: bytes.byteLength, modifiedMs: 0 })); }
  };
  const geometry = { rotationAngle: 1.3, mirrored: false, cropRegion: { left: 9, top: 7, width: 96, height: 60 } };
  const bytes = new Uint8Array(300_000).map((_, i) => (i * 7) & 255);
  const makeFile = () => Object.assign(new Blob([bytes]), { name: 'roll-07.dng', lastModified: 1234 });
  const session = (file) => {
    const base = makeBase(120, 80, 21);
    const h = createHarness(base, { sessionBudget: 1 << 30 }), c = h.context;
    Object.assign(h.target, {
      largeImagePixels: 1000, displayLevelFactor: () => 2,
      hashFileForProject: async blob => sha256Hex(new Uint8Array(await blob.slice(0, 1 << 20).arrayBuffer())), displayProxyFileKey, sha256Hex,
      displayProxyStore: createDisplayProxyStore({
        port: createDisplayProxyPort({ core: createDisplayProxyWorkerCore({ backend: null }) }), records: memoryRecords,
        availableBytes: async () => 64 * 1024 ** 3
      })
    });
    const item = { id: 'roll-07::1', file, settings: { ...geometry, autoFrameMeta: { imageArea: AREA }, filmEdge: { checked: true } } };
    return { h, c, base, item };
  };
  // Session 1: roll analysis fills the frame while it is not open.
  {
    const { h, c, base, item } = session(makeFile());
    h.state.fileQueue = [{ id: 'open', file: { name: 'open.dng' } }, item];
    h.state.currentFileIndex = 0;
    assert.equal(await c.fillDisplayProxy(item, base, item.settings), true);
    await h.target.displayProxyStore.settled();
    assert.equal(h.target.displaySessionDiagnostics.fills, 1);
    assert.equal(h.target.displayProxySpill.has(item.id), false, 'the store took it: no second copy in the spill');
  }
  // Session 2 (a restart or a project reopen): new queue items, same file.
  {
    const { h, c, base, item } = session(makeFile());
    const other = { id: 'b', file: { name: 'b.dng' }, settings: null };
    h.state.loadedFile = other.file;
    wireSwitching(h, [other, item]);
    let prepared = 0;
    h.target.prepareStudioPhoto = async () => { prepared++; };
    await c.switchToFile(1);
    assert.equal(prepared, 1);
    assert.equal(h.target.displaySessionDiagnostics.storeHits, 1, 'opened from the store');
    assert.equal(h.target.baseDecodes, undefined, 'no decode');
    const source = exportChain(base, geometry);
    sameLevel(h.state.displayLevelImageData, buildDisplayLevel(source, 2), 'the stored proxy is the cold open\'s display level');
    h.state.autoFrame.lastDiagnostics = { imageArea: AREA };
    assert.equal(c.displayProxyMatches(item), true, 'processNegative converts it');
    // A window size is not part of the key: another window opens it too.
    const again = session(makeFile());
    again.h.target.getCanvasContainerSize = () => ({ width: 90, height: 70 });
    again.h.state.loadedFile = other.file;
    wireSwitching(again.h, [other, again.item]);
    again.h.target.prepareStudioPhoto = async () => {};
    await again.c.switchToFile(1);
    assert.equal(again.h.target.displaySessionDiagnostics.storeHits, 1, 'another window hits');
    // Another recipe geometry is another key: the photo opens from its original.
    const moved = session(makeFile());
    moved.item.settings = { ...moved.item.settings, cropRegion: { left: 10, top: 7, width: 96, height: 60 } };
    moved.h.state.loadedFile = other.file;
    wireSwitching(moved.h, [other, moved.item]);
    await moved.c.switchToFile(1);
    assert.equal(moved.h.target.displaySessionDiagnostics.storeHits, 0, 'a geometry mismatch misses');
    // A changed file (another date) is not a candidate.
    const changed = session(Object.assign(new Blob([bytes]), { name: 'roll-07.dng', lastModified: 9999 }));
    assert.equal(await changed.c.readStoredDisplaySession(changed.item), null);
  }
}

console.log('displaySessions: Tier A, Tier B, demotion, spill, ensureBase/ensureSource, invalidation and the proxy invariant passed');
