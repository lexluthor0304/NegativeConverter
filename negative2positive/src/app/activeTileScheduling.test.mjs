import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { exactSettingsKey } from './settingsKey.js';
import { createStudioThumbnail } from './studioSettings.js';

// Run the active filmstrip tile's real scheduling and rebuild decisions from
// main.js. Only the canvas, the adjustment stage and the row DOM are stubbed.
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source)?.index;
  assert.notEqual(start, undefined, `${name} exists in main.js`);
  const end = source.indexOf('\n    }', start);
  return source.slice(start, end + '\n    }'.length);
}
class TestImageData {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
}
const raster = (width, height, fill = 90) => new TestImageData(new Uint8ClampedArray(width * height * 4).fill(fill), width, height);

function fixture() {
  const file = { name: 'a.png' };
  const item = { file, settings: { cyan: 0 } };
  const state = {
    fileQueue: [item], currentFileIndex: 0, loadedFile: file, cyan: 0,
    curves: { r: Uint8Array.from({ length: 256 }, (_, i) => i), g: new Uint8Array(256), b: new Uint8Array(256) },
    processedImageData: raster(600, 400), previewSourceImageData: null, fullResolutionPending: false,
  };
  const timers = new Map(), frames = new Map();
  let nextHandle = 1;
  const counts = { adjusted: 0, sampled: 0, encodes: 0, canvases: 0, rows: 0, keys: 0 };
  const puts = [];
  const context = vm.createContext({
    state, loadGeneration: 1, exactSettingsKey, ImageData: TestImageData, Uint8ClampedArray, Uint8Array,
    studioThumbnailInputs: new WeakMap(), STUDIO_THUMBNAIL_SETTLE_MS: 250,
    studioThumbnailUpdateTimer: 0, studioThumbnailUpdateFrame: 0, thumbnailCanvas: null,
    previewTier: 'normal', reducedDisplayImages: new WeakSet(), coreReprocessTimer: null, coreReprocessBusy: () => false,
    setTimeout: (fn, ms) => { const id = nextHandle++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    requestAnimationFrame: fn => { const id = nextHandle++; frames.set(id, fn); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    isCurrentLoad: generation => generation === context.loadGeneration,
    buildAdjustmentSettings: settings => ({ cyan: settings.cyan, curves: { ...settings.curves } }),
    createAdjustedPhotoPreview: (sourceImage, adjustments) => {
      counts.adjusted++;
      const sample = createStudioThumbnail(sourceImage, 144);
      return new TestImageData(sample.data.map(value => value + adjustments.cyan), sample.width, sample.height);
    },
    createStudioThumbnail: (...args) => { counts.sampled++; return createStudioThumbnail(...args); },
    photoSettingsKey: entry => { counts.keys++; return JSON.stringify(entry.settings); },
    updateFileThumbnail: () => { counts.rows++; },
    document: { createElement: () => {
      counts.canvases++;
      return { width: 0, height: 0, getContext: () => ({ putImageData: image => puts.push(image) }),
        toDataURL: () => `data:image/jpeg;base64,${++counts.encodes}` };
    } },
  });
  vm.runInContext(['getCurrentQueueItem', 'thumbnailDataUrl', 'studioThumbnailSignature', 'updateStudioThumbnail',
    'adoptStudioThumbnailInputs', 'carryStudioThumbnailSource', 'currentConvertedPreviewSource',
    'scheduleStudioThumbnailUpdate', 'cancelStudioThumbnailUpdate'].map(functionSource).join('\n'), context);
  const fireTimers = () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); } };
  const fireFrames = () => { for (const [id, frame] of [...frames]) { frames.delete(id); frame(); } };
  return { context, state, item, timers, frames, counts, puts, fireTimers, fireFrames };
}

