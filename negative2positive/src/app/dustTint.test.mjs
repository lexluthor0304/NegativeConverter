// Standalone Node test for dustTint.js (#254 B) - run with:
// node negative2positive/src/app/dustTint.test.mjs
import assert from 'node:assert/strict';
import { buildDustTint, buildDustTintRect, buildDustTintInBands, dustTintCellRect, DUST_TINT_RGBA } from './dustTint.js';

// The reference: a cell is tinted when any mask pixel whose floor(x * tw / w),
// floor(y * th / h) is that cell is set.
function reference(mask, w, h, tw, th) {
  const out = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    const cx = Math.min(tw - 1, Math.floor(x * tw / w)), cy = Math.min(th - 1, Math.floor(y * th / h));
    out.set(DUST_TINT_RGBA, (cy * tw + cx) * 4);
  }
  return out;
}

let seed = 7;
const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
for (const [w, h, tw, th] of [[97, 61, 97, 61], [640, 480, 211, 158], [1000, 667, 300, 200], [333, 222, 17, 5], [50, 40, 49, 39]]) {
  const mask = new Uint8Array(w * h);
  // Sparse one-pixel specks and a few blobs.
  for (let i = 0; i < w * h / 400; i++) mask[Math.floor(random() * w * h)] = 255;
  for (let b = 0; b < 3; b++) {
    const cx = Math.floor(random() * w), cy = Math.floor(random() * h);
    for (let y = Math.max(0, cy - 4); y < Math.min(h, cy + 4); y++) for (let x = Math.max(0, cx - 4); x < Math.min(w, cx + 4); x++) mask[y * w + x] = 255;
  }
  const expected = reference(mask, w, h, tw, th);
  const tint = buildDustTint(mask, w, h, tw, th);
  assert.deepEqual(tint, expected, `${w}x${h} -> ${tw}x${th}`);
  // Every speck shows: max-pooling never skips a set pixel.
  let specks = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    const cx = Math.min(tw - 1, Math.floor(x * tw / w)), cy = Math.min(th - 1, Math.floor(y * th / h));
    assert.equal(tint[(cy * tw + cx) * 4 + 3], 128);
    specks++;
  }
  assert.ok(specks > 0);
  // Bands give the same tint.
  let yields = 0;
  const banded = await buildDustTintInBands(mask, w, h, tw, th, { yieldTask: async () => { yields++; }, budgetMs: 0.01 });
  assert.deepEqual(banded, expected, 'banded tint');
  assert.ok(th < 2 || yields > 0, 'bands yield');
  assert.equal(await buildDustTintInBands(mask, w, h, tw, th, { yieldTask: async () => {}, budgetMs: 0.001, isCurrent: () => false }), th > 1 ? null : expected);
  // A rectangle's cells after a stroke changed the mask there.
  const rect = { x: Math.floor(w / 3), y: Math.floor(h / 4), width: Math.max(1, Math.floor(w / 5)), height: Math.max(1, Math.floor(h / 6)) };
  for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) mask[y * w + x] = random() < 0.3 ? 255 : 0;
  const after = reference(mask, w, h, tw, th);
  const patch = buildDustTintRect(mask, w, h, tw, th, rect);
  assert.deepEqual(patch && [patch.x, patch.y, patch.width, patch.height], (() => { const c = dustTintCellRect(rect, w, h, tw, th); return [c.x, c.y, c.width, c.height]; })());
  const patched = new Uint8ClampedArray(tint);
  for (let y = 0; y < patch.height; y++) patched.set(patch.rgba.subarray(y * patch.width * 4, (y + 1) * patch.width * 4), ((patch.y + y) * tw + patch.x) * 4);
  assert.deepEqual(patched, after, `rect patch ${w}x${h}`);
}
assert.equal(dustTintCellRect({ x: 5, y: 5, width: 0, height: 3 }, 10, 10, 5, 5), null);
console.log('dustTint.test.mjs passed');
