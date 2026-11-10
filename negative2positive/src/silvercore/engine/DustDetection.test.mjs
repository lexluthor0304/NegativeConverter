// Standalone Node test for DustDetection.js - run with:
// node negative2positive/src/silvercore/engine/DustDetection.test.mjs
//
// What counts as dust: a blob or a thin line that stands alone on a locally
// calm background, at any of the pyramid's scales, on the side of the tones
// the film puts dust on. What does not: texture, crowds, structures past the
// size cap, the frame's own border.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  detectDust, updateDustStrength, defaultMaxParticleSize, dustThresholds, dustPyramidLevels
} from './DustDetection.js';

globalThis.ImageData ||= class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };

// --- defaultMaxParticleSize scales with the short edge ---
assert.equal(defaultMaxParticleSize(6000, 4000), 64);
assert.equal(defaultMaxParticleSize(1280, 768), 12);
assert.equal(defaultMaxParticleSize(400, 300), 8); // floor

// --- every threshold relaxes as the sensitivity rises ---
for (let strength = 1; strength < 10; strength += 0.5) {
  const low = dustThresholds(strength), high = dustThresholds(strength + 0.5);
  assert.ok(high.seed <= low.seed && high.ringZ <= low.ringZ && high.crowd >= low.crowd, `thresholds relax from ${strength}`);
}
assert.equal(dustThresholds(10).crowd, Infinity, 'the highest sensitivity keeps crowds');
assert.deepEqual(dustThresholds(0), dustThresholds(1), 'out-of-range sensitivities clamp');
assert.deepEqual(dustThresholds(NaN), dustThresholds(3), 'no sensitivity is the default');

// --- the pyramid reaches blobs up to the size cap, and no further than the frame allows ---
assert.equal(dustPyramidLevels(6, 6000, 4000), 1);
assert.equal(dustPyramidLevels(10, 6000, 4000), 2);
assert.equal(dustPyramidLevels(40, 6000, 4000), 4);
assert.equal(dustPyramidLevels(80, 6000, 4000), 5);
assert.equal(dustPyramidLevels(80, 200, 150), 2, 'a small frame has few levels');

// --- without OpenCV nothing is detected ---
{
  const blank = new ImageData(new Uint8ClampedArray(64 * 64 * 4).fill(128), 64, 64);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const none = detectDust(blank, { strength: 5 });
    assert.equal(none.mask.length, 64 * 64);
    assert.equal(none.mask.some(Boolean), false);
    assert.equal(none._state, null);
  } finally { console.warn = warn; }
}

const require = createRequire(import.meta.url);
globalThis.cv = await require('@techstark/opencv-js');

// A frame of film grain around a mid grey, the same for the same seed.
function grainFrame(width, height, { seed = 7, level = 128, grain = 4 } = {}) {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const grey = new Float32Array(width * height);
  for (let i = 0; i < grey.length; i++) {
    // The sum of four uniforms is close to a normal distribution.
    grey[i] = level + grain * (random() + random() + random() + random() - 2) * Math.sqrt(3);
  }
  return { width, height, grey, random };
}
function toImage({ width, height, grey }) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < grey.length; p++) {
    const v = Math.max(0, Math.min(255, Math.round(grey[p])));
    data[p * 4] = data[p * 4 + 1] = data[p * 4 + 2] = v; data[p * 4 + 3] = 255;
  }
  return new ImageData(data, width, height);
}
// A hard speck (a disc) or a soft one (a Gaussian) added to the grey values.
function disc(frame, cx, cy, radius, amount) {
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) continue;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) frame.grey[y * frame.width + x] += amount;
    }
  }
}
function soft(frame, cx, cy, sigma, amount) {
  const reach = Math.ceil(sigma * 4);
  for (let y = cy - reach; y <= cy + reach; y++) for (let x = cx - reach; x <= cx + reach; x++) {
    if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) continue;
    frame.grey[y * frame.width + x] += amount * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * sigma * sigma));
  }
}
const maskedAt = (result, width, x, y) => result.mask[y * width + x] > 0;
const area = result => result.mask.reduce((sum, v) => sum + (v ? 1 : 0), 0);