// A drag: every preview frame re-arms one trailing timer; nothing is sampled,
// adjusted or encoded until it fires, then the tile is rebuilt once.
{
  const f = fixture(), c = f.context;
  c.updateStudioThumbnail();
  assert.equal(f.counts.encodes, 1);
  const first = f.item.thumbnail;
  for (let frame = 1; frame <= 90; frame++) {
    f.state.cyan = 1 + frame % 30;
    c.scheduleStudioThumbnailUpdate();
    assert.equal(f.timers.size, 1, 'one pending timer, re-armed by every preview frame');
  }
  assert.equal([...f.timers.values()][0].ms, 250);
  assert.deepEqual([f.counts.adjusted, f.counts.encodes, f.counts.rows], [1, 1, 1], 'no tile work while the slider moves');
  f.fireTimers();
  assert.deepEqual([f.counts.adjusted, f.counts.encodes, f.counts.rows], [2, 2, 2], 'one rebuild after it settles');
  assert.notEqual(f.item.thumbnail, first);
  assert.equal(f.item.thumbnailKind, 'processed');
  assert.equal(f.item.thumbnailKey, JSON.stringify(f.item.settings));
  assert.equal(f.counts.canvases, 1, 'one canvas serves every encode');

  // Zoom, pan and resize redraws: same source and settings, no rebuild; a
  // persisted settings change is still restamped on the row.
  for (let step = 0; step < 5; step++) c.scheduleStudioThumbnailUpdate();
  f.item.settings = { cyan: f.state.cyan };
  f.fireTimers();
  assert.deepEqual([f.counts.adjusted, f.counts.encodes], [2, 2]);
  assert.equal(f.item.thumbnailKey, JSON.stringify(f.item.settings), 'restamped without a rebuild');
  assert.equal(f.counts.rows, 3);

  // An in-place curve edit (updateCurveFromPoints) changes the signature.
  f.state.curves.r[7] = 200;
  c.scheduleStudioThumbnailUpdate(); f.fireTimers();
  assert.equal(f.counts.encodes, 3);

  // A full render updates the tile in the next frame; a later preview redraw
  // replaces that frame with the trailing timer, and the reverse.
  f.state.processedImageData = raster(600, 400, 91);
  c.scheduleStudioThumbnailUpdate({ settled: true });
  assert.deepEqual([f.frames.size, f.timers.size], [1, 0]);
  c.scheduleStudioThumbnailUpdate();
  assert.deepEqual([f.frames.size, f.timers.size], [0, 1]);
  c.scheduleStudioThumbnailUpdate({ settled: true });
  assert.deepEqual([f.frames.size, f.timers.size], [1, 0]);
  f.fireFrames();
  assert.equal(f.counts.encodes, 4, 'a new converted source rebuilds');

  // Another writer of the tile (roll-transaction undo restores an old data
  // URL) makes it stale even though source and settings match.
  f.item.thumbnail = first;
  c.scheduleStudioThumbnailUpdate(); f.fireTimers();
  assert.equal(f.counts.encodes, 5);
  assert.notEqual(f.item.thumbnail, first);

  // A pending update never writes into a newer load.
  f.state.cyan = 1;
  c.scheduleStudioThumbnailUpdate();
  c.loadGeneration++;
  f.fireTimers();
  assert.equal(f.counts.encodes, 5);
  c.scheduleStudioThumbnailUpdate();
  c.cancelStudioThumbnailUpdate();
  assert.deepEqual([f.frames.size, f.timers.size, c.studioThumbnailUpdateTimer, c.studioThumbnailUpdateFrame], [0, 0, 0, 0]);
}

// The display-preview refinement after a zoom converts the same settings at
// another size: its result carries the tile over. A source it did not sample
// is not carried.
{
  const f = fixture(), c = f.context;
  f.state.fullResolutionPending = true;
  f.state.previewSourceImageData = raster(300, 200);
  c.updateStudioThumbnail();
  const replaced = c.currentConvertedPreviewSource();
  f.state.previewSourceImageData = raster(450, 300);
  c.carryStudioThumbnailSource(replaced);
  c.scheduleStudioThumbnailUpdate(); f.fireTimers();
  assert.equal(f.counts.encodes, 1, 'a zoom refinement rebuilds nothing');
  f.state.previewSourceImageData = raster(450, 300, 70);
  c.carryStudioThumbnailSource(replaced);
  c.scheduleStudioThumbnailUpdate(); f.fireTimers();
  assert.equal(f.counts.encodes, 2, 'only the source the tile was sampled from is carried');
  c.carryStudioThumbnailSource(null);
  f.state.previewSourceImageData = raster(450, 300, 60);
  c.scheduleStudioThumbnailUpdate(); f.fireTimers();
  assert.equal(f.counts.encodes, 3, 'an ordinary conversion result rebuilds');
}

// Warm switch: the incoming photo's current tile is adopted, not rebuilt, and
// the restore's own redraw does not rebuild it later.
{
  const f = fixture(), c = f.context;
  f.item.thumbnail = 'data:image/jpeg;base64,kept';
  f.item.thumbnailKind = 'processed';
  c.scheduleStudioThumbnailUpdate();
  c.adoptStudioThumbnailInputs(f.item);
  assert.equal(f.timers.size, 0);
  c.scheduleStudioThumbnailUpdate(); f.fireTimers();
  assert.equal(f.counts.encodes, 0);
  assert.equal(f.item.thumbnail, 'data:image/jpeg;base64,kept');
}

// thumbnailDataUrl encodes a source that already fits as it is (the sampler
// at scale 1 is an exact copy) and samples anything larger.
{
  const f = fixture(), c = f.context;
  const small = raster(144, 96);
  c.thumbnailDataUrl(small);
  assert.equal(f.puts.at(-1), small);
  assert.equal(f.counts.sampled, 0);
  const odd = { width: 100, height: 60, data: new Uint8ClampedArray(100 * 60 * 4 + 8) };
  c.thumbnailDataUrl(odd);
  assert.equal(f.counts.sampled, 1, 'a view with slack is sampled');
  c.thumbnailDataUrl(raster(288, 192));
  assert.equal(f.counts.sampled, 2);
  assert.deepEqual([f.puts.at(-1).width, f.puts.at(-1).height], [144, 96]);
  assert.equal(f.counts.canvases, 1);
}

console.log('activeTileScheduling: trailing settle timer, next-frame full renders, exact skip/restamp, zoom carry, warm adoption');
