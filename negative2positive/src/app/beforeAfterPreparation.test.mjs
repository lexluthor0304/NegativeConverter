import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function fn(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, name);
  return source.slice(match.index, source.indexOf('\n    }', match.index) + 6);
}
const noop = () => {};
const target = { width: 30, height: 20, __displayOf: {} };
const state = { currentStep: 3, conversionPreviewImageData: target, conversionSourceImageData: {} };
const timers = [], requests = [], shown = [];
let inline = 0;
const c = vm.createContext({
  state, beforeAfterBuiltReference: null, beforeAfterCanvasSource: null,
  beforeAfterCanvas: { style: { display: 'none' } }, beforeAfterBtn: null,
  displayViewportPending: false, setTimeout: callback => timers.push(callback),
  isDisplayTarget: image => Boolean(image?.__displayOf), previewRequestImage: image => ({ image }),
  buildRouterSettings: () => ({}), getColorAnalysisSample: () => null,
  convertPreviewFrameInWorker: { displayNegative: request => new Promise((resolve, reject) => requests.push({ request, resolve, reject })) },
  displayNegativeOfTarget: () => { inline++; return { width: 30, height: 20 }; },
  canActivateBeforeAfter: () => true, isReleasedPlane: () => false,
  supersedeSettledDisplay: noop, updateSprocketControlsUI: noop, syncBrushTools: noop,
  showBeforeAfterReference: image => { if (!image) return false; shown.push(image); c.beforeAfterCanvas.style.display = 'block'; return true; },
  renderHistogram: noop,
});
vm.runInContext(['prepareBeforeAfterReference', 'getBeforeAfterReferenceImageData', 'enterBeforeAfter', 'exitBeforeAfter', 'releaseBeforeAfterCanvas'].map(fn).join('\n'), c);
const settle = () => new Promise(setImmediate);

c.enterBeforeAfter();
assert.equal(state.beforeAfterActive, true, 'an early press records intent');
assert.equal(inline, 0, 'no input-path resample');
assert.equal(timers.length, 1, 'one preparation per target');
const first = timers.shift()();
c.exitBeforeAfter();
requests[0].resolve({ width: 30, height: 20, __image16: {} });
await first;
assert.equal(shown.length, 0, 'exit before reply prevents a late comparison');
assert.equal(c.beforeAfterBuiltReference.image.__image16, undefined, 'only the 8-bit negative stays cached');
c.enterBeforeAfter();
assert.equal(shown.length, 1);
assert.equal(inline, 0, 'cached entry never resamples');
assert.equal(timers.length, 0);
c.exitBeforeAfter();

c.releaseBeforeAfterCanvas();
c.enterBeforeAfter();
const abandoned = timers.shift()();
c.exitBeforeAfter();
c.releaseBeforeAfterCanvas();
state.conversionPreviewImageData = { ...target };
c.enterBeforeAfter();
const current = timers.shift()();
requests[1].resolve({ width: 30, height: 20 });
await abandoned;
assert.equal(shown.length, 1, 'an old photo reply cannot cover the current photo');
const negative = { width: 30, height: 20 };
requests[2].resolve(negative);
await current;
assert.ok(shown.at(-1) === negative, 'an early press shows the current reply');
c.exitBeforeAfter();
c.releaseBeforeAfterCanvas();
c.enterBeforeAfter();
const fallback = timers.shift()();
assert.equal(inline, 0);
requests[3].reject(Error('worker unavailable'));
await fallback;
assert.equal(inline, 1, 'fallback remains available outside the press');
await settle();
console.log('beforeAfterPreparation: cached and early presses, delayed exit, source replacement and deferred fallback passed');
