// Enclosure test of the incremental particle count (#259, #229 review R1-106).
// A stroke's count moves by the external contours of the old and the new mask
// inside R, unless R may lie in a hole of a component outside it: then the
// whole frame is recounted (a W×H copy and findContours, about 0.2 s at
// 60 MP). mayBeEnclosed decides with four straight runs from R's corners and,
// when dust blocks all four, a bounded search of the background around R.
// Checked here:
// 1. the OpenCV topology the search relies on: dust is 8-connected, holes are
//    4-connected background, and the frame edge is open;
// 2. built cases: open behind blocked runs, a pocket facing away from the
//    nearest edge, diagonal joints, gaps, a U closed only by the frame edge,
//    closed rings, the budget, each also as a stroke with an exact count;
// 3. the search against a full background flood on random masks;
// 4. a 12 MP Monte Carlo at the review's dust densities (its 1000 and 2000
//    specks at 60 MP, where the old four runs recounted ~9 % and ~28 % of
//    strokes): under 1 % of strokes recount, every count equals a full
//    recount, and strokes inside closed loops recount.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  applyDustStroke, countMaskParticles, mayBeEnclosed, searchBackgroundToEdge,
} from './DustBrush.js';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const require = createRequire(import.meta.url);
const module = require('@techstark/opencv-js');
const cv = typeof module.then === 'function' ? await module : module;
globalThis.cv = cv;

// Counts the full-frame findContours calls made while armed. A stroke
// recounted the frame when it made one, or a third when its R covers the
// frame (R's own two crop counts are then frame-sized too).
const spy = { armed: false, width: 0, height: 0, frames: 0 };
const recountedFrame = (rect, width, height) => spy.frames > (rect.width === width && rect.height === height ? 2 : 0);
const findContours = cv.findContours;
cv.findContours = function (mat, ...rest) {
  if (spy.armed && mat.rows === spy.height && mat.cols === spy.width) spy.frames++;
  return findContours.call(this, mat, ...rest);
};
cv.findContours.overloadTable = findContours.overloadTable; // embind dispatches through it

let seed = 106;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const int = (n) => Math.floor(random() * n);

// The rule before R1-106 (5f23eb0): only the four straight runs.
function fourRunsMayBeEnclosed(mask, width, height, rect) {
  const right = rect.x + rect.width, bottom = rect.y + rect.height;
  if (rect.x === 0 || rect.y === 0 || right === width || bottom === height) return false;
  const clearRow = (y, from, to) => { for (let x = from; x < to; x++) if (mask[y * width + x]) return false; return true; };
  const clearColumn = (x, from, to) => { for (let y = from; y < to; y++) if (mask[y * width + x]) return false; return true; };
  return !(clearRow(rect.y, 0, rect.x) || clearRow(rect.y, right, width)
    || clearColumn(rect.x, 0, rect.y) || clearColumn(rect.x, bottom, height));
}

// Ground truth: the background 4-connected to the frame edge, as findContours
// sees it (a zero border around the frame).
function outerBackground(mask, width, height) {
  const outer = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let top = 0;
  const push = (p) => { if (!outer[p] && !mask[p]) { outer[p] = 1; stack[top++] = p; } };
  for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { push(y * width); push(y * width + width - 1); }
  while (top) {
    const p = stack[--top], x = p % width;
    if (x > 0) push(p - 1);
    if (x < width - 1) push(p + 1);
    if (p >= width) push(p - width);
    if (p < (height - 1) * width) push(p + width);
  }
  return outer;
}

function plane(rows) {
  const height = rows.length, width = rows[0].length, mask = new Uint8Array(width * height);
  rows.forEach((row, y) => [...row].forEach((c, x) => { if (c === '#') mask[y * width + x] = 255; }));
  return { mask, width, height };
}

function disc(mask, width, height, cx, cy, r) {
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if (x >= 0 && y >= 0 && x < width && y < height && (x - cx) ** 2 + (y - cy) ** 2 <= r * r) mask[y * width + x] = 255;
  }
}

// A ring of 1-px dots at every half degree: joined by diagonal steps as well
// as straight ones, so its hole is closed for 4-connected background.
function ring(mask, width, height, cx, cy, r, thick = 0) {
  for (let a = 0; a < 720; a++) {
    disc(mask, width, height, Math.round(cx + r * Math.cos(a * Math.PI / 360)), Math.round(cy + r * Math.sin(a * Math.PI / 360)), thick);
  }
}

