import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// #261: run the real live-loupe loop from main.js with a scripted camera. Each
// presented camera frame converts at most once, one conversion at a time; the
// raw view converts nothing; the recipe is built once per change (the
// automatic one at most once a second); the worker is released on close and a
// worker failure moves the loupe to the main thread.
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source)?.index;
  assert.notEqual(start, undefined, `${name} exists in main.js`);
  const end = source.indexOf('\n    }', start);
  return source.slice(start, end + '\n    }'.length);
}
const declarations = source.slice(source.indexOf('    const LOUPE_PREVIEW_SIDE = 640;'), source.indexOf('\n    function loupeElement('));
assert.match(declarations, /let loupeWorkerFailed = false;/);

class ImageData {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(setImmediate);

function harness() {
  let clock = 1000;
  const timers = [], frames = [];
  const elements = {};
  const element = (id, extra = {}) => (elements[id] = { id, dataset: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, ...extra });
  const painted = [];
  element('loupeOverlay');
  element('loupeStatus', { textContent: '' });
  element('loupeCaptureBtn', { disabled: false });
  element('liveLoupeCanvas', { width: 0, height: 0, getContext: () => ({ putImageData: image => painted.push(image) }) });
  const video = element('loupeVideo', {
    readyState: 4, videoWidth: 1280, videoHeight: 720, srcObject: {},
    requestVideoFrameCallback(callback) { this.callback = callback; },
    addEventListener() {},
  });
  const grabs = [];
  const surface = { width: 0, height: 0, getContext: () => ({
    drawImage() {},
    getImageData: (x, y, width, height) => {
      const image = new ImageData(new Uint8ClampedArray(width * height * 4), width, height);
      grabs.push(image);
      return image;
    },
  }) };
  const defaults = [];
  const mainThread = [];
  const context = vm.createContext({
    ImageData, console: { warn() {} }, Number, Math, Set, Promise, Infinity, String,
    performance: { now: () => clock },
    document: { getElementById: id => elements[id] || null, createElement: () => surface },
    requestAnimationFrame: callback => frames.push(callback),
    setTimeout: (callback, ms) => timers.push({ callback, ms }),
    state: { currentStep: 1, originalImageData: null, loadedFile: null, expiredEnabled: false },
    manualEditRevision: 0, expiredCompareHeld: false,
    createDefaultSettings: frame => { defaults.push(frame); return { filmType: 'color', auto: defaults.length }; },
    buildAdjustmentSettings: settings => ({ cyan: settings.cyan ?? 0, expiredEnabled: Boolean(settings.expiredEnabled) }),
    buildRouterSettings: (settings, frame) => ({ filmType: settings.filmType, auto: settings.auto, width: frame.width }),
    getLocalizedText: (_key, fallback) => fallback,
    getInterpolatedText: (_key, _values, fallback) => fallback,
    adjustmentLutScratch: {},
    convertAdjustedFrame: async ({ imageData, settings, adjust }) => {
      mainThread.push({ imageData, settings, adjust });
      return { width: imageData.width, height: imageData.height, data: new Uint8ClampedArray(imageData.width * imageData.height * 4) };
    },
    WORKER_UNAVAILABLE: 'WORKER_UNAVAILABLE', WORKER_CRASHED: 'WORKER_CRASHED', WORKER_TIMEOUT: 'WORKER_TIMEOUT',
  });
  vm.runInContext(declarations + '\n'
    + ['loupeElement', 'setLoupeStatus', 'stopLoupeStream', 'loupeRecipe', 'grabLoupeFrame', 'convertLoupeFrame', 'startLoupeFrames'].map(functionSource).join('\n')
    + '\nglobalThis.peek = () => ({ liveLoupe, loupeDebugCounters, loupeWorkerFailed });', context);
  // A worker client whose replies the test releases one by one.
  const requests = [];
  const client = request => {
    const reply = deferred();
    requests.push({ request, ...reply });
    return reply.promise;
  };
  client.disposed = 0;
  client.dispose = () => { client.disposed++; };
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  const stream = { getTracks: () => tracks };
  Object.assign(context.peek().liveLoupe, { stream, running: true, convert: client, track: { getSettings: () => ({ frameRate: 30 }) } });
  const present = async presentedFrames => { video.callback(clock, { presentedFrames }); await tick(); };
  const reply = async (index = requests.length - 1) => {
    const { request, resolve } = requests[index];
    resolve(new ImageData(new Uint8ClampedArray(request.imageData.width * request.imageData.height * 4), request.imageData.width, request.imageData.height));
    await tick();
  };
  return {
    context, video, elements, painted, grabs, defaults, mainThread, requests, client, tracks, timers, frames,
    present, reply, advance: ms => { clock += ms; }, now: () => clock, peek: () => context.peek(),
  };
}

{
  const h = harness();
  h.context.startLoupeFrames();
  assert.equal(h.peek().loupeDebugCounters.pacing, 'video-frame', 'paced by camera frames where the API exists');
  await h.present(1);
  assert.equal(h.requests.length, 1, 'the first camera frame converts');
  assert.equal(h.grabs.length, 1);
  const first = h.requests[0].request;
  assert.equal(first.transfer, true, 'its pixels go to the worker without a copy');
  assert.equal(first.imageData.width, 640, 'at loupe size');
  assert.equal(first.imageData.height, 360);
  assert.deepEqual({ ...first.options }, { preview: true, scratch: true, includeAnalysisPreview: false });
  await h.present(2);
  await h.present(3);
  await h.present(4);
  assert.equal(h.requests.length, 1, 'one conversion in flight; frames arriving meanwhile are not converted');
  await h.reply();
  assert.equal(h.painted.length, 1);
  assert.equal(h.elements.loupeOverlay.dataset.frames, '1');
  assert.equal(h.requests.length, 2, 'when it finishes, the newest frame converts at once');
  assert.equal(h.grabs.length, 2, 'frames 2 and 3 were dropped, never grabbed');
  await h.present(4);
  assert.equal(h.requests.length, 2, 'the same presented frame never converts twice');
  await h.reply();
  assert.equal(h.requests.length, 2, 'nothing new to convert');
  await h.present(5); await h.reply();
  assert.equal(h.elements.loupeOverlay.dataset.frames, '3');
  assert.equal(h.peek().loupeDebugCounters.repeatedFrames, 0);

  // The automatic recipe follows the camera once a second, not every frame.
  assert.equal(h.defaults.length, 1, 'createDefaultSettings ran for the first frame only');
  assert.ok(h.requests.every(entry => entry.request.recipe === h.requests[0].request.recipe), 'one recipe object for all of them');
  h.advance(999);
  await h.present(6); await h.reply();
  assert.equal(h.defaults.length, 1);
  h.advance(1);
  await h.present(7); await h.reply();
  assert.equal(h.defaults.length, 2, 'refreshed after a second');
  assert.notEqual(h.requests.at(-1).request.recipe, h.requests.at(-2).request.recipe);
  assert.equal(h.requests.at(-1).request.settings.auto, 2, 'with the new frame\'s film type and base');

  // Show raw: neither grab nor convert; back to converted: at once.
  const grabs = h.grabs.length, requests = h.requests.length;
  h.peek().liveLoupe.view = 'raw';
  for (const frame of [8, 9, 10]) await h.present(frame);
  assert.equal(h.grabs.length, grabs, 'the raw view grabs nothing');
  assert.equal(h.requests.length, requests, 'and converts nothing');
  assert.equal(h.elements.loupeOverlay.dataset.frames, '5', 'so the frame counter stops');
  h.peek().liveLoupe.view = 'converted';
  h.peek().liveLoupe.wake();
  await tick();
  assert.equal(h.requests.length, requests + 1, 'leaving the raw view converts the newest frame without waiting');
  await h.reply();
  assert.equal(h.elements.loupeOverlay.dataset.frames, '6');

  // A converted photo: its recipe is built once and follows every edit.
  Object.assign(h.context.state, { currentStep: 3, originalImageData: {}, loadedFile: { name: 'a.png' }, cyan: 0 });
  await h.present(11); await h.reply();
  const photoRecipe = h.requests.at(-1).request.recipe;
  assert.equal(photoRecipe.name, 'a.png');
  assert.equal(h.defaults.length, 2, 'a photo recipe needs no automatic defaults');
  await h.present(12); await h.reply();
  assert.equal(h.requests.at(-1).request.recipe, photoRecipe, 'reused while nothing changed');
  h.context.state.cyan = 7;
  h.context.manualEditRevision++;
  await h.present(13); await h.reply();
  const edited = h.requests.at(-1).request.recipe;
  assert.notEqual(edited, photoRecipe, 'an edit (C key, panel input, undo) rebuilds it on the next frame');
  assert.equal(edited.adjust.cyan, 7);
  h.context.state.expiredEnabled = true;
  h.context.manualEditRevision++;
  await h.present(14); await h.reply();
  assert.equal(h.requests.at(-1).request.recipe.adjust.expiredEnabled, true);
  h.context.expiredCompareHeld = true;
  await h.present(15); await h.reply();
  assert.equal(h.requests.at(-1).request.recipe.adjust.expiredEnabled, false, '"hold to see before" shows the unrescued frame');
  h.context.state.loadedFile = { name: 'b.png' };
  await h.present(16); await h.reply();
  assert.equal(h.requests.at(-1).request.recipe.name, 'b.png', 'another photo is another recipe');
  assert.equal(h.elements.loupeOverlay.attributes['data-recipes'], String(h.peek().loupeDebugCounters.recipes));

  // A worker failure moves the loupe to the main thread for the session.
  await h.present(17);
  const failed = h.requests.at(-1);
  failed.reject(Object.assign(new Error('Conversion worker crashed'), { code: 'WORKER_CRASHED' }));
  await tick(); await tick();
  assert.equal(h.peek().loupeWorkerFailed, true);
  assert.equal(h.client.disposed, 1, 'the broken worker is released');
  assert.equal(h.peek().liveLoupe.convert, null);
  await h.present(18); await tick();
  assert.equal(h.mainThread.length, 1, 'the next frame converts on the main thread');
  assert.equal(h.elements.loupeOverlay.dataset.frames, String(h.painted.length), 'and the loupe keeps showing frames');
  assert.equal(h.mainThread[0].settings, h.requests.at(-1).request.settings, 'with the same recipe');

  // Closing stops the tracks and releases the worker; late callbacks do nothing.
  h.peek().liveLoupe.convert = h.client;
  h.context.stopLoupeStream();
  assert.ok(h.tracks.every(track => track.stopped));
  assert.equal(h.client.disposed, 2, 'no loupe worker outlives the loupe');
  assert.equal(h.peek().liveLoupe.convert, null);
  const before = h.grabs.length;
  h.video.callback(h.now(), { presentedFrames: 19 });
  await tick();
  assert.equal(h.grabs.length, before);
}
console.log('liveLoupe: one conversion per presented camera frame, newest after a busy one, raw view idle, recipe per change, worker release and fallback');

// A released worker (closing mid-conversion) is not a worker failure.
{
  const h = harness();
  h.context.startLoupeFrames();
  await h.present(1);
  const pending = h.requests[0];
  h.context.stopLoupeStream();
  pending.reject(Object.assign(new Error('Conversion worker was released'), { code: 'WORKER_CRASHED' }));
  await tick(); await tick();
  assert.equal(h.peek().loupeWorkerFailed, false, 'the next loupe still uses a worker');
}

// No video-frame callback within 200 ms (an engine that skips the invisible
// video): pace by display frames at the camera's rate instead.
{
  const h = harness();
  h.video.requestVideoFrameCallback = () => {};
  h.context.startLoupeFrames();
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 200);
  h.timers[0].callback();
  assert.equal(h.peek().loupeDebugCounters.pacing, 'display');
  let now = 0;
  const step = async () => { now += 1000 / 60; const callback = h.frames.shift(); callback(now); await tick(); };
  for (let i = 0; i < 12; i++) {
    await step();
    if (h.requests.length && h.requests.at(-1).pending !== false) { await h.reply(); h.requests.at(-1).pending = false; }
  }
  assert.ok(h.requests.length >= 5 && h.requests.length <= 7, `a 30 fps camera on a 60 Hz display converts every second display frame (${h.requests.length} of 12)`);
}
{
  const h = harness();
  h.video.requestVideoFrameCallback = undefined;
  h.context.startLoupeFrames();
  assert.equal(h.peek().loupeDebugCounters.pacing, 'display', 'engines without the API pace by display frames');
  assert.equal(h.frames.length, 1);
}
console.log('liveLoupe: display-frame pacing at the camera rate when video-frame callbacks are missing');

