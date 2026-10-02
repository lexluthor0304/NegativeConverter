import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { displaySessionStubs, DISPLAY_SESSION_HELPERS } from './displaySessionHarness.mjs';

// scheduleSemanticColour must decide before the 512 px downsample and the
// model worker whether its answer could be used at all (#236 part 5).
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  const end = source.indexOf('\n    }', match.index);
  return source.slice(match.index, end + 6);
}

function run({ filmType = 'color', positiveMode = 'correct', expiredEnabled = false, rollPending = false, wbSample = null } = {}) {
  const item = { id: 1 };
  const downsamples = [];
  const analyses = [];
  const timers = [];
  const state = {
    filmType, positiveMode, expiredEnabled, wbUserOverride: false, grayPointSampled: false,
    rollReference: { applyLock: false }, filmBase: { method: 'auto' },
    processedImageData: { width: 8, height: 8 }, conversionSourceImageData: { width: 80, height: 80 }, autoWbSample: null
  };
  if (wbSample) state.autoWbSample = { source: wbSample === 'stale' ? {} : state.conversionSourceImageData, image: { width: 16, height: 16 } };
  const context = vm.createContext({
    // #249: no photo here takes a display form.
    ...displaySessionStubs(),
    state, console, manualEditRevision: 0, studioAutoFrameRunning: false, automaticRollImportRunning: false,
    semanticColourInFlight: 0,
    automaticRollPendingItems: new Set(rollPending ? [item] : []),
    isCurrentLoad: () => true, getCurrentQueueItem: () => item,
    downsampleImageDataForMaxDim: image => { downsamples.push(image); return image; },
    analyzeSemanticPreview: async image => { analyses.push(image); return null; },
    sanitizeSemanticMap: map => map,
    setTimeout: fn => timers.push(fn),
  });
  vm.runInContext([...DISPLAY_SESSION_HELPERS, 'autoWbSampleFor', 'expiredInterpretation', 'scheduleSemanticColour'].map(functionSource).join('\n'), context);
  context.scheduleSemanticColour(item, 1);
  return { item, downsamples, analyses, timers, state };
}

