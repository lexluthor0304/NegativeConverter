// Dust-stroke history (#259): strokes patch the repaired image and the mask in
// place and record only the bytes they changed. Mixed with the reference
// snapshots of other edits, strict LIFO undo/redo must bring back
// bit-identical images, masks and counts at every step, keep earlier brush
// refinements, and retain patch-sized memory per stroke.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { applyStrokePatch, applyDustDelta, amendDustDelta, historyEntryBytes, copyImageRect, pasteImageRect } from './dustStrokeHistory.js';
import { detectDust, inpaintMasked } from '../silvercore/engine/DustRemoval.js';
import { applyDustStroke } from '../silvercore/engine/DustBrush.js';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const require = createRequire(import.meta.url);
const module = require('@techstark/opencv-js');
globalThis.cv = typeof module.then === 'function' ? await module : module;

let seed = 4242;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const int = (n) => Math.floor(random() * n);

function makeFrame(width, height, specks) {
  const data = new Uint8ClampedArray(width * height * 4);
  const plane = new Uint16Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const x = p % width, y = (p - x) / width;
    for (let c = 0; c < 3; c++) {
      data[p * 4 + c] = 50 + ((x * (c + 1) + y * 2) >> 3) % 90;
      plane[p * 4 + c] = data[p * 4 + c] * 257 + (p % 200);
    }
    data[p * 4 + 3] = 255; plane[p * 4 + 3] = 65535;
  }
  for (let k = 0; k < specks; k++) {
    const cx = 3 + int(width - 6), cy = 3 + int(height - 6);
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 250;
      plane[i] = plane[i + 1] = plane[i + 2] = 64250;
    }
  }
  const image = new ImageData(data, width, height);
  image.__image16 = { width, height, data: plane };
  return image;
}

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);

// A model of the page: dust state, a worker-side copy, and main.js's history
// rules (reference snapshots for other labels, delta entries for strokes).
function createPage(clean, strength = 5) {
  let tagSequence = 0;
  const page = { undo: [], redo: [], exposure: 0, strength, workerState: null };
  page.detect = (source) => {
    const { mask, particleCount } = detectDust(source, { strength: page.strength });
    page.dust = { cleanSource: source, mask, maskTag: ++tagSequence, particleCount,
      inpainted: inpaintMasked(source, mask, 3) };
    page.workerState = { source, mask: mask.slice(), particleCount: null, tag: page.dust.maskTag };
  };
  page.detect(clean);
  page.capture = (label) => ({ label, exposure: page.exposure, strength: page.strength, refs: { ...page.dust } });
  page.push = (entry) => { page.undo.push(entry); page.redo.length = 0; };
  page.stroke = (stroke) => {
    const dust = page.dust;
    // The worker follows the page's mask by tag; re-seed it when it lags.
    if (page.workerState.tag !== dust.maskTag || page.workerState.source !== dust.cleanSource) {
      page.workerState = { source: dust.cleanSource, mask: dust.mask.slice(), particleCount: null, tag: dust.maskTag };
    }
    const patch = applyDustStroke(page.workerState, stroke);
    if (!patch) return false;
    const tag = ++tagSequence;
    page.workerState.tag = tag;
    const delta = applyStrokePatch(dust.inpainted, dust.mask, patch, {
      cleanSource: dust.cleanSource, countBefore: dust.particleCount, tagBefore: dust.maskTag, tagAfter: tag });
    dust.particleCount = patch.particleCount;
    dust.maskTag = tag;
    page.push({ label: 'dustBrushStroke', dustDelta: delta });
    return true;
  };
  page.apply = (delta, direction) => {
    const restored = applyDustDelta(delta, direction);
    page.dust = { cleanSource: restored.cleanSource, mask: restored.mask, maskTag: restored.maskTag,
      particleCount: restored.particleCount, inpainted: restored.target };
    if (page.workerState.tag === restored.worker.baseTag && page.workerState.source === restored.cleanSource) {
      for (let y = 0; y < restored.worker.rect.height; y++) {
        page.workerState.mask.set(restored.worker.bytes.subarray(y * restored.worker.rect.width, (y + 1) * restored.worker.rect.width),
          (restored.worker.rect.y + y) * restored.cleanSource.width + restored.worker.rect.x);
      }
      page.workerState.tag = restored.worker.tag;
      page.workerState.particleCount = restored.worker.particleCount;
    }
  };
  page.restore = (entry) => {
    page.exposure = entry.exposure;
    page.strength = entry.strength;
    page.dust = { ...entry.refs };
  };
  page.performUndo = () => {
    const entry = page.undo.pop();
    if (entry.dustDelta) { page.apply(entry.dustDelta, 'undo'); page.redo.push(entry); }
    else { page.redo.push(page.capture(entry.label)); page.restore(entry); }
  };
  page.performRedo = () => {
    const entry = page.redo.pop();
    if (entry.dustDelta) { page.undo.push(entry); page.apply(entry.dustDelta, 'redo'); }
    else { page.undo.push(page.capture(entry.label)); page.restore(entry); }
  };
  page.fingerprint = () => ({
    image: hash(page.dust.inpainted.data), image16: hash(page.dust.inpainted.__image16.data),
    mask: hash(page.dust.mask), count: page.dust.particleCount, tag: page.dust.maskTag,
    source: page.dust.cleanSource, exposure: page.exposure, strength: page.strength,
  });
  return page;
}