// Opening in the persisted raw view announces Live without grabbing pixels.
// Its visible-video callbacks cannot satisfy the later opacity-0 watchdog.
{
  const h = harness();
  h.peek().liveLoupe.view = 'raw';
  h.elements.loupeStatus.textContent = 'Starting camera…';
  h.context.startLoupeFrames();
  await h.present(1);
  assert.match(h.elements.loupeStatus.textContent, /^Live · 1280×720 · recipe: automatic$/);
  assert.equal(h.grabs.length, 0);
  h.timers[0].callback();
  assert.equal(h.peek().loupeDebugCounters.pacing, 'video-frame');
  h.peek().liveLoupe.view = 'converted';
  h.peek().liveLoupe.wake();
  assert.equal(h.timers.at(-1).ms, 200);
  h.timers.at(-1).callback();
  assert.equal(h.peek().loupeDebugCounters.pacing, 'display', 'raw callbacks do not hide a frozen converted view');
  await h.reply();
}
{
  const h = harness();
  h.context.startLoupeFrames();
  await h.present(1); await h.reply();
  h.peek().liveLoupe.view = 'converted';
  h.peek().liveLoupe.wake();
  await h.present(2); await h.reply();
  h.timers.at(-1).callback();
  assert.equal(h.peek().loupeDebugCounters.pacing, 'video-frame', 'a new callback satisfies the re-armed watchdog');
}

// The smoke can pause the periodic refresh to prove edit-revision invalidation.
{
  const h = harness();
  Object.assign(h.context.state, { currentStep: 3, originalImageData: {}, loadedFile: { name: 'photo.png' }, cyan: 0 });
  vm.runInContext('loupeRecipeRefreshPaused = true;', h.context);
  h.context.startLoupeFrames();
  await h.present(1); await h.reply();
  const recipe = h.requests.at(-1).request.recipe;
  h.advance(2000);
  await h.present(2); await h.reply();
  assert.equal(h.requests.at(-1).request.recipe, recipe, 'periodic refresh cannot satisfy the smoke edit check');
  h.context.state.cyan = 7;
  h.context.manualEditRevision++;
  await h.present(3); await h.reply();
  assert.equal(h.requests.at(-1).request.recipe.adjust.cyan, 7);
}