for (const [label, options] of [
  ['B&W film', { filmType: 'bw' }],
  ['a positive in correct mode', { filmType: 'positive', positiveMode: 'correct' }],
  ['a positive in edit mode', { filmType: 'positive', positiveMode: 'edit' }],
  ['a frame a roll analysis will prepare', { rollPending: true }],
]) {
  const result = run(options);
  assert.equal(result.downsamples.length, 0, `${label}: no 512 px downsample`);
  assert.equal(result.timers.length, 0, `${label}: no semantic worker is scheduled`);
  assert.equal(result.item.semanticAttempted, undefined, `${label}: the attempt is not consumed`);
}
for (const [label, options] of [
  ['colour film', {}],
  ['B&W under expired rescue', { filmType: 'bw', expiredEnabled: true }],
]) {
  const result = run(options);
  assert.equal(result.downsamples.length, 1, `${label}: the preview is prepared`);
  assert.equal(result.timers.length, 1, `${label}: the model pass is scheduled`);
  assert.equal(result.item.semanticAttempted, true);
}
// #248: the anchors are estimated on the viewport-independent auto-WB sample
// of this source, and on the frame on screen only without one.
{
  const withSample = run({ wbSample: 'current' });
  assert.equal(withSample.downsamples[0], withSample.state.autoWbSample.image, 'the auto-WB sample feeds the model');
  const stale = run({ wbSample: 'stale' });
  assert.equal(stale.downsamples[0], stale.state.processedImageData, 'a sample of another source is not used');
}
// R1-085: under rescue the map weights the rescue's measurement of the frame
// on screen, so it is estimated on that frame, as at 1703835; only the white
// balance's anchors moved to the viewport-independent sample (#248, flagged).
{
  for (const filmType of ['color', 'bw', 'positive']) {
    const rescued = run({ filmType, expiredEnabled: true, wbSample: 'current' });
    assert.equal(rescued.downsamples[0], rescued.state.processedImageData, `${filmType} under rescue: the frame on screen feeds the model`);
  }
  const colour = run({ wbSample: 'current' });
  assert.equal(colour.downsamples[0], colour.state.autoWbSample.image, 'without rescue the auto-WB sample still feeds it');
}
// Parity with 1703835's scheduleSemanticColour (frozen below): the same image
// reaches the model, and the rescue's measurement reads the same frame with
// the map, for a rescued photo with an auto-WB sample in place.
{
  const reference = `function scheduleSemanticColour(item, generation) {
      if (!item || item.semanticAttempted || item.savedSettings || item.userEdited || state.wbUserOverride || state.grayPointSampled || state.rollReference.applyLock || state.filmBase?.method === 'manual' || (state.filmType === 'positive' && state.positiveMode === 'edit')) return;
      item.semanticAttempted = true;
      const source = state.processedImageData;
      if (!source) return;
      const revision = manualEditRevision;
      const valid = () => isCurrentLoad(generation) && item === getCurrentQueueItem() && revision === manualEditRevision && !state.cropping && !studioAutoFrameRunning && !automaticRollImportRunning && !state.rollFrame?.locked && !state.wbUserOverride && !state.grayPointSampled && !state.rollReference.applyLock && !item.savedSettings;
      // Whole converted preview coordinates are used for both WB and rescue.
      const preview = downsampleImageDataForMaxDim(source, 512);
      setTimeout(async () => {
        try {
          if (!valid()) return;
          const map = sanitizeSemanticMap(await analyzeSemanticPreview(preview, { isCurrent: valid }));
          if (!map || !valid()) return;
          if (state.expiredEnabled) {
            const analysis = await measureExpiredAnalysisForExport(source, { ...state, semanticMap: map, autoFrameMeta: state.autoFrame.lastDiagnostics }, state.loadedBaseImageData || state.originalImageData);
            if (!analysis || !valid()) return;
            pushUndo('semanticColor'); state.semanticMap = map;
            applyExpiredAnalysisDefaults(state, analysis);
            updateExpiredRescueUI();
          } else {
            if (state.filmType !== 'color') return;
            const estimate = estimateAutoWhiteBalance(preview, { anchors: map });
            if (!estimate.anchored || estimate.confidence === 'low') return;
            pushUndo('semanticColor'); state.semanticMap = map;
            state.wbR = estimate.wbR; state.wbG = estimate.wbG; state.wbB = estimate.wbB;
            state.wbSemanticApplied = true;
            state.wbAutoConfidence = estimate.confidence; updateWBSliders(); updateGrayPointGuideUI();
          }
          markCurrentFileDirty(); persistCurrentFileSettings({ force: true, silent: true });
          schedulePreviewUpdate();
        } catch (error) { console.warn('Semantic colour skipped:', error); }
      }, 0);
    }`;
  const rescuePass = async (code, names) => {
    const item = { id: 1 };
    const seen = { model: [], measured: [] };
    const frame = { width: 8, height: 8, data: new Uint8ClampedArray(256) };
    const state = {
      filmType: 'bw', positiveMode: 'correct', expiredEnabled: true, wbUserOverride: false, grayPointSampled: false, cropping: false,
      rollReference: { applyLock: false }, filmBase: { method: 'auto' }, autoFrame: { lastDiagnostics: null },
      processedImageData: frame, conversionSourceImageData: { width: 80, height: 80 }, loadedBaseImageData: { width: 80, height: 80 },
      expiredAnalysis: null, semanticMap: null
    };
    state.autoWbSample = { source: state.conversionSourceImageData, image: { width: 16, height: 16 } };
    const map = { width: 2, height: 2, labels: [0, 0, 1, 1] };
    const context = vm.createContext({
      ...displaySessionStubs(),
      state, console, manualEditRevision: 0, studioAutoFrameRunning: false, automaticRollImportRunning: false,
      semanticColourInFlight: 0, automaticRollPendingItems: new Set(), setTimeout,
      isCurrentLoad: () => true, getCurrentQueueItem: () => item,
      downsampleImageDataForMaxDim: image => ({ of: image }),
      analyzeSemanticPreview: async image => { seen.model.push(image.of); return map; },
      sanitizeSemanticMap: value => value,
      measureExpiredAnalysisForExport: async (image, settings) => { seen.measured.push({ image, map: settings.semanticMap }); return { measured: true }; },
      pushUndo() {}, applyExpiredAnalysisDefaults: (target, analysis) => { target.expiredAnalysis = analysis; },
      updateExpiredRescueUI() {}, markCurrentFileDirty() {}, persistCurrentFileSettings() {}, schedulePreviewUpdate() {}
    });
    vm.runInContext([...names.map(functionSource), code].join('\n'), context);
    context.scheduleSemanticColour(item, 1);
    await new Promise(resolve => setTimeout(resolve, 5));
    return { seen, state, frame, map };
  };
  const current = await rescuePass('', [...DISPLAY_SESSION_HELPERS, 'autoWbSampleFor', 'expiredInterpretation', 'scheduleSemanticColour']);
  const at1703835 = await rescuePass(reference, []);
  assert.equal(current.seen.model[0], current.frame, 'the model reads the frame on screen');
  assert.equal(at1703835.seen.model[0], at1703835.frame);
  assert.deepEqual(current.seen.measured.map(entry => entry.image === current.frame && entry.map === current.map), [true]);
  assert.deepEqual(at1703835.seen.measured.map(entry => entry.image === at1703835.frame && entry.map === at1703835.map), [true]);
  assert.deepEqual([current.state.semanticMap, current.state.expiredAnalysis], [current.map, { measured: true }], 'the map and the measurement are stored');
  assert.deepEqual([at1703835.state.semanticMap, at1703835.state.expiredAnalysis], [at1703835.map, { measured: true }]);
}
console.log('semantic colour gate: no worker for B&W, positive or roll-pending frames; colour and rescue keep it; the WB sample feeds it');
console.log('semantic colour gate: under rescue the frame on screen feeds the model and the measurement, as at 1703835 (R1-085)');
