// Differential test for the exact fast sensor-defect kernel (#232): the new
// kernel must produce byte-identical pixels and identical stats to the frozen
// 1703835 kernel on every seed. Frames are small (well under 1 MP) so the
// whole sweep runs in a few seconds.
import assert from 'node:assert/strict';
import { suppressSensorDefects } from './sensorDefects.js';
import { suppressSensorDefectsReference } from './sensorDefects.reference.mjs';

function makeRng(seed) {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const clamp16 = (v) => Math.max(0, Math.min(65535, Math.round(v)));

// A frame with a smooth base per channel plus regions pinned to the black
// floor (< 3000) and to the clip (> 62000), at the seed's noise level.
function makeFrame(rnd, width, height) {
  const data = new Uint16Array(width * height * 4);
  const base = [0, 1, 2].map(() => 1500 + rnd() * 60000);
  const noise = [0, 0.004, 0.02, 0.08, 0.3][Math.floor(rnd() * 5)];
  const gx = (rnd() - 0.5) * 0.4;
  const gy = (rnd() - 0.5) * 0.4;
  const floorBox = { x0: Math.floor(rnd() * width), y0: Math.floor(rnd() * height), w: 6 + Math.floor(rnd() * width / 2), h: 6 + Math.floor(rnd() * height / 2) };
  const clipBox = { x0: Math.floor(rnd() * width), y0: Math.floor(rnd() * height), w: 6 + Math.floor(rnd() * width / 2), h: 6 + Math.floor(rnd() * height / 2) };
  const inBox = (b, x, y) => x >= b.x0 && x < b.x0 + b.w && y >= b.y0 && y < b.y0 + b.h;
  const floorChannel = Math.floor(rnd() * 4); // 3 ⇒ every channel
  const quantum = rnd() < 0.3 ? 1 + Math.floor(rnd() * 3000) : 1; // pushed-decode quantisation steps
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const g = 1 + gx * (x / width) + gy * (y / height);
      for (let c = 0; c < 3; c++) {
        let level = base[c] * g;
        if (inBox(floorBox, x, y) && (floorChannel === 3 || floorChannel === c)) level = rnd() * 2800 * (rnd() < 0.3 ? 0 : 1);
        if (inBox(clipBox, x, y)) level = 62000 + rnd() * 3535;
        let v = level * (1 + (rnd() - 0.5) * noise);
        if (quantum > 1) v = Math.round(v / quantum) * quantum;
        data[i + c] = clamp16(v);
      }
      data[i + 3] = 65535;
    }
  }
  return { width, height, data };
}

// AHD-like smear of a stuck photosite: centre, half on the 4-neighbours, a
// quarter on the diagonals.
function smear(img, x, y, c, stuck) {
  const { width, height, data } = img;
  const spread = [[0, 0, 1], [1, 0, 0.5], [-1, 0, 0.5], [0, 1, 0.5], [0, -1, 0.5], [1, 1, 0.25], [-1, 1, 0.25], [1, -1, 0.25], [-1, -1, 0.25]];
  for (const [dx, dy, f] of spread) {
    const px = x + dx, py = y + dy;
    if (px < 0 || py < 0 || px >= width || py >= height) continue;
    const i = (py * width + px) * 4 + c;
    data[i] = clamp16(data[i] + (stuck - data[i]) * f);
  }
}

function injectDefects(rnd, img) {
  const { width, height, data } = img;
  const rx = () => Math.floor(rnd() * width);
  const ry = () => Math.floor(rnd() * height);
  const stuckValue = () => (rnd() < 0.4 ? 0 : rnd() < 0.5 ? 65535 : Math.floor(rnd() * 65536));
  const count = 5 + Math.floor(rnd() * (width * height) / 150);
  for (let n = 0; n < count; n++) {
    const kind = rnd();
    const x = rx(), y = ry(), c = Math.floor(rnd() * 3);
    if (kind < 0.3) {
      // isolated single-channel defect, smeared or bare
      if (rnd() < 0.7) smear(img, x, y, c, stuckValue());
      else data[(y * width + x) * 4 + c] = stuckValue();
    } else if (kind < 0.45) {
      // cluster: several defects within a few pixels, mixed channels
      const k = 2 + Math.floor(rnd() * 4);
      for (let m = 0; m < k; m++) {
        const px = Math.min(width - 1, Math.max(0, x + Math.floor(rnd() * 7) - 3));
        const py = Math.min(height - 1, Math.max(0, y + Math.floor(rnd() * 7) - 3));
        smear(img, px, py, Math.floor(rnd() * 3), stuckValue());
      }
    } else if (kind < 0.55) {
      // adjacent pair / short run in one channel
      const v = stuckValue();
      data[(y * width + x) * 4 + c] = v;
      if (x + 1 < width) data[(y * width + x + 1) * 4 + c] = rnd() < 0.5 ? v : stuckValue();
    } else if (kind < 0.65) {
      // same pixel, several channels (correlated or partly correlated)
      const v = stuckValue();
      for (let cc = 0; cc < 3; cc++) {
        if (rnd() < 0.8) smear(img, x, y, cc, rnd() < 0.5 ? v : clamp16(v * (0.5 + rnd())));
      }
    } else if (kind < 0.85) {
      // straddling neighbours: one far below, one far above the centre, so
      // each half of the reject test is met by a different neighbour
      if (x < 1 || x >= width - 1 || y < 1 || y >= height - 1) continue;
      const i = (y * width + x) * 4 + c;
      const v = data[i];
      const lowN = Math.max(0, v - 5000 - Math.floor(rnd() * 20000));
      const highN = Math.min(65535, v + 5000 + Math.floor(rnd() * 20000));
      const pairs = [[-4, 4], [4, -4], [-width * 4, width * 4], [width * 4, -width * 4], [-4, width * 4]];
      const [a, b] = pairs[Math.floor(rnd() * pairs.length)];
      data[i + a] = lowN;
      data[i + b] = highN;
      if (rnd() < 0.5) data[i] = stuckValue();
    } else {
      // a line or edge fragment — content that must survive
      const len = 3 + Math.floor(rnd() * 10);
      const v = stuckValue();
      for (let m = 0; m < len && x + m < width; m++) data[(y * width + x + m) * 4 + c] = v;
    }
  }
}