// --- 1. Hard and soft specks on grain are found; grain alone is not ---
{
  const clean = grainFrame(640, 480);
  const none = detectDust(toImage(clean), { strength: 3, maxParticleSize: 40 });
  assert.equal(none.particleCount, 0, 'grain alone holds no dust at the default sensitivity');
  assert.equal(area(none), 0);

  const frame = grainFrame(640, 480);
  disc(frame, 120, 100, 2, 60);      // a sharp speck
  soft(frame, 400, 300, 4, 18);      // a soft one: +18 over a grain of 4, far below the grain at full size
  disc(frame, 500, 90, 5, 40);       // a larger sharp one
  const found = detectDust(toImage(frame), { strength: 3, maxParticleSize: 40 });
  assert.equal(found.particleCount, 3, 'the three specks, nothing else');
  for (const [x, y] of [[120, 100], [400, 300], [500, 90]]) assert.ok(maskedAt(found, 640, x, y), `the speck at ${x},${y} is masked`);
  // The soft speck's mask reaches its skirt, not just its peak.
  assert.ok(maskedAt(found, 640, 405, 300) && maskedAt(found, 640, 400, 295), 'a soft speck is masked to its skirt');
  assert.ok(!maskedAt(found, 640, 430, 300), 'and no further');
  // The same frame gives the same mask.
  assert.deepEqual(detectDust(toImage(frame), { strength: 3, maxParticleSize: 40 }).mask, found.mask);
}

// --- 2. Polarity: a negative's dust is bright on the frame, a positive's is dark ---
{
  const frame = grainFrame(480, 360, { seed: 11 });
  disc(frame, 100, 100, 3, 50);   // bright
  disc(frame, 300, 200, 3, -50);  // dark
  const image = toImage(frame);
  const bright = detectDust(image, { strength: 3, maxParticleSize: 40 });
  assert.ok(maskedAt(bright, 480, 100, 100) && !maskedAt(bright, 480, 300, 200), 'the default looks for bright dust');
  assert.deepEqual(detectDust(image, { strength: 3, maxParticleSize: 40, polarity: 'bright' }).mask, bright.mask);
  const dark = detectDust(image, { strength: 3, maxParticleSize: 40, polarity: 'dark' });
  assert.ok(!maskedAt(dark, 480, 100, 100) && maskedAt(dark, 480, 300, 200), 'a positive looks for dark dust');
  const both = detectDust(image, { strength: 3, maxParticleSize: 40, polarity: 'both' });
  assert.ok(maskedAt(both, 480, 100, 100) && maskedAt(both, 480, 300, 200));
  assert.equal(both.particleCount, 2);
  assert.deepEqual(detectDust(image, { strength: 3, maxParticleSize: 40, polarity: 'sideways' }).mask, bright.mask, 'an unknown polarity is the default');
}

// --- 3. A speck in texture is left alone; the same speck beside it is found ---
{
  const frame = grainFrame(640, 480, { seed: 13 });
  // Texture on the left half: strong detail a couple of pixels across (foliage, fabric).
  const detail = new Float32Array(300 * 480);
  for (let i = 0; i < detail.length; i++) detail[i] = (frame.random() - 0.5) * 220;
  for (let y = 1; y < 479; y++) for (let x = 1; x < 299; x++) {
    let sum = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += detail[(y + dy) * 300 + x + dx];
    frame.grey[y * 640 + x] += sum / 9 * 1.6;
  }
  disc(frame, 150, 240, 2.5, 60);
  disc(frame, 480, 240, 2.5, 60);
  const found = detectDust(toImage(frame), { strength: 3, maxParticleSize: 40 });
  assert.ok(maskedAt(found, 640, 480, 240), 'the speck on the calm side is masked');
  let inTexture = 0;
  for (let y = 0; y < 480; y++) for (let x = 0; x < 280; x++) inTexture += found.mask[y * 640 + x] ? 1 : 0;
  assert.equal(inTexture, 0, 'nothing in the texture is masked');
}

