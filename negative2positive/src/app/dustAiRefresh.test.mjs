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

function setup() {
  let runs = 0;
  const state = {
    dustRemoval: { enabled: true, mask, cleanSource: clean, inpaintedImageData: repaired, revision: 4, ai: true },
    repairStrokes: [], loadedBaseImageData: clean, originalImageData: clean, conversionSourceImageData: clean,
  };
  const timers = [];
  const displayed = [];
  const context = vm.createContext({
    state, undoStack: [], coreReprocessToken: 3, pendingBrushRepairs: 0, dustAiRefresh: { rects: [], timer: null },
    aiRepair: { status: 'ready', run: async (image, tileMask, size) => {
      runs++;
      // A stand-in model: paints 30 over the masked pixels.
      const out = image.slice();
      for (let i = 0; i < tileMask.length; i++) if (tileMask[i]) for (let c = 0; c < 3; c++) out[c * size * size + i] = 30 / 255;
      return out;
    }, tiles: 0, ms: 0 },
    aiRepairReady: () => true, updateAiRepairUI: () => {}, showToast: () => {}, console,
    inpaintWithModel, copyImageRect, pasteImageRect, amendDustDelta, ImageData, performance,
    AI_TILE: TILE, AI_CONTEXT: CONTEXT, repairMask: () => assert.fail('no repair strokes here'),
    localExposureGeometryFor: () => ({}),
    refreshDustDisplay: (target, rects) => displayed.push(rects),
    loadAiRepairModel: async () => {},
    setTimeout: (callback) => { timers.push(callback); return timers.length; },
    clearTimeout: () => {},
  });
  vm.runInContext(['queueDustAiRefresh', 'mergeDustRefreshRects', 'dustAiWindow', 'cropDustImage',
    'cropDustMask', 'repairStrokeMaskFor', 'runDustAiRefresh'].map(functionSource).join('\n')
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

// With no model on, TELEA is the repair: the queue simply empties.
{
  const { context, runs } = setup();
  context.aiRepairReady = () => false;
  context.queueDustAiRefresh([rect]);
  await context.runDustAiRefresh();
  assert.equal(runs(), 0);
  assert.equal(context.dustAiRefresh.rects.length, 0);
}

console.log(`Dust AI refresh: 1 tile instead of ${wholeMaskTiles} after a stroke; amended history, dropped when overtaken`);
