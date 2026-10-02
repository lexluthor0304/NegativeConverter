// #259 Part 3, AI on: after a dust-brush stroke only the MI-GAN tiles over the
// stroke's rect are inferred again (not every dust tile), only that rect is
// written back, the newest stroke's history entry is amended, and a refresh
// that a newer change overtook is dropped with its rects kept queued.
// Runs the real functions from main.js with a counting stand-in model.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { inpaintWithModel, maskBoundingBoxes, tilesForBox, uniqueTiles, TILE, CONTEXT } from './aiInpaint.js';
import { amendDustDelta, applyDustDelta, copyImageRect, pasteImageRect } from './dustStrokeHistory.js';
import { createRepairStamps } from './repairReuse.js';

globalThis.ImageData ||= class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source)?.index;
  assert.notEqual(start, undefined, `${name} exists in main.js`);
  const end = source.indexOf('\n    }', start);
  return source.slice(start, end + '\n    }'.length);
}

const width = 3000, height = 2000;
function frame(fill) {
  const image = new ImageData(new Uint8ClampedArray(width * height * 4).fill(fill), width, height);
  image.__image16 = { width, height, data: new Uint16Array(width * height * 4).fill(fill * 257) };
  return image;
}
const clean = frame(100);
const repaired = frame(100);
const mask = new Uint8Array(width * height);
const disc = (cx, cy, r) => {
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) mask[y * width + x] = 255;
  }
};
// Dust all over the frame: a whole-mask pass needs many tiles.
for (let y = 150; y < height; y += 400) for (let x = 150; x < width; x += 450) disc(x, y, 4);
const wholeMaskTiles = uniqueTiles(maskBoundingBoxes(mask, width, height)
  .flatMap(box => tilesForBox(box, width, height, { tile: TILE }))).length;

// An AI-brush stroke's repair mask, a disc beside the speck at (1050, 550).
const strokeMask = new Uint8Array(width * height);
for (let y = 535; y < 565; y++) for (let x = 1055; x < 1066; x++) strokeMask[y * width + x] = 255;

function setup({ strokes = [] } = {}) {
  let runs = 0;
  const state = {
    dustRemoval: { enabled: true, mask, cleanSource: clean, inpaintedImageData: repaired, revision: 4, ai: true },
    repairStrokes: strokes, loadedBaseImageData: clean, originalImageData: clean, conversionSourceImageData: clean,
  };
  const timers = [];
  const displayed = [];
  const context = vm.createContext({
    state, undoStack: [], coreReprocessToken: 3, pendingBrushRepairs: 0, brushRepairWaiters: [], dustAiRefresh: { rects: [], timer: null },
    aiRepair: { status: 'ready', run: async (image, tileMask, size) => {
      runs++;
      // A stand-in model: paints 30 over the masked pixels.
      const out = image.slice();
      for (let i = 0; i < tileMask.length; i++) if (tileMask[i]) for (let c = 0; c < 3; c++) out[c * size * size + i] = 30 / 255;
      return out;
    }, tiles: 0, ms: 0 },
    updateAiRepairUI: () => {}, showToast: () => {}, console, DOMException, DEFAULT_MODEL_URL: '/m.onnx',
    inpaintWithModel, copyImageRect, pasteImageRect, amendDustDelta, ImageData, performance,
    AI_TILE: TILE, AI_CONTEXT: CONTEXT,
    localExposureGeometryFor: () => ({}),
    buildRepairMask: () => ({ mask: strokeMask, bounds: { x: 1055, y: 535, width: 11, height: 30 } }),
    // Each run restarts #236's idle release.
    aiRepairRunsInFlight: 0, used: 0, noteAiRepairUsed: () => { context.used++; },
    repairStamps: createRepairStamps(),
    refreshDustDisplay: (target, rects) => displayed.push(rects),
    loadAiRepairModel: async () => {},
    setTimeout: (callback) => { timers.push(callback); return timers.length; },
    clearTimeout: () => {},
  });
  vm.runInContext(['queueDustAiRefresh', 'mergeDustRefreshRects', 'dustAiWindow', 'cropDustImage',
    'cropDustMask', 'repairStrokeMaskFor', 'runDustAiRefresh', 'noteBrushRepairSettled', 'aiRepairReady',
    'dustPassUsesAi', 'settleAiRepairModel', 'aiRepairLoadArgs', 'assertRepairCurrent', 'countAiRepairRun',
    'baseSizeSource'].map(functionSource).join('\n')
    + '\nlet dustRefreshRepairMask = { strokes: null, source: null, mask: null };', context);
  return { context, state, timers, displayed, runs: () => runs };
}