const SIZES = [[5, 5], [6, 5], [5, 9], [17, 13], [31, 47], [64, 64], [97, 61], [128, 77], [151, 99], [203, 131]];
const OPTIONS = [
  {},
  {},
  { absoluteThreshold: 0 },
  { absoluteThreshold: 700.5 },
  { absoluteThreshold: 3000, noiseFactor: 1.3 },
  { absoluteThreshold: 9000 },                  // above the black-floor hot margin
  { noiseFactor: 0 },
  { noiseFactor: 4.75 },
  { absoluteThreshold: 1234.567, noiseFactor: 0.333 },
  { absoluteThreshold: -50, noiseFactor: -1 },
];

const SEEDS = 72;
let totalRepairs = 0;
let totalDead = 0;
let totalHot = 0;
let straddlePixels = 0;
let floorRings = 0;
let clipRings = 0;

// Count samples that the original min/max test rejects although no single
// neighbour meets both halves: the case a "one neighbour" shortcut gets wrong.
function countStraddles(img, abs) {
  const { width, height, data } = img;
  const stride = width * 4;
  let n = 0;
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const v = data[i + c];
        const ns = [data[i - 4 + c], data[i + 4 + c], data[i - stride + c], data[i + stride + c]];
        const rejected = v + abs >= Math.min(...ns) && v <= Math.max(...ns) + abs;
        if (rejected && !ns.some((m) => m <= v + abs && v <= m + abs)) n++;
      }
    }
  }
  return n;
}

for (let seed = 1; seed <= SEEDS; seed++) {
  const rnd = makeRng(seed);
  const [w, h] = SIZES[seed % SIZES.length];
  const img = makeFrame(rnd, w + Math.floor(rnd() * 3), h + Math.floor(rnd() * 3));
  injectDefects(rnd, img);
  const options = OPTIONS[seed % OPTIONS.length];
  const abs = Number.isFinite(options.absoluteThreshold) ? options.absoluteThreshold : 1500;
  straddlePixels += countStraddles(img, abs);
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i] < 3000) floorRings++;
    if (img.data[i] > 62000) clipRings++;
  }

  const reference = { width: img.width, height: img.height, data: new Uint16Array(img.data) };
  const candidate = { width: img.width, height: img.height, data: new Uint16Array(img.data) };
  const want = suppressSensorDefectsReference(reference, options);
  const got = suppressSensorDefects(candidate, options);
  assert.deepEqual(got, want, `seed ${seed}: stats differ`);
  if (Buffer.compare(Buffer.from(candidate.data.buffer), Buffer.from(reference.data.buffer)) !== 0) {
    let first = -1;
    for (let i = 0; i < candidate.data.length; i++) if (candidate.data[i] !== reference.data[i]) { first = i; break; }
    assert.fail(`seed ${seed} (${img.width}x${img.height}, ${JSON.stringify(options)}): first differing sample ${first}`);
  }
  totalRepairs += want.repaired;
  totalDead += want.dead;
  totalHot += want.hot;
}

// The sweep must actually exercise the interesting branches.
assert.ok(totalRepairs > 500, `too few repairs to be meaningful: ${totalRepairs}`);
assert.ok(totalDead > 50 && totalHot > 50, `dead ${totalDead}, hot ${totalHot}`);
assert.ok(straddlePixels > 100, `too few straddling reject cases: ${straddlePixels}`);
assert.ok(floorRings > 1000 && clipRings > 1000, `floor ${floorRings}, clip ${clipRings}`);

// Guards behave the same.
for (const input of [null, { width: 3, height: 3, data: new Uint16Array(36) }, { width: 8, height: 8, data: new Uint8ClampedArray(256) }]) {
  assert.deepEqual(suppressSensorDefects(input), suppressSensorDefectsReference(input));
}

console.log(`sensorDefects parity passed (${SEEDS} seeds, ${totalRepairs} repairs, ${straddlePixels} straddles)`);
