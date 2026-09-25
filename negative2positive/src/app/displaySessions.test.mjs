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
const { resizeDisplayPreview } = await import('./displayPreview.js');
const { createDisplayProxySpill, createDisplayProxyPort, createDisplayProxyWorkerCore } = await import('./displayProxyStore.js');
const { decodeDisplayProxyRecord } = await import('./displayProxy.js');

const settingsFor = state => ({ rotationAngle: state.rotationAngle, mirrored: state.mirrored, cropRegion: state.cropRegion ? { ...state.cropRegion } : null });
const CROP = { left: 10, top: 8, width: 60, height: 40 };
const AREA = [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }];
const bytesOf = images => [...backingBuffers(images)].reduce((sum, buffer) => sum + buffer.byteLength, 0);

// A photo converted as a large frame: its crop is the conversion source, a
// 30x20 display proxy, and the preview conversion of that proxy on screen.
async function convertedPhoto({ sessionBudget, base = makeBase(96, 64, 5), largeImagePixels = 1000, name = 'a.dng', id = 1, filmEdge = true } = {}) {
  const h = createHarness(base, { sessionBudget, realProcessNegative: true }), c = h.context;
  h.target.largeImagePixels = largeImagePixels;
  h.target.usesSilverCoreConversion = () => true;
  h.target.photoSessions = createPhotoSessionCache({ maxBytes: sessionBudget, onEvict: (item, value) => c.demoteDisplaySession(item, value) });
  h.state.autoFrame.lastDiagnostics = { imageArea: AREA, appliedMode: 'crop' };
  c.restoreSettings({ rotationAngle: 1.3, mirrored: false, cropRegion: CROP });
  await h.state.geometryReady;
  const crop = h.state.croppedImageData;
  const proxy = resizeDisplayPreview(crop, { width: 30, height: 20 });
  const processed = makeBase(30, 20, 9);
  Object.assign(h.state, {
    currentStep: 3, conversionSourceImageData: crop, conversionPreviewImageData: proxy, processedImageData: processed,
    previewSourceImageData: processed, histogramSourceImageData: processed, webglSourceImageData: processed,
    processedImageDataIsPreview: true, fullResolutionPending: true
  });
  // The sample the conversion read, cached for the base as getColorAnalysisSample does.
  const sample = c.getColorAnalysisSample(h.state);
  assert.ok(sample?.data, 'the colour-analysis sample of the image area');
  // The viewport the proxy was built for (getDisplayPreviewSize's inputs).
  h.target.getDisplayPreviewSize = image => h.target.displayPreviewSize(image.width, image.height, { viewportWidth: 30, viewportHeight: 20 });
  h.target.getCanvasContainerSize = () => ({ width: 50, height: 40 });
  h.target.previewTierMaxPixels = () => 600;
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
    converted.push(options.preview ? h.state.conversionPreviewImageData : h.state.conversionSourceImageData);
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
    assert.equal(converted.at(-1), proxy, 'the proxy converted');
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
  assert.equal(entry.snapshot.refs.conversionPreviewImageData, proxy, 'the display proxy');
  assert.equal(entry.sample, sample, 'the colour-analysis sample');
  assert.ok(entry.undo.every(snapshot => snapshot.refs.cold));
  assert.ok(h.target.photoSessions.bytes <= budget);

  await c.switchToFile(0);
  assert.equal(h.state.processedImageData, processed, 'the settled preview in the same task');
  assert.equal(h.state.conversionSourceImageData, null);
  assert.equal(h.state.conversionPreviewImageData, proxy);
  assert.equal(h.state.sourcePending.width, crop.width);
  assert.equal(h.target.baseDecodes, undefined, 'no decode');
  assert.equal(h.target.document.body.dataset.photoSwitching, undefined, 'an in-RAM Tier B hit shows no veil');
  assert.equal(c.hasSeparateConversionPreview(), true, 'export still owes the full-resolution frame');
  assert.equal(c.getColorAnalysisSample(h.state), sample, 'conversions read the kept sample');
  assert.deepEqual({ ...h.state.cropRegion }, CROP);

  // The preview half converts the proxy (no decode) while it matches.
  const converted = [];
  h.target.convertFromCurrentSource = async (settings, options) => {
    converted.push({ image: options.preview ? h.state.conversionPreviewImageData : h.state.conversionSourceImageData, options });
    return makeBase(30, 20, 11);
  };
  assert.equal(c.displayProxyMatches(item), true);
  await c.processNegative({ quiet: true });
  assert.equal(converted.at(-1).image, proxy, 'the preview conversion reads the proxy');
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
  assert.equal(h.state.conversionPreviewImageData, proxy, 'the proxy stays the display preview');
  for (let i = 0; i < 40 && !h.target.displaySessionDiagnostics.selfChecks; i++) await settle();
  assert.equal(h.target.displaySessionDiagnostics.selfChecks, 1);
  assert.equal(h.target.displaySessionDiagnostics.selfCheckMismatches, 0);
}

// ---- A viewport change is a key miss: the conversion waits for the source ----
{
  const probe = await convertedPhoto({ sessionBudget: 1 << 30 });
  const budget = bytesOf([probe.proxy, probe.processed, probe.sample]) + 64;
  const { h, c, base, crop, item } = await convertedPhoto({ sessionBudget: budget });
  wireSwitching(h, [item, { id: 2, file: { name: 'b.dng' }, settings: null }]);
  await c.switchToFile(1);
  await c.switchToFile(0);
  assert.equal(h.state.sourcePending !== null, true);
  h.target.getCanvasContainerSize = () => ({ width: 90, height: 60 });
  assert.equal(c.displayProxyMatches(item), false, 'another window size misses');
  h.target.decodeBase = () => base;
  h.target.convertFromCurrentSource = async () => makeBase(30, 20, 11);
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
  assert.equal(stored.plane.data8, undefined, 'without the 8-bit plane');
  assert.deepEqual(stored.sample, { ...sample }, 'with the sample');

  let prepared = 0;
  h.target.prepareStudioPhoto = async () => { prepared++; };
  await c.switchToFile(0);
  assert.equal(prepared, 1, 'prepared as a cold open would be');
  assert.equal(h.target.displaySessionDiagnostics.spillHits, 1);
  assert.equal(h.target.baseDecodes, undefined, 'no decode');
  const restored = h.state.conversionPreviewImageData;
  assert.notEqual(restored, proxy);
  samePixels(restored, proxy, 'the spilled proxy is byte-identical, 8-bit plane included');
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
  const proxies = new WeakSet([proxy]);
  for (const key of ['loadedBaseImageData', 'originalImageData', 'croppedImageData', 'conversionSourceImageData']) {
    let value = h.state[key];
    Object.defineProperty(h.state, key, {
      get: () => value,
      set: next => {
        assert.ok(!proxies.has(next) && !(next && next.__proxyOf), `a display proxy was assigned to ${key}`);
        value = next;
      }
    });
  }
  // Every proxy the spill hands back is marked, then the flows run.
  const read = h.target.displayProxySpill.get.bind(h.target.displayProxySpill);
  h.target.displayProxySpill.get = async (...args) => {
    const stored = await read(...args);
    if (stored) { proxies.add(stored.image); stored.image.__proxyOf = true; }
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
  assert.equal(h.state.conversionPreviewImageData.__proxyOf, true, 'the proxy stayed the display preview only');
}

console.log('displaySessions: Tier A, Tier B, demotion, spill, ensureBase/ensureSource, invalidation and the proxy invariant passed');
