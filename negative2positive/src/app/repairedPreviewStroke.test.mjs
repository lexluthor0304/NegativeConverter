import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createDustWorkerClient } from './dustWorkerClient.js';
import { poolRepairMask, repoolRepairMaskRect, countPooledCells } from './repairedPreview.js';
import { displayTargetFor, isDisplayTarget, displayLevelGeometry } from './displayPreview.js';
import { applyStrokePatch, applyDustDelta } from './dustStrokeHistory.js';
import { displaySessionStubs, DISPLAY_SESSION_HELPERS } from './displaySessionHarness.mjs';

// #229 review R1-104: a dust-brush stroke (#259) must keep #259's budget in
// its own path, also for #237's repaired preview: no copy or postMessage of
// 16 MB or more, no scan of the whole frame's mask, and no display negative
// asked of the preview worker. The fill follows once input pauses, from the
// display negative the preview repair worker kept, with the stroke's box
// pooled into the kept masks. Runs main.js's real stroke end, repaired-preview
// functions and dust worker client (on a stand-in worker that counts what it
// is posted), at a 6 MP frame with a 2.3 MP display preview.
globalThis.ImageData ||= class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `runtime function exists: ${name}`);
  const end = source.indexOf('\n    }', match.index);
  assert.ok(end > match.index, `runtime function closes: ${name}`);
  return source.slice(match.index, end + '\n    }'.length);
}
const settle = () => new Promise(setImmediate);
const noop = () => {};
const MB16 = 16 * 1024 * 1024;

const WIDTH = 3000, HEIGHT = 2000;
const TARGET = { width: 1860, height: 1240 };

// Bytes of the typed arrays and buffers a message carries (copied or moved).
function messageBytes(message) {
  let total = 0;
  for (const value of Object.values(message)) {
    if (ArrayBuffer.isView(value)) total += value.byteLength;
    else if (value instanceof ArrayBuffer) total += value.byteLength;
  }
  return total;
}