// A stroke at one speck: its patch rect R, with TELEA values standing in.
const rect = { x: 1030, y: 530, width: 40, height: 40 };
disc(1050, 550, 6);
{
  const { context, state, timers, displayed, runs } = setup();
  const before = copyImageRect(repaired, { x: 0, y: 0, width, height });
  const maskBytes = new Uint8Array(rect.width * rect.height);
  for (let y = 0; y < rect.height; y++) maskBytes.set(mask.subarray((rect.y + y) * width + rect.x, (rect.y + y) * width + rect.x + rect.width), y * rect.width);
  const entry = { target: repaired, mask, cleanSource: clean, patches: [], maskRect: rect,
    maskBefore: maskBytes, maskAfter: maskBytes, aiCleanBefore: true, aiCleanAfter: false };
  context.undoStack.push({ label: 'dustBrushStroke', dustDelta: entry });
  context.queueDustAiRefresh([rect]);
  assert.equal(timers.length, 1, 'strokes are coalesced by a debounce');
  await context.runDustAiRefresh();
  assert.ok(wholeMaskTiles > 10, `a whole-mask pass needs ${wholeMaskTiles} tiles`);
  assert.equal(runs(), 1, 'only the tile over the stroke is inferred');
  assert.equal(context.aiRepair.tiles, 1, 'reported in aiRepair.tiles');
  assert.equal(context.dustAiRefresh.rects.length, 0, 'the refreshed rect leaves the queue');
  assert.equal(entry.patches.length, 1, 'the refresh amends the stroke entry');
  assert.equal(entry.aiCleanAfter, true);
  assert.equal(context.used, 1, 'the run counts as use of the model (#236 idle release)');
  assert.equal(context.aiRepairRunsInFlight, 0);
  assert.equal(JSON.stringify(displayed), JSON.stringify([[rect]]));
  // Only masked pixels inside R changed.
  let changed = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (repaired.data[i] === before.rgba8[i]) continue;
    changed++;
    assert.ok(mask[y * width + x], 'only mask pixels changed');
    assert.ok(x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height, 'only inside R');
    assert.equal(repaired.__image16.data[i], Math.round(repaired.data[i] / 255 * 65535), '16-bit follows');
  }
  assert.ok(changed > 0);
  // Undo takes the refresh back with the stroke.
  applyDustDelta(entry, 'undo');
  assert.deepEqual(copyImageRect(repaired, rect).rgba8, copyImageRect({ ...before, width, height, data: before.rgba8 }, rect).rgba8);
}

// A change that lands first (another stroke, undo) drops the refresh and
// keeps its rect queued for the next one.
{
  const { context, state, runs, displayed } = setup();
  context.queueDustAiRefresh([rect]);
  const before = copyImageRect(repaired, rect);
  const pending = context.runDustAiRefresh();
  state.dustRemoval.revision += 1;
  await pending;
  assert.ok(runs() <= 1, 'no tile starts after the change');
  assert.equal(displayed.length, 0, 'nothing is written or shown');
  assert.deepEqual(copyImageRect(repaired, rect), before);
  assert.equal(JSON.stringify(context.dustAiRefresh.rects), JSON.stringify([rect]), 'the rect stays queued');
  assert.equal(context.pendingBrushRepairs, 0);
}

// TELEA is the repair when AI repair is off, or when its model failed: the
// queue simply empties.
for (const [label, off] of [
  ['AI repair off', ({ state }) => { state.dustRemoval.ai = false; }],
  ['model failed', ({ context }) => { Object.assign(context.aiRepair, { status: 'error', run: null }); }],
]) {
  const { context, state, runs } = setup();
  off({ context, state });
  context.queueDustAiRefresh([rect]);
  await context.runDustAiRefresh();
  assert.equal(runs(), 0, label);
  assert.equal(context.dustAiRefresh.rects.length, 0, `${label}: the queue empties`);
}