// --- 4. Past the size cap only what looks like a hair is taken: thin, long
// and bent. Straight lines and thick ones are image content (seams, wires,
// stripes, lamps), and so is the frame's own border ---
{
  const frame = grainFrame(800, 600, { seed: 17 });
  const hair = [];
  for (let t = 0; t <= 1; t += 0.002) {
    const x = 200 + 220 * t, y = 150 + 160 * t + 30 * Math.sin(t * 6);
    hair.push([Math.round(x), Math.round(y)]);
    disc(frame, x, y, 1.2, 14);
  }
  // A straight thin line (a seam, a wire), a bent thick one (a stripe on
  // cloth), a bright line along the top edge (the border of the frame).
  const seam = [], stripe = [];
  for (let x = 520; x < 760; x++) { seam.push([x, 420 + Math.round((x - 520) * 0.05)]); disc(frame, x, 420 + (x - 520) * 0.05, 1.2, 40); }
  for (let t = 0; t <= 1; t += 0.002) {
    const x = 60 + 240 * t, y = 470 + 40 * Math.sin(t * 3);
    stripe.push([Math.round(x), Math.round(y)]);
    disc(frame, x, y, 6, 3);
  }
  for (let x = 40; x < 700; x++) for (let y = 3; y < 6; y++) frame.grey[y * 800 + x] += 60;
  const found = detectDust(toImage(frame), { strength: 3, maxParticleSize: 40 });
  const share = line => line.filter(([x, y]) => maskedAt(found, 800, x, y)).length / line.length;
  assert.ok(share(hair) > 0.95, `the hair is masked along ${(share(hair) * 100).toFixed(0)} % of its length`);
  assert.equal(found.particleCount, 1, 'the hair is the one particle');
  assert.equal(share(seam), 0, 'a straight line is left');
  assert.equal(share(stripe), 0, 'a thick line is left');
  for (let x = 40; x < 700; x += 20) assert.ok(!maskedAt(found, 800, x, 4), 'the frame border is left');
  // A thick bent piece a little past the cap is not a hair: the cap decides.
  const fibre = grainFrame(480, 360, { seed: 18 });
  for (let t = 0; t <= 1;) {
    disc(fibre, 200 + 44 * t, 180 + 22 * Math.sin(t * Math.PI), 4, 3);
    t += 0.5 / Math.hypot(44, 22 * Math.PI * Math.cos(t * Math.PI)); // evenly along it
  }
  const piece = toImage(fibre);
  assert.equal(detectDust(piece, { strength: 3, maxParticleSize: 40 }).particleCount, 0, 'a thick piece past the cap is left');
  const raised = detectDust(piece, { strength: 3, maxParticleSize: 60 });
  assert.equal(raised.particleCount, 1, 'a cap past it takes it');
  assert.ok(maskedAt(raised, 480, 222, 202));
}

// --- 4b. The frame's border is straight: a bent hair along the edge, running
// off the frame at both ends, is a hair ---
{
  const frame = grainFrame(800, 600, { seed: 23 });
  const hair = [];
  for (let t = 0; t <= 1; t += 0.002) {
    const x = 799 - 8 * Math.sin(t * Math.PI), y = 100 + 140 * t;
    hair.push([Math.round(x), Math.round(y)]);
    disc(frame, x, y, 1.2, 14);
  }
  const found = detectDust(toImage(frame), { strength: 3, maxParticleSize: 40 });
  const share = hair.filter(([x, y]) => maskedAt(found, 800, x, y)).length / hair.length;
  assert.ok(share > 0.9, `the hair at the edge is masked along ${(share * 100).toFixed(0)} % of its length`);
}