function fixture({ repairStrokes = [] } = {}) {
  let seed = 11;
  const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const mask = new Uint8Array(WIDTH * HEIGHT);
  for (let i = 0; i < 300; i++) mask[Math.floor(random() * HEIGHT) * WIDTH + Math.floor(random() * WIDTH)] = 255;
  const conversionSource = { width: WIDTH, height: HEIGHT, name: 'conversion source' };
  const cleanSource = { width: WIDTH, height: HEIGHT, name: 'clean source' };
  const repaired = new ImageData(new Uint8ClampedArray(WIDTH * HEIGHT * 4), WIDTH, HEIGHT);
  const state = {
    conversionSourceImageData: conversionSource, displayLevelImageData: conversionSource,
    conversionPreviewImageData: displayTargetFor(conversionSource, TARGET),
    processedImageData: repaired, processedImageDataIsPreview: false, currentStep: 3, repairStrokes,
    dustRemoval: { enabled: true, showMask: true, ai: false, processing: false, mask, maskTag: 1, particleCount: 300,
      revision: 4, cleanSource, inpaintedImageData: repaired, brushSize: 5 },
  };

  // The preview repair worker: the real client on a stand-in worker that
  // keeps its source as the real one does and counts every message's bytes.
  const posted = [];
  let workerSource = null;
  const workers = [];
  // Replies wait here while `hold` is set.
  const replies = { hold: false, queue: [] };
  const previewRepairWorker = createDustWorkerClient({ workerFactory: () => {
    const worker = {
      postMessage(message, transfers) {
        const copy = structuredClone(message, { transfer: transfers });
        posted.push({ type: copy.type, reuseSource: copy.reuseSource, bytes: messageBytes(copy), mask: copy.mask });
        if (!copy.reuseSource) workerSource = { width: copy.width, height: copy.height };
        const reply = () => worker.onmessage?.({ data: { id: copy.id, image: { width: workerSource.width, height: workerSource.height,
          data: new Uint8ClampedArray(workerSource.width * workerSource.height * 4) } } });
        if (replies.hold) replies.queue.push(reply);
        else setImmediate(reply);
      },
      terminate() { this.terminated = true; },
    };
    workers.push(worker);
    return worker;
  } });

  const counters = { displayNegatives: 0, fullScans: 0, repools: [], strokeMasks: 0 };
  const timers = new Map();
  let nextTimer = 1;
  const context = vm.createContext({
    ...displaySessionStubs(),
    state, console: { warn: noop, error: noop, info: noop }, ImageData, Uint8Array, Promise,
    setTimeout: (callback, delay = 0) => { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => { timers.delete(id); },
    poolRepairMask: (mask, width, height, out, targetWidth, targetHeight, bounds = null) => {
      if (!bounds || bounds.width * bounds.height >= width * height) counters.fullScans++;
      return poolRepairMask(mask, width, height, out, targetWidth, targetHeight, bounds);
    },
    repoolRepairMaskRect: (...args) => { counters.repools.push({ ...args[6] }); return repoolRepairMaskRect(...args); },
    countPooledCells,
    buildRepairMask: (strokes, geometry) => {
      counters.strokeMasks++;
      const strokeMask = new Uint8Array(geometry.width * geometry.height);
      strokeMask[700 * geometry.width + 900] = 255;
      return { mask: strokeMask, bounds: { x: 900, y: 700, width: 1, height: 1 } };
    },
    localExposureGeometryFor: () => ({}),
    previewRepairWorker,
    // The preview worker's copy of a display target's negative: both planes,
    // as conversionWorker.js sends them.
    convertPreviewFrameInWorker: {
      displayNegative: async ({ display }) => {
        counters.displayNegatives++;
        const { width, height } = display.target;
        const image = new ImageData(new Uint8ClampedArray(width * height * 4), width, height);
        image.__image16 = { width, height, data: new Uint16Array(width * height * 4) };
        return image;
      },
    },
    buildRouterSettings: () => ({}), getColorAnalysisSample: () => null,
    displayTargetFor, isDisplayTarget, displayLevelGeometry,
    hasFrameRepairs: () => Boolean(state.dustRemoval.enabled || state.repairStrokes.length),
    repairedPreviewMasks: null, repairedPreview: null, repairedPreviewBuild: null, repairedPreviewPool: null,
    repairedPreviewShown: null, repairedPreviewTimer: null, REPAIRED_PREVIEW_IDLE_MS: 300,
    // The stroke end (#259) with its stroke worker answering at once.
    dustDrawing: false, dustBrushPointerId: 1, releaseDustBrushPointer: noop, brushFeedback: { end: noop },
    dustBrushPoints: [], dustBrushSource: null, dustBrushMode: 'direct', dustBrushTurn: Promise.resolve(),
    coreReprocessToken: 7, dustBrushToken: 7, dustDetectionRevision: 3, pendingBrushRepairs: 0, brushRepairWaiters: [],
    dustPrivateClone: null, dustMaskTagSequence: 10, displayOverlaySize: () => null,
    strokeDustInWorker: async () => context.nextPatch, assertRepairCurrent: noop,
    repairStamps: { forget: noop }, forgetDustMaskInfo: noop, applyStrokePatch, dustAiRefresh: { rects: [] },
    deltas: [], pushUndoDelta: (label, delta) => context.deltas.push(delta), showDustParticleCount: noop,
    patchDustTint: noop, refreshDustDisplay: noop, queueDustAiRefresh: noop, aiRepair: { status: 'ready' },
    updateDustStatusUI: noop, getLocalizedText: (key, fallback) => fallback,
  });
  vm.runInContext([
    ...DISPLAY_SESSION_HELPERS, 'hasSeparateConversionPreview', 'previewRequestImage',
    'scheduleRepairedPreviewAfterInput', 'rememberRepairMasks', 'poolRepairStroke', 'clearRepairedPreview',
    'repairedPreviewMatches', 'repairedPreviewSourceFor', 'ensureRepairedPreview',
    'currentRepairPool', 'buildRepairedPreview',
    'getDustSource', 'needsDustPrivateBuffer', 'installDustPrivateBuffer', 'ensureDustPrivateBuffer',
    'prepareDustPrivateBuffer', 'nextDustMaskTag', 'strokeDustOffMainThread', 'commitDustStroke',
    'onDustBrushEnd', 'noteBrushRepairSettled',
  ].map(functionSource).join('\n'), context);

  // Runs the timers of one delay (0: a build leaving its task; 300: input paused).
  const runTimersOf = (delay) => {
    for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); }
  };
  const idle = async () => {
    for (let round = 0; round < 4; round++) {
      runTimersOf(300);
      runTimersOf(0);
      await settle();
    }
  };
  // One stroke over `box`: the worker's patch sets (or, for `remove`, clears)
  // the box's mask pixels on a grid and repairs the box.
  const stroke = async (box, mode = 'direct') => {
    const maskBytes = new Uint8Array(box.width * box.height);
    if (mode !== 'remove') for (let i = 0; i < maskBytes.length; i += 7) maskBytes[i] = 255;
    context.nextPatch = { rect: { ...box }, rgba8: new Uint8ClampedArray(box.width * box.height * 4).fill(40), rgba16: null,
      maskRect: { ...box }, maskBytes, particleCount: state.dustRemoval.particleCount + 1, countBefore: state.dustRemoval.particleCount };
    context.dustDrawing = true;
    context.dustBrushPoints = [{ x: box.x / WIDTH, y: box.y / HEIGHT }];
    context.dustBrushSource = cleanSource;
    context.dustBrushMode = mode;
    await context.onDustBrushEnd({ pointerId: 1 });
  };
  // The current masks pooled from scratch, as the fill must see them.
  const pooledNow = () => {
    const out = new Uint8Array(TARGET.width * TARGET.height);
    poolRepairMask(state.dustRemoval.mask, WIDTH, HEIGHT, out, TARGET.width, TARGET.height);
    if (state.repairStrokes.length) {
      const strokeMask = new Uint8Array(WIDTH * HEIGHT);
      strokeMask[700 * WIDTH + 900] = 255;
      poolRepairMask(strokeMask, WIDTH, HEIGHT, out, TARGET.width, TARGET.height, { x: 900, y: 700, width: 1, height: 1 });
    }
    return out;
  };
  const reset = () => {
    posted.length = 0;
    counters.displayNegatives = 0;
    counters.fullScans = 0;
    counters.repools.length = 0;
    counters.strokeMasks = 0;
  };
  return { context, state, cleanSource, posted, counters, timers, workers, previewRepairWorker, runTimersOf, idle, stroke,
    pooledNow, reset, replies };
}