function makeSource(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  let n = 7;
  for (let i = 0; i < data.length; i += 4) {
    const p = i >> 2, x = p % width, y = (p - x) / width;
    for (let c = 0; c < 3; c++) {
      n = (Math.imul(n, 1103515245) + 12345) >>> 0;
      data[i + c] = (40 + ((x * (c + 2) + y * (4 - c)) >> 3) + (n >>> 28)) & 255;
    }
    data[i + 3] = 255;
  }
  return new ImageData(data, width, height);
}

// One stroke through applyDustStroke: its count must equal a full recount.
// Returns whether it recounted the whole frame and whether the old four runs
// were all blocked for its R (so that the search decided).
function strokeAndCheck(worker, stroke, label) {
  const { width, height } = worker.source;
  Object.assign(spy, { armed: true, width, height, frames: 0 });
  const patch = applyDustStroke(worker, stroke);
  spy.armed = false;
  assert.ok(patch, `${label}: the stroke sets pixels`);
  assert.equal(patch.particleCount, countMaskParticles(worker.mask, width, height), `${label}: count equals a full recount`);
  return { patch, recounted: recountedFrame(patch.rect, width, height), runsBlocked: fourRunsMayBeEnclosed(worker.mask, width, height, patch.rect) };
}

// 1. The topology the search relies on.
{
  const cases = [
    [1, 'a ring closed by diagonal joints holds its speck', [
      '.........',
      '...###...',
      '..#...#..',
      '.#..#..#.',
      '..#...#..',
      '...###...',
      '.........']],
    [2, 'a one-pixel straight gap opens the ring', [
      '.........',
      '.#######.',
      '.#.....#.',
      '.#..#....',
      '.#.....#.',
      '.#######.',
      '.........']],
    [2, 'a U closed only by the frame edge holds nothing', [
      '#######',
      '......#',
      '...#..#',
      '......#',
      '#######']],
    [1, 'a ring on the frame edge still holds its speck', [
      '#######',
      '#.....#',
      '#..#..#',
      '#.....#',
      '#######']],
  ];
  for (const [count, label, rows] of cases) {
    const { mask, width, height } = plane(rows);
    assert.equal(countMaskParticles(mask, width, height), count, label);
  }
}