// --- 4c. Dust lies on the film, so it is as sharp as the film: a line as
// thin but with wide soft shoulders (a seam, a crease in the picture) is left ---
{
  // Large enough that the shouldered line's core still counts as thin.
  const width = 1800, height = 1400;
  const path = t => [150 + 260 * t, 200 + 90 * t + 40 * Math.sin(t * 5)];
  const at = ([x, y]) => [Math.round(x), Math.round(y)];
  // And a short sharp straight piece within the cap: an elongated speck, read as a short line.
  const piece = t => [900 + 35 * t, 900 + 3 * t];
  const sharp = grainFrame(width, height, { seed: 29 });
  for (let t = 0; t <= 1; t += 0.002) disc(sharp, ...path(t), 1.2, 14);
  for (let t = 0; t <= 1; t += 0.014) disc(sharp, ...piece(t), 1.2, 14);
  const found = detectDust(toImage(sharp), { strength: 3, maxParticleSize: 40 });
  assert.ok(maskedAt(found, width, ...at(path(0.5))), 'the sharp line is a hair');
  assert.ok(maskedAt(found, width, ...at(piece(0.5))), 'the sharp piece is a fibre');
  const shouldered = grainFrame(width, height, { seed: 29 });
  for (let t = 0; t <= 1; t += 0.002) {
    disc(shouldered, ...path(t), 1.2, 14);
    disc(shouldered, ...path(t), 8, 1.2);
  }
  const left = detectDust(toImage(shouldered), { strength: 3, maxParticleSize: 40 });
  assert.ok(!maskedAt(left, width, ...at(path(0.5))), 'the soft-shouldered line is left');
}

// --- 4d. A hair ends where it ends. A line that runs on into busy detail is
// a line of the picture, found only along its calm stretch ---
{
  const frame = grainFrame(900, 600, { seed: 31 });
  // Busy detail on the right: a small bright speck in every 3 x 3 cell (foliage, gravel).
  for (let cy = 0; cy + 3 <= 600; cy += 3) for (let cx = 640; cx + 3 <= 900; cx += 3) {
    disc(frame, cx + frame.random() * 3, cy + frame.random() * 3, 1.2, 40);
  }
  const line = (x0, y0, x1, y1) => {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.5);
    for (let k = 0; k <= steps; k++) disc(frame, x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps, 1.2, 14);
  };
  line(200, 150, 236, 154);   // a short straight fibre, a little past the cap
  line(580, 420, 880, 450);   // a wire whose calm stretch is as long
  // Past the cap (20 px) both are read as hairs; within it (40 px) as
  // elongated specks, which are short lines: the same holds.
  for (const maxParticleSize of [20, 40]) {
    const found = detectDust(toImage(frame), { strength: 3, maxParticleSize });
    assert.ok(maskedAt(found, 900, 218, 152), `the line that ends is dust (cap ${maxParticleSize})`);
    for (const x of [585, 595, 605]) {
      assert.ok(!maskedAt(found, 900, x, 420 + Math.round((x - 580) * 0.1)), `the line that goes on is left at x ${x} (cap ${maxParticleSize})`);
    }
    assert.equal(found.particleCount, 1);
  }
}

// --- 4e. A hair is long for its thickness: a stub past the cap but only a few
// times as long as it is thick (a post, a lit edge) is left, the same line
// drawn longer is a hair ---
{
  const frame = grainFrame(1800, 1400, { seed: 37 });
  const line = (x0, y0, x1, y1) => {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.5);
    for (let k = 0; k <= steps; k++) disc(frame, x0 + (x1 - x0) * k / steps, y0 + (y1 - y0) * k / steps, 2.5, 6);
  };
  line(900, 700, 940, 703);
  line(300, 300, 360, 305);
  const found = detectDust(toImage(frame), { strength: 3, maxParticleSize: 30 });
  assert.ok(!maskedAt(found, 1800, 920, 701), 'the stub is left');
  assert.ok(maskedAt(found, 1800, 330, 302), 'the longer line is a hair');
  assert.equal(found.particleCount, 1);
}

// --- 5. The size cap: a blob past it is image content, until the cap is raised ---
{
  const frame = grainFrame(640, 480, { seed: 19 });
  soft(frame, 320, 240, 14, 40); // about 33 px across at half its height
  disc(frame, 100, 100, 2, 60);
  const image = toImage(frame);
  const capped = detectDust(image, { strength: 3, maxParticleSize: 20 });
  assert.ok(maskedAt(capped, 640, 100, 100) && !maskedAt(capped, 640, 320, 240), 'a blob past the cap stays');
  const raised = detectDust(image, { strength: 3, maxParticleSize: 60 });
  assert.ok(maskedAt(raised, 640, 320, 240), 'a higher cap takes it');
  // An out-of-focus fibre within the cap, thick, soft-edged and elongated, is
  // a speck: only a thin elongated speck is read as a short line.
  const clump = grainFrame(800, 600, { seed: 41 });
  for (let k = 0; k <= 60; k++) soft(clump, 300 + k, 300 + Math.round(k * 0.2), 6, 2);
  const blurred = detectDust(toImage(clump), { strength: 3, maxParticleSize: 80 });
  assert.equal(blurred.particleCount, 1, 'a soft clump within the cap is dust');
  assert.ok(maskedAt(blurred, 800, 330, 306));
}