const width = 240, height = 180;
const page = createPage(makeFrame(width, height, 40));
const stroke = () => {
  const x = int(width), y = int(height);
  const points = [{ x, y }, { x: x + int(21) - 10, y: y + int(21) - 10 }];
  const mode = ['intelligent', 'direct', 'remove'][int(3)];
  for (;;) {
    if (page.stroke({ points, brushRadius: 2 + int(6), mode, radius: 3 })) return;
    points[0].x = int(width); points[0].y = int(height);
  }
};
const history = [page.fingerprint()];
const exported = new Set();
const act = (name) => {
  if (name === 'stroke') stroke();
  else if (name === 'slider') { page.push(page.capture('exposure')); page.exposure += 0.25; }
  else if (name === 'strength') {
    page.push(page.capture('dustStrength'));
    page.strength = page.strength === 5 ? 8 : 5;
    page.detect(page.dust.cleanSource);
  } else if (name === 'crop') {
    page.push(page.capture('crop'));
    const old = page.dust.cleanSource;
    const rect = { x: 10, y: 8, width: old.width - 20, height: old.height - 16 };
    const { rgba8, rgba16 } = copyImageRect(old, rect);
    const cropped = new ImageData(rgba8, rect.width, rect.height);
    cropped.__image16 = { width: rect.width, height: rect.height, data: rgba16 };
    page.detect(cropped);
  } else if (name === 'aiExport') {
    // Export swaps in a from-scratch learned repair outside history.
    const replaced = new ImageData(new Uint8ClampedArray(page.dust.inpainted.data), width, height);
    replaced.width = page.dust.inpainted.width; replaced.height = page.dust.inpainted.height;
    replaced.__image16 = { data: new Uint16Array(page.dust.inpainted.__image16.data) };
    for (let p = 0; p < page.dust.mask.length; p++) if (page.dust.mask[p]) replaced.data[p * 4] ^= 1;
    page.dust.inpainted = replaced;
    history[history.length - 1] = page.fingerprint();
    exported.add(history.length - 1);
    return;
  }
  history.push(page.fingerprint());
};
const checkUndoRedo = (label) => {
  const top = history.length - 1;
  for (let i = top; i > 0; i--) {
    assert.deepEqual(page.fingerprint(), history[i], `${label}: state before undo ${top - i}`);
    page.performUndo();
    assert.deepEqual(page.fingerprint(), history[i - 1], `${label}: after undo ${top - i}`);
  }
  for (let i = 1; i <= top; i++) {
    page.performRedo();
    const expected = history[i];
    const actual = page.fingerprint();
    // An export's swapped-in buffer is not history: redo brings the stroke's
    // own result back, bit-identical to what the stroke produced.
    assert.deepEqual({ ...actual, image: null }, { ...expected, image: null }, `${label}: after redo ${i}`);
    if (!exported.has(i)) assert.equal(actual.image, expected.image, `${label}: image after redo ${i}`);
  }
};

