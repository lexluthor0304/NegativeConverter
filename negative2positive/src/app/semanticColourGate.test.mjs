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
  vm.runInContext([...DISPLAY_SESSION_HELPERS, 'autoWbSampleFor', 'scheduleSemanticColour'].map(functionSource).join('\n'), context);
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
console.log('semantic colour gate: no worker for B&W, positive or roll-pending frames; colour and rescue keep it; the WB sample feeds it');