// --- 6. Crowds are texture: many specks together are left, isolated ones are taken ---
{
  const frame = grainFrame(1200, 900, { seed: 23 });
  // 150 specks in a 300 x 300 patch (highlights in foliage), three far from it.
  const crowd = [];
  for (let k = 0; k < 150; k++) crowd.push([60 + Math.floor(frame.random() * 300), 60 + Math.floor(frame.random() * 300)]);
  for (const [x, y] of crowd) disc(frame, x, y, 2, 60);
  const alone = [[800, 200], [1000, 700], [500, 800]];
  for (const [x, y] of alone) disc(frame, x, y, 2, 60);
  const image = toImage(frame);
  const found = detectDust(image, { strength: 3, maxParticleSize: 40 });
  for (const [x, y] of alone) assert.ok(maskedAt(found, 1200, x, y), `the isolated speck at ${x},${y} is masked`);
  // The body of the crowd is left; specks on its fringe, where the
  // neighbourhood reaches past it, may be taken.
  const body = crowd.filter(([x, y]) => x >= 150 && x <= 270 && y >= 150 && y <= 270);
  assert.ok(body.length > 15 && body.every(([x, y]) => !maskedAt(found, 1200, x, y)), 'the body of the crowd is left alone');
  const taken = crowd.filter(([x, y]) => maskedAt(found, 1200, x, y)).length;
  assert.ok(taken < crowd.length / 2, `most of the crowd is left (${taken} of ${crowd.length} taken)`);
  const everything = detectDust(image, { strength: 10, maxParticleSize: 40 });
  assert.ok(crowd.filter(([x, y]) => maskedAt(everything, 1200, x, y)).length > 140, 'the highest sensitivity takes the crowd too');
}

// --- 7. A detection answers every lower sensitivity and smaller cap from its state ---
{
  const frame = grainFrame(640, 480, { seed: 29 });
  for (let k = 0; k < 40; k++) {
    const x = 20 + Math.floor(frame.random() * 600), y = 20 + Math.floor(frame.random() * 440);
    if (frame.random() < 0.5) disc(frame, x, y, 1 + frame.random() * 3, 8 + frame.random() * 50);
    else soft(frame, x, y, 2 + frame.random() * 4, 6 + frame.random() * 30);
  }
  const image = toImage(frame);
  const first = detectDust(image, { strength: 8, maxParticleSize: 40 });
  assert.ok(first._state.records instanceof Float64Array, 'the state holds the candidates');
  let last = Infinity;
  for (const strength of [8, 7.5, 5, 3, 2, 1]) {
    const fresh = detectDust(image, { strength, maxParticleSize: 40 });
    const reused = updateDustStrength(image, first._state, strength, 40);
    assert.equal(reused._state, first._state, `strength ${strength} is answered from the state`);
    assert.deepEqual(reused.mask, fresh.mask, `and gives the fresh mask at strength ${strength}`);
    assert.equal(reused.particleCount, fresh.particleCount);
    assert.ok(fresh.particleCount <= last, 'a lower sensitivity finds no more');
    last = fresh.particleCount;
  }
  // Another cap that needs no more levels is a selection too.
  for (const cap of [30, 80]) {
    const capped = updateDustStrength(image, first._state, 3, cap);
    assert.equal(capped._state, first._state, `a cap of ${cap} px is answered from the state`);
    assert.deepEqual(capped.mask, detectDust(image, { strength: 3, maxParticleSize: cap }).mask);
  }
  // A higher sensitivity, another polarity, another frame size or no state:
  // a new detection.
  for (const [label, run, expected] of [
    ['a higher sensitivity', () => updateDustStrength(image, first._state, 10, 40), () => detectDust(image, { strength: 10, maxParticleSize: 40 })],
    ['another polarity', () => updateDustStrength(image, first._state, 3, 40, 'dark'), () => detectDust(image, { strength: 3, maxParticleSize: 40, polarity: 'dark' })],
    ['no state', () => updateDustStrength(image, null, 3, 40), () => detectDust(image, { strength: 3, maxParticleSize: 40 })],
  ]) {
    const result = run();
    assert.notEqual(result._state, first._state, `${label} detects again`);
    assert.deepEqual(result.mask, expected().mask, `${label}: the fresh mask`);
  }
  const other = toImage(grainFrame(320, 240, { seed: 31 }));
  assert.notEqual(updateDustStrength(other, first._state, 3, 40)._state, first._state, 'another frame size detects again');
  // So does a cap that needs a level the detection did not scan.
  const large = toImage(grainFrame(1024, 768, { seed: 41 }));
  const few = detectDust(large, { strength: 3, maxParticleSize: 20 });
  assert.ok(dustPyramidLevels(80, 1024, 768) > dustPyramidLevels(20, 1024, 768));
  assert.notEqual(updateDustStrength(large, few._state, 3, 80)._state, few._state, 'a cap that needs another level detects again');
}