const sameBytes = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength),
  Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;

// ---- Detection settled: the first fill sends the display negative, once ----
const f = fixture();
const c = f.context;
c.rememberRepairMasks(f.cleanSource);
await f.idle();
assert.ok(c.repairedPreview?.image, 'the display preview is filled');
assert.equal(f.counters.displayNegatives, 1, 'its display negative comes from the preview worker');
assert.equal(f.counters.fullScans, 1, 'the masks are pooled once');
assert.equal(f.posted.length, 1);
assert.equal(f.posted[0].reuseSource, false);
const negative = c.repairedPreview.negative;
assert.equal(negative.data.byteLength, 0, 'the negative moved on to the preview repair worker: main keeps no copy');
assert.equal(negative.__image16.data.byteLength, 0);
assert.ok(f.previewRepairWorker.holds(negative), 'which keeps it');
const firstFill = c.repairedPreview.image;

// ---- One stroke: nothing in its own task, then the mask alone ----
f.reset();
const box = { x: 1200, y: 800, width: 61, height: 47 };
await f.stroke(box);
assert.equal(c.deltas.length, 1, 'the stroke landed');
assert.equal(f.posted.length, 0, 'the stroke posts nothing to the preview repair worker');
assert.equal(f.counters.displayNegatives, 0, 'nor asks the preview worker for anything');
assert.equal(f.counters.fullScans, 0, 'and scans no whole mask');
assert.deepEqual(f.counters.repools, [box], 'it pools its own box into the kept masks');
assert.ok([...f.timers.values()].some(timer => timer.delay === 300), 'the fill follows once input pauses');
assert.ok(c.repairedPreviewSourceFor(f.state.conversionPreviewImageData) === firstFill, 'meanwhile the last fill serves');
await f.idle();
assert.equal(f.posted.length, 1, 'one fill');
assert.equal(f.posted[0].type, 'inpaint');
assert.equal(f.posted[0].reuseSource, true, 'from the kept display negative');
assert.equal(f.posted[0].bytes, TARGET.width * TARGET.height, 'the pooled mask is all it sends');
assert.ok(f.posted[0].bytes < MB16);
assert.equal(f.counters.displayNegatives, 0, 'no display negative asked');
assert.equal(f.counters.fullScans, 0, 'no whole mask scanned');
assert.ok(sameBytes(f.posted[0].mask, f.pooledNow()), 'it fills the masks as the stroke left them');
assert.ok(c.repairedPreview.image !== firstFill, 'the new fill serves');
assert.equal(c.repairedPreview.revision, f.state.dustRemoval.revision);

// ---- Strokes in quick succession: one fill once they pause ----
f.reset();
await f.stroke({ x: 100, y: 100, width: 40, height: 40 });
await f.stroke({ x: 2950, y: 1960, width: 50, height: 40 }, 'direct');
await f.stroke({ x: 1190, y: 790, width: 80, height: 70 }, 'remove');
assert.equal(f.posted.length, 0);
assert.equal(f.counters.repools.length, 3);
await f.idle();
assert.equal(f.posted.length, 1, 'one fill for the three strokes');
assert.equal(f.posted[0].bytes, TARGET.width * TARGET.height);
assert.equal(f.counters.displayNegatives + f.counters.fullScans, 0);
assert.ok(sameBytes(f.posted[0].mask, f.pooledNow()), 'with every stroke, the removal too');

// ---- An undo moved the mask without the preview: the next stroke still
// stays light, and the fill after it pools the whole masks once ----
f.reset();
applyDustDelta(c.deltas.at(-1), 'undo');
f.state.dustRemoval.revision += 1;
await f.stroke({ x: 600, y: 300, width: 30, height: 30 });
assert.equal(f.posted.length + f.counters.displayNegatives + f.counters.fullScans + f.counters.repools.length, 0,
  'the stroke does nothing it cannot do on its box');