for (const name of ['stroke', 'stroke', 'slider', 'stroke', 'strength', 'stroke', 'stroke', 'slider', 'stroke']) act(name);
checkUndoRedo('strokes, sliders, strength');

// A photo switch parks state and stacks; coming back restores them by reference.
const parked = { snapshot: page.capture('photoSession'), undo: page.undo.slice(), redo: page.redo.slice(), history: history.slice() };
{
  const other = createPage(makeFrame(width, height, 10));
  other.stroke({ points: [{ x: 50, y: 50 }], brushRadius: 4, mode: 'direct' });
}
page.restore(parked.snapshot);
page.undo = parked.undo; page.redo = parked.redo;
assert.deepEqual(page.fingerprint(), history.at(-1), 'the returned photo is where it was left');

act('crop');
act('stroke');
act('stroke');
act('aiExport');
act('stroke');
act('slider');
act('stroke');
checkUndoRedo('crop, AI export, photo switch');

// Undo of one stroke keeps every earlier refinement: the mask equals the mask
// right before that stroke, not a fresh detection.
{
  const before = page.dust.mask.slice();
  stroke();
  page.performUndo();
  assert.deepEqual(page.dust.mask, before);
  page.performRedo();
  page.performUndo();
}

// A later write recorded into the newest stroke (the learned-repair refresh)
// is taken back by its undo and restored by its redo.
{
  stroke();
  const entry = page.undo.at(-1).dustDelta;
  const rect = { x: 0, y: 0, width: 16, height: 12 };
  const before = copyImageRect(page.dust.inpainted, rect);
  amendDustDelta(entry, rect, () => {
    const fill = new Uint8ClampedArray(rect.width * rect.height * 4).fill(7);
    pasteImageRect(page.dust.inpainted, rect, fill, new Uint16Array(fill.length).fill(1799));
  });
  const amended = copyImageRect(page.dust.inpainted, rect);
  page.performUndo();
  assert.deepEqual(copyImageRect(page.dust.inpainted, rect), before);
  page.performRedo();
  assert.deepEqual(copyImageRect(page.dust.inpainted, rect), amended);
}

// Memory: 20 strokes on a 12 MP frame add patch-sized history, not frames.
{
  const big = createPage(makeFrame(4000, 3000, 300));
  const retained = () => {
    const seen = new Set();
    let bytes = historyEntryBytes({ refs: big.dust }, seen);
    for (const entry of [...big.undo, ...big.redo]) bytes += historyEntryBytes(entry, seen);
    return bytes;
  };
  const baseline = retained();
  let done = 0;
  while (done < 20) {
    const x = 100 + int(3800), y = 100 + int(2800);
    if (big.stroke({ points: [{ x, y }, { x: x + 12, y: y + 5 }], brushRadius: 5, mode: 'direct' })) done++;
  }
  const added = retained() - baseline;
  assert.ok(added < 100 * 1024 * 1024, `20 strokes retain ${added} bytes`);
  assert.ok(added < 2 * 1024 * 1024, `patch-sized history (${added} bytes for 20 strokes)`);
  // A reference snapshot counts its mask too, once.
  const seen = new Set();
  const snapshotBytes = historyEntryBytes(big.capture('exposure'), seen);
  assert.equal(snapshotBytes, big.dust.inpainted.data.byteLength + big.dust.inpainted.__image16.data.byteLength
    + big.dust.cleanSource.data.byteLength + big.dust.cleanSource.__image16.data.byteLength + big.dust.mask.byteLength);
  assert.equal(historyEntryBytes(big.capture('exposure'), seen), 0, 'shared buffers count once');
}

console.log('Dust-stroke history: in-place deltas undo/redo bit-identically across sliders, strength, crop, AI export and photo switch');