// With AI repair on, a model that #236's idle rule or #241's hidden window
// released is not TELEA's turn: the rect stays queued, the released model is
// loaded again on its provider, and the refresh runs once it is back.
{
  const { context, timers, displayed, runs } = setup();
  const run = context.aiRepair.run;
  Object.assign(context.aiRepair, { status: 'idle', released: true, run: null, sourceRef: '/m.onnx', prefer: 'wasm' });
  const loads = [];
  context.loadAiRepairModel = async (...args) => {
    loads.push(args);
    Object.assign(context.aiRepair, { status: 'ready', run, released: false });
  };
  context.queueDustAiRefresh([rect]);
  timers.length = 0;
  await context.runDustAiRefresh();
  assert.equal(runs(), 0, 'nothing is inferred without the model');
  assert.equal(JSON.stringify(context.dustAiRefresh.rects), JSON.stringify([rect]), 'the rect stays queued');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(loads), JSON.stringify([['/m.onnx', { refresh: false, prefer: 'wasm' }]]), 'the released model');
  assert.equal(timers.length, 1, 'the refresh is armed again once the model is back');
  await context.runDustAiRefresh();
  assert.equal(runs(), 1, 'MI-GAN refreshes the rect');
  assert.equal(context.dustAiRefresh.rects.length, 0);
  assert.equal(JSON.stringify(displayed), JSON.stringify([[rect]]));
}

// With AI-brush repair strokes too, a released model is loaded and the queued
// rect drains once it is back, with no other stroke: both layers (the dust and
// the strokes inside the rect) are inferred again and the history entry is
// amended, so the photo can settle (#229 review: the queue used to stay full).
const stroke = { size: 0.01, points: [{ x: 0.35, y: 0.275 }] };
{
  const { context, state, timers, displayed, runs } = setup({ strokes: [stroke] });
  const run = context.aiRepair.run;
  Object.assign(context.aiRepair, { status: 'idle', released: true, run: null, sourceRef: '/m.onnx', prefer: 'wasm' });
  const loads = [];
  context.loadAiRepairModel = async (...args) => {
    loads.push(args);
    Object.assign(context.aiRepair, { status: 'ready', run, released: false });
  };
  const before = copyImageRect(repaired, rect);
  const entry = { target: repaired, mask, cleanSource: clean, patches: [], maskRect: rect,
    maskBefore: new Uint8Array(rect.width * rect.height), maskAfter: new Uint8Array(rect.width * rect.height), aiCleanBefore: true, aiCleanAfter: false };
  context.undoStack.push({ label: 'dustBrushStroke', dustDelta: entry });
  context.queueDustAiRefresh([rect]);
  timers.length = 0;
  await context.runDustAiRefresh();
  assert.equal(runs(), 0, 'nothing is inferred without the model');
  assert.equal(JSON.stringify(context.dustAiRefresh.rects), JSON.stringify([rect]), 'the rect stays queued');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(loads), JSON.stringify([['/m.onnx', { refresh: false, prefer: 'wasm' }]]), 'the released model is loaded');
  assert.equal(timers.length, 1, 'the refresh is armed again once it is back');
  await timers.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.dustAiRefresh.rects.length, 0, 'the queued rect drains without another stroke');
  assert.equal(runs(), 2, 'the dust and the repair strokes in the rect are inferred again');
  assert.equal(context.used, 2, 'both runs count as use');
  assert.equal(entry.patches.length, 1, 'the stroke entry is amended');
  assert.equal(entry.aiCleanAfter, true);
  assert.equal(JSON.stringify(displayed), JSON.stringify([[rect]]));
  const cached = vm.runInContext('dustRefreshRepairMask', context);
  assert.ok(cached.mask === strokeMask && cached.source === clean && cached.strokes === state.repairStrokes, 'the strokes\' mask is kept for the next refresh');
  // The strokes' pixels outside the dust mask changed too.
  let strokePixels = 0;
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
    const i = ((y - rect.y) * rect.width + (x - rect.x)) * 4;
    if (strokeMask[y * width + x] && !mask[y * width + x] && repaired.data[(y * width + x) * 4] !== before.rgba8[i]) strokePixels++;
  }
  assert.ok(strokePixels > 0, 'the repair strokes inside the rect are repaired again');
  applyDustDelta(entry, 'undo');
}

// With repair strokes and a model that failed (to load, or before), the
// strokes cannot be inferred again: the queue empties so the photo settles,
// and the repaired image keeps no stamp, so export repairs it from scratch.
// Nothing loads the failed model again.
{
  const { context, runs } = setup({ strokes: [stroke] });
  Object.assign(context.aiRepair, { status: 'error', run: null, error: 'Failed to fetch' });
  let loads = 0;
  context.loadAiRepairModel = async () => { loads++; };
  context.repairStamps.stamp(repaired, { strokes: [stroke] });
  context.queueDustAiRefresh([rect]);
  await context.runDustAiRefresh();
  assert.equal(runs(), 0);
  assert.equal(loads, 0, 'a failed model is not loaded again by a stroke');
  assert.equal(context.dustAiRefresh.rects.length, 0, 'the queue empties');
  assert.equal(context.repairStamps.recipeOf(repaired), null, 'the repaired image is marked for a from-scratch pass');
  assert.equal(context.pendingBrushRepairs, 0);
}