await f.idle();
assert.equal(f.counters.fullScans, 1, 'the fill pools the masks again');
assert.equal(f.posted.length, 1);
assert.equal(f.posted[0].bytes, TARGET.width * TARGET.height);
assert.ok(sameBytes(f.posted[0].mask, f.pooledNow()), 'the undone stroke is out of the fill');

// ---- The preview repair worker went idle: the stroke stays light, the fill
// after the pause asks for the display negative again ----
f.reset();
f.previewRepairWorker.dispose();
assert.equal(f.previewRepairWorker.holds(c.repairedPreview.negative), false);
await f.stroke({ x: 2000, y: 1500, width: 20, height: 20 });
assert.equal(f.posted.length + f.counters.displayNegatives + f.counters.fullScans, 0);
await f.idle();
assert.equal(f.counters.displayNegatives, 1, 'the display negative is asked for once');
assert.equal(f.counters.fullScans, 0);
assert.equal(f.posted.length, 1);
assert.equal(f.posted[0].reuseSource, false);

// ---- A stroke while a fill is under way: the fill lands, and the newer mask
// follows once input pauses ----
{
  const h = fixture();
  h.replies.hold = true;
  h.context.rememberRepairMasks(h.cleanSource);
  await h.idle();
  assert.equal(h.posted.length, 1, 'the first fill is on its way');
  h.reset();
  await h.stroke({ x: 1500, y: 900, width: 33, height: 21 });
  assert.equal(h.counters.repools.length, 1, 'the stroke pools its box into the masks being filled');
  // Input pauses before the fill lands: the one under way finishes first.
  await h.idle();
  assert.equal(h.posted.length, 0);
  h.replies.hold = false;
  for (const reply of h.replies.queue.splice(0)) reply();
  await settle();
  assert.ok(h.context.repairedPreview?.image, 'the fill under way lands');
  assert.equal(h.context.repairedPreview.revision, h.state.dustRemoval.revision - 1, 'with the mask before the stroke');
  await h.idle();
  assert.equal(h.posted.length, 1, 'then one fill of the newer mask');
  assert.equal(h.posted[0].reuseSource, true);
  assert.equal(h.counters.displayNegatives + h.counters.fullScans, 0);
  assert.ok(sameBytes(h.posted[0].mask, h.pooledNow()));
  assert.equal(h.context.repairedPreview.revision, h.state.dustRemoval.revision);
}

// ---- A detection that finds nothing, then one that finds dust again (a
// strength change): the second fill still needs no display negative ----
{
  const k = fixture();
  k.context.rememberRepairMasks(k.cleanSource);
  await k.idle();
  k.reset();
  k.state.dustRemoval.mask = new Uint8Array(WIDTH * HEIGHT);
  k.state.dustRemoval.revision += 2;
  k.context.rememberRepairMasks(k.cleanSource);
  await k.idle();
  assert.ok(k.context.repairedPreview.image === null, 'nothing to fill');
  assert.equal(k.posted.length + k.counters.displayNegatives, 0);
  const dust = new Uint8Array(WIDTH * HEIGHT);
  dust[1000 * WIDTH + 1000] = 255;
  k.state.dustRemoval.mask = dust;
  k.state.dustRemoval.revision += 2;
  k.context.rememberRepairMasks(k.cleanSource);
  await k.idle();
  assert.equal(k.counters.displayNegatives, 0, 'the kept display negative is filled again');
  assert.equal(k.posted.length, 1);
  assert.equal(k.posted[0].reuseSource, true);
  assert.ok(k.context.repairedPreview.image);
}

// ---- Repair strokes (the AI brush) stay pooled: a dust stroke rebuilds no
// stroke mask ----
{
  const g = fixture({ repairStrokes: [{ size: 0.01, points: [{ x: 0.3, y: 0.35 }] }] });
  g.context.rememberRepairMasks(g.cleanSource);
  await g.idle();
  assert.equal(g.counters.strokeMasks, 1, 'the first fill builds the stroke mask');
  g.reset();
  await g.stroke({ x: 880, y: 680, width: 50, height: 50 }, 'remove');
  await g.idle();
  assert.equal(g.counters.strokeMasks + g.counters.fullScans + g.counters.displayNegatives, 0);
  assert.equal(g.posted.length, 1);
  assert.ok(sameBytes(g.posted[0].mask, g.pooledNow()), 'the repair strokes stay in the fill under a removal');
}

console.log('repairedPreviewStroke: a dust stroke posts no image, scans no whole mask and asks no display negative; its fill follows from the kept negative once input pauses');
