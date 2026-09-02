import assert from 'node:assert/strict';
import { suppressSensorDefects } from './sensorDefects.js';

const W = 64;
const H = 64;

// Deterministic PRNG so the noise field is reproducible.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return (s & 0x7fffffff) / 0x7fffffff;
  };
}

// Orange-mask-like negative: bright red, mid green, dark blue, gentle gradient, ±1.5 % grain.
// `noiseAmplitude` is the peak-to-peak fraction, one number or one per channel.
function makeNegative(seed = 7, noiseAmplitude = 0.03, base = [48000, 30000, 18000]) {
  const rnd = makeRng(seed);
  const amp = Array.isArray(noiseAmplitude) ? noiseAmplitude : [noiseAmplitude, noiseAmplitude, noiseAmplitude];
  const data = new Uint16Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const g = 1 + 0.1 * (x / W) - 0.05 * (y / H);
      for (let c = 0; c < 3; c++) {
        data[i + c] = Math.max(0, Math.min(65535, Math.round(base[c] * g * (1 + (rnd() - 0.5) * amp[c]))));
      }
      data[i + 3] = 65535;
    }
  }
  return { width: W, height: H, data };
}

// Emulates what AHD demosaicing does to a stuck photosite: the centre takes the
// stuck value, the 4-neighbours move half-way, the diagonals a quarter of the way.
function smearDefect(img, x, y, c, stuckValue) {
  const { width, data } = img;
  const spread = [
    [0, 0, 1], [1, 0, 0.5], [-1, 0, 0.5], [0, 1, 0.5], [0, -1, 0.5],
    [1, 1, 0.25], [-1, 1, 0.25], [1, -1, 0.25], [-1, -1, 0.25],
  ];
  for (const [dx, dy, f] of spread) {
    const i = ((y + dy) * width + (x + dx)) * 4 + c;
    data[i] = Math.round(data[i] + (stuckValue - data[i]) * f);
  }
}

function pixel(img, x, y, c) {
  return img.data[(y * img.width + x) * 4 + c];
}

function assertPatchRestored(repaired, clean, x, y, c, tolerance = 0.06) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const got = pixel(repaired, x + dx, y + dy, c);
      const want = pixel(clean, x + dx, y + dy, c);
      assert.ok(
        Math.abs(got - want) <= want * tolerance,
        `pixel (${x + dx},${y + dy}) ch${c}: got ${got}, clean ${want}`
      );
    }
  }
}

function countChanged(a, b) {
  let n = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) n++;
  return n;
}

// --- clean image stays untouched ---
{
  const img = makeNegative();
  const before = { ...img, data: new Uint16Array(img.data) };
  const stats = suppressSensorDefects(img);
  assert.equal(stats.repaired, 0, 'clean image must not be touched');
  assert.equal(countChanged(img, before), 0);
}

// --- dead red photosite (the exported-red-dots bug) is repaired, neighbours included ---
{
  const clean = makeNegative();
  const img = { ...clean, data: new Uint16Array(clean.data) };
  smearDefect(img, 20, 20, 0, 0);
  assert.ok(pixel(img, 20, 20, 0) === 0);
  const stats = suppressSensorDefects(img);
  assert.equal(stats.repaired, 1);
  assert.equal(stats.dead, 1);
  assert.deepEqual(stats.perChannel, [1, 0, 0]);
  assertPatchRestored(img, clean, 20, 20, 0);
  // Green/blue of the patch and everything outside the 3×3 stay bit-identical.
  let outside = 0;
  for (let i = 0; i < img.data.length; i++) {
    if (img.data[i] === clean.data[i]) continue;
    const px = (i >> 2) % W, py = Math.floor((i >> 2) / W), c = i & 3;
    assert.equal(c, 0, `only the red channel may change (idx ${i})`);
    if (Math.abs(px - 20) > 1 || Math.abs(py - 20) > 1) outside++;
  }
  assert.equal(outside, 0, 'no pixel outside the defect patch may change');
}

// --- dead green, dead blue and hot photosites are handled the same way ---
{
  const clean = makeNegative(3);
  const img = { ...clean, data: new Uint16Array(clean.data) };
  smearDefect(img, 10, 40, 1, 0);        // dead green
  smearDefect(img, 40, 10, 2, 0);        // dead blue
  smearDefect(img, 45, 45, 0, 65535);    // hot red
  smearDefect(img, 30, 30, 1, 65535);    // hot green
  const stats = suppressSensorDefects(img);
  assert.equal(stats.repaired, 4);
  assert.equal(stats.dead, 2);
  assert.equal(stats.hot, 2);
  assertPatchRestored(img, clean, 10, 40, 1);
  assertPatchRestored(img, clean, 40, 10, 2);
  assertPatchRestored(img, clean, 45, 45, 0);
  assertPatchRestored(img, clean, 30, 30, 1);
}