// 2. Built cases on a 240×180 frame. R = 20×20 at (110, 80) for the direct
// calls; the strokes, a small dot at (135, 90), get an R of their own (it
// closes over the speck at (120, 90) where there is one). The dot is a new
// particle, so counting R alone would add one even where the truth is that
// nothing changed: only a correct decision gives the exact count. Bars block
// the straight runs of any R in 100-140 × 70-110, so the search decides.
{
  const width = 240, height = 180;
  const source = makeSource(width, height);
  const rect = { x: 110, y: 80, width: 20, height: 20 };
  const fresh = () => new Uint8Array(width * height);
  const row = (mask, y, x0, x1) => { for (let x = x0; x <= x1; x++) mask[y * width + x] = 255; };
  const column = (mask, x, y0, y1) => { for (let y = y0; y <= y1; y++) mask[y * width + x] = 255; };
  // A worker whose count is known, as after a detection while pinned.
  const worker = (mask) => ({ source, mask, particleCount: countMaskParticles(mask, width, height) });
  const dot = (x, y) => ({ points: [{ x, y }], brushRadius: 2, mode: 'direct' });

  // (a) Short bars across all four runs, open background around them.
  {
    const mask = fresh();
    column(mask, 40, 60, 120); column(mask, 200, 60, 120);
    row(mask, 30, 90, 150); row(mask, 150, 90, 150);
    assert.equal(fourRunsMayBeEnclosed(mask, width, height, rect), true, '(a) the four runs are blocked');
    assert.equal(searchBackgroundToEdge(mask, width, height, rect), 'open', '(a) open');
    assert.equal(mayBeEnclosed(mask, width, height, rect), false, '(a) no recount');
    const { recounted, runsBlocked } = strokeAndCheck(worker(mask), dot(135, 90), '(a)');
    assert.equal(runsBlocked, true, '(a) the stroke\'s four runs are blocked');
    assert.equal(recounted, false, '(a) the stroke counts R alone');
  }

  // (b) A deep cup around R, open upwards, near the bottom edge, and a bar
  // above its mouth: searching only toward the nearest edge would fill the
  // cup (~26 000 background pixels); the upward order climbs out.
  {
    const mask = fresh();
    column(mask, 30, 20, 170); column(mask, 209, 20, 170); row(mask, 170, 30, 209);
    row(mask, 10, 90, 150);
    const cup = { x: 110, y: 140, width: 20, height: 20 };
    assert.equal(fourRunsMayBeEnclosed(mask, width, height, cup), true, '(b) the four runs are blocked');
    assert.equal(searchBackgroundToEdge(mask, width, height, cup, 2000), 'open', '(b) open within 2000 expansions');
    assert.equal(mayBeEnclosed(mask, width, height, cup), false, '(b) no recount');
    const { recounted, runsBlocked } = strokeAndCheck(worker(mask), dot(126, 150), '(b)');
    assert.equal(runsBlocked, true, '(b) the stroke\'s four runs are blocked');
    assert.equal(recounted, false, '(b) the stroke counts R alone');
  }

  // (c) A ring closed by diagonal joints around R, a speck inside it.
  {
    const mask = fresh();
    ring(mask, width, height, 120, 90, 45);
    disc(mask, width, height, 120, 90, 3);
    assert.equal(countMaskParticles(mask, width, height), 1, '(c) the inner speck is not external');
    // Closed regions this wide outlast the default budget, which means a
    // recount as well; unbounded, the search names them.
    assert.equal(searchBackgroundToEdge(mask, width, height, rect, Infinity), 'closed', '(c) closed');
    assert.equal(mayBeEnclosed(mask, width, height, rect), true, '(c) recount');
    const state = worker(mask);
    const { recounted } = strokeAndCheck(state, dot(135, 90), '(c)');
    assert.equal(recounted, true, '(c) the stroke recounts the frame');
    assert.equal(state.particleCount, 1);
  }

  // A box around R, walls one pixel wide (rows 50 and 130, columns 70 and
  // 170), and a speck inside it. `side` builds its right wall.
  const box = (side) => {
    const mask = fresh();
    row(mask, 50, 70, 170); row(mask, 130, 70, 170); column(mask, 70, 50, 130);
    side(mask);
    disc(mask, width, height, 120, 90, 3);
    return mask;
  };

  // (d) The right wall steps out by one column below row 90; the two halves
  // touch only diagonally, at (170, 90) and (171, 91): closed.
  {
    const mask = box((m) => { column(m, 170, 50, 90); column(m, 171, 91, 130); m[130 * width + 171] = 255; });
    assert.equal(countMaskParticles(mask, width, height), 1, '(d) a diagonal joint closes the box');
    assert.equal(searchBackgroundToEdge(mask, width, height, rect, Infinity), 'closed', '(d) closed');
    assert.equal(mayBeEnclosed(mask, width, height, rect), true, '(d) recount');
    const { recounted } = strokeAndCheck(worker(mask), dot(135, 90), '(d)');
    assert.equal(recounted, true, '(d) the stroke recounts the frame');
  }

  // (e) The same box with the lower half starting one row lower: a one-pixel
  // straight gap at (171, 91) opens it.
  {
    const mask = box((m) => { column(m, 170, 50, 90); column(m, 171, 92, 130); m[130 * width + 171] = 255; });
    assert.equal(countMaskParticles(mask, width, height), 2, '(e) the gap opens the box');
    assert.equal(fourRunsMayBeEnclosed(mask, width, height, rect), true, '(e) the four runs are blocked');
    assert.equal(searchBackgroundToEdge(mask, width, height, rect), 'open', '(e) open');
    assert.equal(mayBeEnclosed(mask, width, height, rect), false, '(e) no recount');
    const { recounted, runsBlocked } = strokeAndCheck(worker(mask), dot(135, 90), '(e)');
    assert.equal(runsBlocked, true, '(e) the stroke\'s four runs are blocked');
    assert.equal(recounted, false, '(e) the stroke counts R alone');
  }

  // (f) A U whose arms end on the left frame edge, a bar inside it across
  // the runs to the left: closed only by the edge, which findContours keeps
  // open.
  {
    const mask = fresh();
    row(mask, 50, 0, 170); row(mask, 130, 0, 170); column(mask, 170, 50, 130);
    column(mask, 40, 60, 120);
    disc(mask, width, height, 120, 90, 3);
    assert.equal(countMaskParticles(mask, width, height), 3, '(f) the inner speck is external');
    assert.equal(fourRunsMayBeEnclosed(mask, width, height, rect), true, '(f) the four runs are blocked');
    assert.equal(searchBackgroundToEdge(mask, width, height, rect), 'open', '(f) open through the frame edge');
    assert.equal(mayBeEnclosed(mask, width, height, rect), false, '(f) no recount');
    const { recounted, runsBlocked } = strokeAndCheck(worker(mask), dot(135, 90), '(f)');
    assert.equal(runsBlocked, true, '(f) the stroke\'s four runs are blocked');
    assert.equal(recounted, false, '(f) the stroke counts R alone');
  }

  // (g) The U closed by a wall on the frame edge itself: closed.
  {
    const mask = fresh();
    row(mask, 50, 0, 170); row(mask, 130, 0, 170); column(mask, 170, 50, 130);
    column(mask, 0, 50, 130);
    disc(mask, width, height, 120, 90, 3);
    assert.equal(countMaskParticles(mask, width, height), 1, '(g) the inner speck is not external');
    assert.equal(searchBackgroundToEdge(mask, width, height, rect, Infinity), 'closed', '(g) closed');
    assert.equal(mayBeEnclosed(mask, width, height, rect), true, '(g) recount');
    const { recounted } = strokeAndCheck(worker(mask), dot(135, 90), '(g)');
    assert.equal(recounted, true, '(g) the stroke recounts the frame');
  }

  // (h) The budget: a closed ring too wide to search out runs out of it, which
  // also means a recount; without a budget the search finds it closed.
  {
    const mask = fresh();
    ring(mask, width, height, 120, 90, 80);
    assert.equal(searchBackgroundToEdge(mask, width, height, rect), 'unknown', '(h) the default budget runs out');
    assert.equal(searchBackgroundToEdge(mask, width, height, rect, Infinity), 'closed', '(h) closed without a budget');
    assert.equal(mayBeEnclosed(mask, width, height, rect), true, '(h) recount');
  }

  // (i) R on the frame edge: what lies inside it touches the outside.
  {
    const mask = fresh();
    ring(mask, width, height, 120, 90, 45);
    const edge = { x: 0, y: 80, width: 20, height: 20 };
    assert.equal(searchBackgroundToEdge(mask, width, height, edge), 'open');
    assert.equal(mayBeEnclosed(mask, width, height, edge), false);
  }
}

