// AI-repair mask and per-tile overhead budgets of #246, in Node (V8).
//   node scripts/bench-repair-mask.mjs [--width 9504 --height 6320] [--reps 5]
// The default frame is a Leica M11 (60 MP, about 0.5 GB peak). On a machine
// that is also running other heavy work, pass a smaller frame; the budgets
// are only judged at the default size. Exit status 1 when a judged budget or
// the no-frame-sized-Float32Array rule fails.
import { performance } from 'node:perf_hooks';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? Number(process.argv[index + 1]) : fallback;
};
const width = arg('width', 9504), height = arg('height', 6320), reps = arg('reps', 5);
const judged = width === 9504 && height === 6320;

// Record every Float32Array the code under test allocates.
const NativeFloat32Array = Float32Array;
let frameSizedFloat32 = 0;
globalThis.Float32Array = class extends NativeFloat32Array {
  constructor(...args) {
    super(...args);
    if (this.length >= width * height) frameSizedFloat32++;
  }
};

const { buildRepairMask, sanitizeRepairStrokes } = await import('../negative2positive/src/app/repairBrush.js');
const { maskBoundingBoxes, runnerFor, createTileMemo, TILE } = await import('../negative2positive/src/app/aiInpaint.js');

const geometry = { baseWidth: width, baseHeight: height, rotationAngle: 0, mirrored: false,
  rotatedWidth: width, rotatedHeight: height, cropRegion: null, width, height };
// Default brush: 2 % of the short side, dabs spread over the frame.
const dabs = sanitizeRepairStrokes(Array.from({ length: 10 }, (_, i) => ({
  size: 0.02, points: [{ x: 0.08 + (i % 5) * 0.2, y: 0.25 + Math.floor(i / 5) * 0.5 }]
})));
// A Lensfun-like barrel map with TCA at step 8.
function lensMap(step = 8, k = 0.04) {
  const gridWidth = Math.ceil((width - 1) / step) + 1, gridHeight = Math.ceil((height - 1) / step) + 1;
  const cx = width / 2, cy = height / 2, norm = Math.hypot(cx, cy);
  const geometryGrid = new NativeFloat32Array(gridWidth * gridHeight * 2);
  const tca = new NativeFloat32Array(gridWidth * gridHeight * 6);
  for (let gy = 0; gy < gridHeight; gy++) for (let gx = 0; gx < gridWidth; gx++) {
    const dx = gx * step - cx, dy = gy * step - cy, f = 1 + k * (dx * dx + dy * dy) / (norm * norm);
    const i = gy * gridWidth + gx;
    geometryGrid[i * 2] = cx + dx * f; geometryGrid[i * 2 + 1] = cy + dy * f;
    [1.003, 1, 0.997].forEach((s, c) => { tca[i * 6 + c * 2] = cx + dx * f * s; tca[i * 6 + c * 2 + 1] = cy + dy * f * s; });
  }
  return { maps: { gridWidth, gridHeight, step, geometry: geometryGrid, tca }, includeTca: true };
}
const lens = lensMap();

function median(operation) {
  const times = [];
  let value = operation(); // warm-up, not timed
  for (let i = 0; i < reps; i++) {
    const started = performance.now();
    value = operation();
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return { ms: times[Math.floor(times.length / 2)], value };
}

const results = [];
const check = (name, budget, operation) => {
  const { ms, value } = median(operation);
  const ok = !judged || budget === null || ms <= budget;
  results.push({ name, ms: Number(ms.toFixed(2)), budget, ok });
  return value;
};
const one = check('repairMask, 1 stroke', 20, () => buildRepairMask(dabs.slice(0, 1), geometry));
check('repairMask, 10 default-size dabs', 50, () => buildRepairMask(dabs, geometry));
check('repairMask, 10 dabs, step-8 lens map with TCA', 60, () => buildRepairMask(dabs, geometry, lens));
check('maskBoundingBoxes with the bounds hint, 1 stroke', 5, () => maskBoundingBoxes(one.mask, width, height, { bounds: one.bounds }));
check('maskBoundingBoxes without a hint (reference)', null, () => maskBoundingBoxes(one.mask, width, height));

// Runner feed and output conversion per 512 px tile (session.run is instant),
// and the same with the tile memo's hashing.
class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } }
const size = TILE;
const output = new Uint8Array(3 * size * size).map((_, i) => i & 255);
const session = { inputNames: ['image', 'mask'], outputNames: ['result'],
  async run() { return { result: new Tensor('uint8', output, [1, 3, size, size]) }; } };
const image = new NativeFloat32Array(3 * size * size).map((_, i) => (i % 997) / 997);
const mask = new NativeFloat32Array(size * size).map((_, i) => (i % 11 === 0 ? 1 : 0));
async function perTile(run) {
  const times = [];
  for (let i = 0; i < Math.max(reps, 5); i++) {
    const started = performance.now();
    await run(image, mask, size);
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}
const plain = await perTile(runnerFor({ Tensor }, session));
results.push({ name: 'runnerFor feed + output conversion per tile', ms: Number(plain.toFixed(2)), budget: 10, ok: plain <= 10 });
const memo = createTileMemo();
const memoRun = runnerFor({ Tensor }, session, { memo });
const hashed = await perTile(memoRun);
results.push({ name: 'the same with tile-memo hashing (hits after the first)', ms: Number(hashed.toFixed(2)), budget: null, ok: true });

console.log(`AI-repair mask bench at ${width}x${height} (${(width * height / 1e6).toFixed(1)} MP), median of ${reps}`
  + (judged ? '' : ' (budgets not judged below 9504x6320)'));
for (const { name, ms, budget, ok } of results) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${ms} ms${budget === null ? '' : ` (budget ${budget} ms)`}`);
}
console.log(`${frameSizedFloat32 ? 'FAIL' : 'ok  '} frame-sized Float32Array allocations: ${frameSizedFloat32}`);
process.exit(results.every((entry) => entry.ok) && !frameSizedFloat32 ? 0 : 1);
