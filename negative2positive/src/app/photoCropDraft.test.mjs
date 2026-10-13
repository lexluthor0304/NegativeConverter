import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { capturePhotoCropDraftState, photoCropDraftMatches, restorePhotoCropDraftState } from './photoCropDraft.js';

const geometry = { rotationAngle: 90, mirrored: true, cropRegion: { left: 10, top: 20, width: 400, height: 600 } };
const draft = {
  sourceImageData: { data: new Uint8Array(64) }, view: { surface: {} },
  rect: { left: 40, top: 80, width: 200, height: 360 }, rotatedSize: { width: 400, height: 800 },
  rotationBase: 90, straightenAngle: 2.5, straightenLineAngles: [2, 3],
  analysisOnly: false, ratioOrientation: 'portrait'
};
const ratioChoice = { id: 'free', orientation: 'portrait' };
const saved = capturePhotoCropDraftState(draft, geometry, ratioChoice);
assert.equal('sourceImageData' in saved, false);
assert.equal('view' in saved, false);
assert.equal(JSON.stringify(saved).includes('data'), false, 'no image buffers or canvases are retained');
draft.straightenLineAngles.push(99);
ratioChoice.id = '135';
assert.deepEqual(saved.straightenLineAngles, [2, 3]);
assert.equal(saved.ratioChoice.id, 'free');
assert.equal(photoCropDraftMatches(saved, { ...geometry, coreExposure: 25 }), true, 'colour changes do not discard a crop draft');
for (const changed of [{ rotationAngle: 0 }, { mirrored: false }, { cropRegion: null }, { cropRegion: { ...geometry.cropRegion, left: 11 } }]) {
  assert.equal(photoCropDraftMatches(saved, { ...geometry, ...changed }), false, 'changed geometry cannot reuse old draft coordinates');
}
const resumed = { rotatedSize: { width: 200, height: 400 }, sourceImageData: 'new source', view: 'new view' };
assert.equal(restorePhotoCropDraftState(resumed, saved, geometry), true);
assert.deepEqual(resumed.rect, { left: 20, top: 40, width: 100, height: 180 });
assert.equal(resumed.sourceImageData, 'new source');
assert.equal(resumed.view, 'new view');
assert.equal(resumed.rotationBase, 90);
assert.equal(resumed.straightenAngle, 2.5);
assert.equal(resumed.ratioOrientation, 'portrait');
assert.equal(restorePhotoCropDraftState(resumed, saved, { ...geometry, mirrored: false }), false);

// Exercise the real navigation helpers with a geometry job held across a
// second switch. A late resume must not open A's draft over B.
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const functionSource = name => {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source)?.index;
  assert.notEqual(start, undefined);
  return source.slice(start, source.indexOf('\n    }', start) + 6);
};
const itemA = { file: {} }, itemB = { file: {} }, opened = [];
let current = itemA, generation = 1, settle;
const context = vm.createContext({
  state: { loadedFile: itemA.file, currentStep: 3, cropping: true, cropDraft: draft, geometryPending: false },
  cropRatioChoice: saved.ratioChoice, photoCropDrafts: new WeakMap(),
  capturePhotoCropDraftState, photoCropDraftMatches, restorePhotoCropDraftState,
  extractCurrentSettings: () => geometry, getCurrentQueueItem: () => current,
  isCurrentLoad: value => value === generation, loadGeneration: generation,
  warmUpAutoFrameWorker() {},
  openCropMode: options => { opened.push(options.resume); context.photoCropDrafts.delete(current); },
  whenGeometrySettled: () => new Promise(resolve => { settle = resolve; })
});
vm.runInContext(['rememberPhotoCropDraft', 'resumePhotoCropDraft', 'beginCropMode'].map(functionSource).join('\n'), context);
context.rememberPhotoCropDraft(itemB);
assert.equal(context.photoCropDrafts.has(itemB), false, 'only the loaded photo owns the draft');
context.rememberPhotoCropDraft(itemA);
context.state.cropping = false;
context.state.geometryPending = true;
const pending = context.resumePhotoCropDraft(itemA, generation);
current = itemB; generation++; context.loadGeneration = generation;
context.state.loadedFile = itemB.file;
settle(true); await pending;
assert.equal(opened.length, 0, 'a superseded resume never opens a crop tool on the new photo');
assert.equal(context.photoCropDrafts.has(itemA), true, 'a superseded attempt retains A for its next visit');
await context.resumePhotoCropDraft(itemA, generation);
assert.equal(opened.length, 0, 'a current generation still cannot resume another photo');
current = itemA; context.state.loadedFile = itemA.file; context.state.geometryPending = false;
await context.resumePhotoCropDraft(itemA, generation);
assert.equal(opened.length, 1);
assert.equal(context.photoCropDrafts.has(itemA), false, 'the active draft takes ownership back');
console.log('photoCropDraft: scalar-only drafts, geometry ownership, resized views and superseded navigation passed');