// 3. The search against a full background flood on random masks: specks and
// straight walls, and around R most of the time a box with one-pixel walls
// (some with a straight one-pixel gap, some with a diagonal joint) or a ring
// of dots (some cut). R's ring is cleared, as the closed rect has it.
let openTrials = 0, closedTrials = 0;
for (let trial = 0; trial < 2500; trial++) {
  const width = 40 + int(120), height = 30 + int(90);
  const mask = new Uint8Array(width * height);
  const set = (x, y) => { if (x >= 0 && y >= 0 && x < width && y < height) mask[y * width + x] = 255; };
  const density = random();
  for (let k = int(Math.round(density * width * height / 60)); k > 0; k--) disc(mask, width, height, int(width), int(height), int(3));
  for (let k = int(3); k > 0; k--) {
    const horizontal = random() < 0.5, at = horizontal ? int(height) : int(width);
    const from = int(horizontal ? width : height), to = from + int(horizontal ? width : height);
    for (let i = from; i < to; i++) if (horizontal) set(i, at); else set(at, i);
  }
  const rw = 3 + int(Math.min(25, width - 4)), rh = 3 + int(Math.min(25, height - 4));
  const rect = { x: 1 + int(width - rw - 1), y: 1 + int(height - rh - 1), width: rw, height: rh };
  const kind = int(4);
  if (kind <= 1) {
    const m = 1 + int(8);
    const x0 = rect.x - m, y0 = rect.y - m, x1 = rect.x + rw - 1 + m, y1 = rect.y + rh - 1 + m;
    const joint = random() < 0.3 ? y0 + 1 + int(y1 - y0 - 1) : null;
    for (let x = x0; x <= x1; x++) { set(x, y0); set(x, y1); }
    for (let y = y0; y <= y1; y++) { set(x0, y); set(joint !== null && y > joint ? x1 + 1 : x1, y); }
    if (joint !== null) set(x1 + 1, y1);
    else if (random() < 0.5) {
      const x = x0 + 1 + int(x1 - x0 - 1);
      if (x >= 0 && x < width && y0 >= 0) mask[y0 * width + x] = 0;
    }
  } else if (kind === 2) {
    const r = Math.ceil(Math.hypot(rw, rh) / 2) + 2 + int(10);
    const cx = rect.x + (rw >> 1), cy = rect.y + (rh >> 1);
    ring(mask, width, height, cx, cy, r);
    if (random() < 0.5) {
      const a = random() * 2 * Math.PI, x = Math.round(cx + r * Math.cos(a)), y = Math.round(cy + r * Math.sin(a));
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (x + dx >= 0 && y + dy >= 0 && x + dx < width && y + dy < height) mask[(y + dy) * width + x + dx] = 0;
      }
    }
  }
  for (let x = rect.x; x < rect.x + rw; x++) { mask[rect.y * width + x] = 0; mask[(rect.y + rh - 1) * width + x] = 0; }
  for (let y = rect.y; y < rect.y + rh; y++) { mask[y * width + rect.x] = 0; mask[y * width + rect.x + rw - 1] = 0; }
  const open = outerBackground(mask, width, height)[rect.y * width + rect.x] === 1;
  if (open) openTrials++; else closedTrials++;
  const label = `trial ${trial} (${width}x${height}, ${JSON.stringify(rect)})`;
  assert.equal(searchBackgroundToEdge(mask, width, height, rect, Infinity), open ? 'open' : 'closed', label);
  const bounded = searchBackgroundToEdge(mask, width, height, rect);
  assert.ok(bounded === 'unknown' || bounded === (open ? 'open' : 'closed'), `${label}: bounded search`);
  if (!open) assert.equal(mayBeEnclosed(mask, width, height, rect), true, `${label}: enclosed means a recount`);
}
assert.ok(openTrials > 500 && closedTrials > 500, `both outcomes are common (${openTrials} open, ${closedTrials} closed)`);