// --- a stuck pixel without demosaic smear (half-size decode) repairs only the centre ---
{
  const clean = makeNegative(5);
  const img = { ...clean, data: new Uint16Array(clean.data) };
  img.data[(25 * W + 25) * 4] = 0;
  const stats = suppressSensorDefects(img);
  assert.equal(stats.repaired, 1);
  assertPatchRestored(img, clean, 25, 25, 0);
  assert.equal(countChanged(img, clean), 1, 'untouched neighbours must stay bit-identical');
}

// --- neutral content (moves all channels) is real image detail: leave it alone ---
{
  const clean = makeNegative(11);
  const img = { ...clean, data: new Uint16Array(clean.data) };
  // dust speck on the negative: every channel drops to ~15 % at the centre
  for (let c = 0; c < 3; c++) smearDefect(img, 20, 20, c, Math.round(pixel(clean, 20, 20, c) * 0.15));
  // emulsion pinhole / real specular point: every channel jumps to max
  for (let c = 0; c < 3; c++) smearDefect(img, 44, 44, c, 65535);
  const before = new Uint16Array(img.data);
  const stats = suppressSensorDefects(img);
  assert.equal(stats.repaired, 0, 'neutral specks are content, not sensor defects');
  assert.deepEqual(img.data, before);
}

// --- single-channel lines and edges are never isolated points ---
{
  const clean = makeNegative(13);
  const img = { ...clean, data: new Uint16Array(clean.data) };
  for (let x = 10; x < 30; x++) img.data[(33 * W + x) * 4] = Math.round(pixel(clean, x, 33, 0) * 0.3); // dark red line
  for (let y = 0; y < H; y++) for (let x = 50; x < W; x++) img.data[(y * W + x) * 4 + 2] = 2000;    // blue step edge
  const before = new Uint16Array(img.data);
  const stats = suppressSensorDefects(img);
  assert.equal(stats.repaired, 0);
  assert.deepEqual(img.data, before);
}

// --- heavy noise (underexposed scan pushed by auto-bright) is not a field of defects ---
{
  const clean = makeNegative(17, 0.5); // ±25 % per-pixel noise
  const img = { ...clean, data: new Uint16Array(clean.data) };
  const before = new Uint16Array(img.data);
  assert.equal(suppressSensorDefects(img).repaired, 0, 'noise alone must never qualify');
  assert.deepEqual(img.data, before);
  // ...but a genuinely stuck photosite still stands out against that noise.
  smearDefect(img, 32, 32, 0, 0);
  const stats = suppressSensorDefects(img);
  assert.equal(stats.repaired, 1);
  assert.deepEqual(stats.perChannel, [1, 0, 0]);
}

// --- near-black blue channel under an orange mask: black-level zeros are not dead pixels ---
{
  const img = makeNegative(19, [0.03, 0.03, 3.0], [48000, 30000, 1200]); // blue swings −0.5…2.5× → plenty of clamped zeros
  let zeros = 0;
  for (let i = 2; i < img.data.length; i += 4) if (img.data[i] === 0) zeros++;
  assert.ok(zeros > 50, `fixture should contain black-level zeros (got ${zeros})`);
  const before = new Uint16Array(img.data);
  const stats = suppressSensorDefects(img);
  assert.equal(stats.repaired, 0, `black-floor noise flagged: ${JSON.stringify(stats)}`);
  assert.deepEqual(img.data, before);
}

// --- crushed blacks: a lone quantisation step above a flat-zero ring is not a hot pixel ---
{
  const img = makeNegative(23, 0, [0, 0, 0]);
  img.data[(30 * W + 30) * 4] = 3500;      // 1 LSB of a pushed decode
  img.data[(10 * W + 40) * 4] = 20000;     // a real hot photosite
  const stats = suppressSensorDefects(img);
  assert.equal(stats.repaired, 1);
  assert.equal(pixel(img, 30, 30, 0), 3500, 'quantisation noise must survive');
  assert.equal(pixel(img, 40, 10, 0), 0, 'strong hot pixel on black must be repaired');
}

// --- clipped highlights: a dead photosite inside a saturated red area is still repaired ---
{
  const img = makeNegative(29, 0, [65535, 30000, 18000]);
  smearDefect(img, 20, 20, 0, 0);
  const stats = suppressSensorDefects(img);
  assert.equal(stats.repaired, 1);
  assert.equal(pixel(img, 20, 20, 0), 65535);
  assert.equal(pixel(img, 21, 20, 0), 65535);
}

// --- guards ---
{
  assert.deepEqual(suppressSensorDefects(null).repaired, 0);
  assert.equal(suppressSensorDefects({ width: 3, height: 3, data: new Uint16Array(36) }).repaired, 0);
  assert.equal(suppressSensorDefects({ width: 8, height: 8, data: new Uint8ClampedArray(256) }).repaired, 0);
}

console.log('sensorDefects tests passed');