// One load per release, not one per stroke: a reload that fails leaves the
// model failed, the queue drains, and the next stroke loads nothing.
{
  const { context, timers, runs } = setup({ strokes: [stroke] });
  Object.assign(context.aiRepair, { status: 'idle', released: true, run: null, sourceRef: '/m.onnx', prefer: 'wasm' });
  let loads = 0;
  context.loadAiRepairModel = async () => {
    loads++;
    Object.assign(context.aiRepair, { status: 'error', error: 'Failed to fetch', released: false });
  };
  context.queueDustAiRefresh([rect]);
  timers.length = 0;
  await context.runDustAiRefresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loads, 1);
  assert.equal(timers.length, 1, 'the refresh runs again after the failed load');
  await timers.shift()();
  assert.equal(context.dustAiRefresh.rects.length, 0, 'and drains the queue');
  context.queueDustAiRefresh([rect]);
  await timers.shift()();
  assert.equal(loads, 1, 'the next stroke does not load the failed model again');
  assert.equal(context.dustAiRefresh.rects.length, 0);
  assert.equal(runs(), 0);
}

// A run that fails: on WASM the model is marked failed as on the commit path
// (a new revision), the refresh runs again and drains the queue, and the error
// is reported. A WebGPU session is rebuilt on WASM once; when that reload
// fails too, the queue still drains. A model loaded meanwhile is not marked.
{
  const { context, timers } = setup({ strokes: [stroke] });
  Object.assign(context.aiRepair, { provider: 'wasm', revision: 7, run: async () => { throw new Error('worker lost'); } });
  context.queueDustAiRefresh([rect]);
  timers.length = 0;
  await assert.rejects(context.runDustAiRefresh(), /worker lost/);
  assert.equal(context.aiRepair.status, 'error');
  assert.equal(context.aiRepair.revision, 8, 'a failed model is a new revision');
  assert.equal(context.aiRepair.run, null);
  assert.equal(context.pendingBrushRepairs, 0);
  assert.equal(timers.length, 1);
  await timers.shift()();
  assert.equal(context.dustAiRefresh.rects.length, 0, 'the queue drains');
}
{
  const { context, timers } = setup({ strokes: [stroke] });
  Object.assign(context.aiRepair, { provider: 'webgpu', sourceRef: '/m.onnx', run: async () => { throw new Error('device lost'); } });
  const loads = [];
  context.loadAiRepairModel = async (...args) => {
    loads.push(args);
    Object.assign(context.aiRepair, { status: 'error', error: 'no WASM either', run: null });
  };
  context.queueDustAiRefresh([rect]);
  timers.length = 0;
  await context.runDustAiRefresh();
  assert.equal(JSON.stringify(loads), JSON.stringify([['/m.onnx', { prefer: 'wasm', refresh: false }]]), 'rebuilt on WASM once');
  assert.equal(timers.length, 1, 'armed again although the reload failed');
  await timers.shift()();
  assert.equal(context.dustAiRefresh.rects.length, 0, 'the queue drains');
}
{
  const { context, timers } = setup({ strokes: [stroke] });
  Object.assign(context.aiRepair, { provider: 'wasm', revision: 3, run: async () => {
    // A model the user picks meanwhile releases this one.
    Object.assign(context.aiRepair, { status: 'loading', run: null });
    throw new Error('session released');
  } });
  context.queueDustAiRefresh([rect]);
  timers.length = 0;
  await context.runDustAiRefresh();
  assert.equal(context.aiRepair.status, 'loading', 'the model loading meanwhile is not marked failed');
  assert.equal(context.aiRepair.revision, 3);
  assert.equal(timers.length, 1, 'the next refresh runs with it');
  assert.equal(JSON.stringify(context.dustAiRefresh.rects), JSON.stringify([rect]));
}

console.log(`Dust AI refresh: 1 tile instead of ${wholeMaskTiles} after a stroke; amended history, dropped when overtaken; TELEA only with AI repair off or failed, a released model is loaded and refreshes the dust and the repair strokes; a failed model drains the queue and marks a from-scratch pass, one load per release; runs count as use`);