// --- 8. Detection is local: tones changed in one place (a dodge-and-burn
// stroke, a sign, a shadow) leave what is found far from it as it was ---
{
  const width = 1600, height = 1200;
  const frame = grainFrame(width, height, { seed: 43 });
  for (let k = 0; k < 60; k++) {
    disc(frame, 30 + Math.floor(frame.random() * (width - 60)), 30 + Math.floor(frame.random() * (height - 60)), 1 + frame.random() * 2, 20 + frame.random() * 40);
  }
  const before = detectDust(toImage(frame), { strength: 3, maxParticleSize: 12 });
  // A two-stop burn over a 200 px box in the middle, with texture in it.
  const box = { x0: 700, y0: 500, x1: 900, y1: 700 };
  for (let y = box.y0; y < box.y1; y++) for (let x = box.x0; x < box.x1; x++) {
    frame.grey[y * width + x] = frame.grey[y * width + x] * 0.25 + ((x * 7 + y * 13) % 23);
  }
  const after = detectDust(toImage(frame), { strength: 3, maxParticleSize: 12 });
  const reach = 300;
  let compared = 0, masked = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (x >= box.x0 - reach && x < box.x1 + reach && y >= box.y0 - reach && y < box.y1 + reach) continue;
    compared++;
    masked += before.mask[y * width + x] ? 1 : 0;
    assert.equal(after.mask[y * width + x], before.mask[y * width + x], `the mask at ${x},${y}, ${reach} px from the changed box, is as it was`);
  }
  assert.ok(compared > width * height / 2 && masked > 500, 'most of the frame, with dust in it, was compared');
}

// --- 9. Odd sizes, tiny frames, flat frames: no error, no dust ---
{
  for (const [width, height] of [[1, 1], [9, 7], [33, 65], [131, 77], [257, 129]]) {
    const flat = new ImageData(new Uint8ClampedArray(width * height * 4).fill(200), width, height);
    const result = detectDust(flat, { strength: 10, maxParticleSize: 80, polarity: 'both' });
    assert.equal(result.mask.length, width * height);
    assert.equal(result.particleCount, 0, `${width}x${height}: a flat frame holds no dust`);
  }
  // A speck in the corner of an odd-sized frame is found and stays inside the mask's bounds.
  const frame = grainFrame(131, 77, { seed: 37 });
  disc(frame, 2, 2, 2, 70);
  disc(frame, 128, 74, 2, 70);
  const corner = detectDust(toImage(frame), { strength: 5, maxParticleSize: 20 });
  assert.ok(maskedAt(corner, 131, 2, 2) && maskedAt(corner, 131, 128, 74), 'specks in the corners are masked');
}

console.log('DustDetection: specks, hairs, polarity, texture, crowds, the size cap and the state');