// 4. The review's scenario at 12 MP. Its 60 MP frame had 1000 or 2000 of
// DustBrush.test's specks (mask radius 2-7, half of them along the edges),
// and the old four runs recounted ~9 % and ~28 % of strokes. Runs are shorter
// here, so 500 and then 1700 specks block them about as often or more (9 %
// and 34 % of these strokes). Hairs (long open arcs) are added, and closed
// loops with a speck inside take strokes that are truly nested.
const monteCarlo = { strokes: 0, recounts: 0, fourRuns: [], nested: 0, times: [] };
{
  const width = 4000, height = 3000;
  const source = makeSource(width, height);
  const { data } = source;
  const mask = new Uint8Array(width * height);
  const paint = (cx, cy, r) => {
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height || (x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      const i = (y * width + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 245;
    }
    disc(mask, width, height, cx, cy, r + 2);
  };
  const specks = (count) => {
    for (let k = 0; k < count; k++) {
      const side = int(8);
      const cx = side === 0 ? int(4) : side === 1 ? width - 1 - int(4) : int(width);
      const cy = side === 2 ? int(4) : side === 3 ? height - 1 - int(4) : int(height);
      paint(cx, cy, int(6));
    }
  };
  const hairs = (count) => {
    for (let k = 0; k < count; k++) {
      const cx = int(width), cy = int(height), r = 100 + int(600), a0 = random() * 2 * Math.PI, span = 0.5 + random() * 3;
      for (let s = 0; s < r * span; s++) {
        disc(mask, width, height, Math.round(cx + r * Math.cos(a0 + s / r)), Math.round(cy + r * Math.sin(a0 + s / r)), 1);
      }
    }
  };
  const loops = [[600, 600, 90], [3400, 600, 120], [600, 2400, 150], [3400, 2400, 70]];
  const worker = { source, mask, particleCount: null };

  const randomStroke = (near) => {
    const mode = ['intelligent', 'direct', 'remove'][int(3)];
    const brushRadius = random() < 0.1 ? 20 + int(31) : 1 + int(12);
    const kind = int(10);
    let x, y;
    if (kind === 0) { x = -int(30); y = -int(30); }
    else if (kind === 1) { x = width - 1 + int(30); y = int(height); }
    else if (kind === 2) { x = int(width); y = height - 1 + int(10); }
    else if (kind <= 5) { [x, y] = near(); }
    else { x = int(width); y = int(height); }
    const points = [{ x, y }];
    for (let s = int(5); s > 0; s--) { x += int(41) - 20; y += int(41) - 20; points.push({ x, y }); }
    return { points, brushRadius, mode };
  };

  for (const [phase, addSpecks, addHairs] of [[1, 500, 4], [2, 1200, 8]]) {
    specks(addSpecks);
    hairs(addHairs);
    // Closed loops with a speck inside, drawn again in case a stroke cut one.
    for (const [cx, cy, r] of loops) { ring(mask, width, height, cx, cy, r, 1); paint(cx, cy, 2); }
    // A new detection: the worker counts it once, before the strokes.
    worker.particleCount = countMaskParticles(mask, width, height);
    // Strokes inside the loops, a new particle beside the inner speck: truly
    // nested, so the count does not move and the frame is recounted.
    for (const [cx, cy] of loops) {
      const { patch, recounted } = strokeAndCheck(worker, { points: [{ x: cx + 20 + phase, y: cy }], brushRadius: 2, mode: 'direct' }, `phase ${phase} nested at ${cx},${cy}`);
      assert.equal(patch.particleCount, patch.countBefore, `phase ${phase} nested at ${cx},${cy}: no external particle added`);
      const outer = outerBackground(mask, width, height);
      assert.equal(outer[patch.rect.y * width + patch.rect.x], 0, `phase ${phase} nested at ${cx},${cy}: R lies in a hole`);
      assert.equal(recounted, true, `phase ${phase} nested at ${cx},${cy}: the frame is recounted`);
      monteCarlo.nested++;
    }
    const specksAt = [];
    for (let p = 0; p < mask.length; p += 97) if (mask[p]) specksAt.push(p);
    const near = () => { const p = specksAt[int(specksAt.length)]; return [p % width, (p - (p % width)) / width]; };
    let fourRuns = 0, strokes = 0;
    for (let n = 0; n < 140; n++) {
      const stroke = randomStroke(near);
      Object.assign(spy, { armed: true, width, height, frames: 0 });
      const patch = applyDustStroke(worker, stroke);
      spy.armed = false;
      if (!patch) continue;
      strokes++;
      const label = `phase ${phase} stroke ${n} (${stroke.mode}, r=${stroke.brushRadius}, R ${JSON.stringify(patch.rect)})`;
      assert.equal(patch.particleCount, countMaskParticles(mask, width, height), `${label}: count equals a full recount`);
      const recounted = recountedFrame(patch.rect, width, height);
      if (recounted) monteCarlo.recounts++;
      if (fourRunsMayBeEnclosed(mask, width, height, patch.rect)) fourRuns++;
      const started = performance.now();
      assert.equal(mayBeEnclosed(mask, width, height, patch.rect), recounted, `${label}: recount iff the rule says so`);
      monteCarlo.times.push(performance.now() - started);
    }
    monteCarlo.strokes += strokes;
    monteCarlo.fourRuns.push(fourRuns / strokes);
  }
}
assert.ok(monteCarlo.strokes >= 200, `${monteCarlo.strokes} strokes`);
assert.ok(monteCarlo.fourRuns[0] >= 0.05 && monteCarlo.fourRuns[1] >= 0.2,
  `the old four runs recount as often as in the review (${monteCarlo.fourRuns.map((r) => (100 * r).toFixed(1))} %)`);
assert.ok(monteCarlo.recounts * 100 < monteCarlo.strokes, `under 1 % of strokes recount the frame (${monteCarlo.recounts} of ${monteCarlo.strokes})`);

const times = monteCarlo.times.sort((a, b) => a - b);
console.log(`Enclosure test: built cases, ${openTrials + closedTrials} random searches (${closedTrials} closed) equal a full flood; `
  + `12 MP: ${monteCarlo.recounts} of ${monteCarlo.strokes} strokes recount the frame `
  + `(four runs alone: ${monteCarlo.fourRuns.map((r) => (100 * r).toFixed(1) + ' %').join(', ')}), `
  + `${monteCarlo.nested} nested strokes recount, every count exact; `
  + `decision p95 ${times[Math.floor(times.length * 0.95)].toFixed(2)} ms, max ${times.at(-1).toFixed(2)} ms`);
