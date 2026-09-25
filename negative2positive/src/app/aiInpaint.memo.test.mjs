// Reuse between AI-repair commits (#246), with a deterministic stand-in for
// MI-GAN: the stroke-bounded mask feeds the same boxes, the tile memo returns
// exactly what inference would, and the setup split (first tile before the
// chunked frame copy) leaves the result byte-identical.
import assert from 'node:assert/strict';
import {
  TILE, TILE_MEMO_BYTES, MAIN_REALM_TILE_MEMO_BYTES, maskBounds, maskBoundingBoxes, tilesForBox, uniqueTiles,
  extractTile, featherWeights, createSparseBlendWeights, blendTile, inpaintWithModel, cloneImageDataChunked,
  runnerFor, createTileMemo, createInpaintSession
} from './aiInpaint.js';
import { buildRepairMask, sanitizeRepairStrokes } from './repairBrush.js';
import { createInpaintWorkerProcessor } from '../workers/aiInpaintWorkerProcessor.js';

globalThis.ImageData ||= class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };

// ---- a deterministic model behind the ONNX Runtime surface ----
class Tensor {
  constructor(type, data, dims) { Object.assign(this, { type, data, dims }); }
  dispose() { this.disposed = true; }
}
let inferences = 0;
function infer(feeds) {
  inferences++;
  const rgb = feeds.image.data, known = feeds.mask.data, size = feeds.image.dims[2], plane = size * size;
  // Every output byte depends on the whole tile, as a real inpainter's may.
  let checksum = 0;
  for (let i = 0; i < rgb.length; i += 7) checksum = (checksum * 31 + rgb[i]) >>> 0;
  for (let i = 0; i < known.length; i += 5) checksum = (checksum * 17 + known[i]) >>> 0;
  const out = new Uint8Array(rgb.length);
  for (let i = 0; i < rgb.length; i++) out[i] = (rgb[i] * 3 + (i % plane) * 7 + checksum + known[i % plane]) & 255;
  return { result: new Tensor('uint8', out, [1, 3, size, size]) };
}
const modelSession = (overrides = {}) => ({ inputNames: ['image', 'mask'], outputNames: ['result'],
  async run(feeds) { return infer(feeds); }, async release() { this.released = true; }, ...overrides });
const ort = { Tensor, InferenceSession: { create: async () => modelSession() } };

// ---- frozen setup of inpaintWithModel as of 1703835 ----
async function headInpaintWithModel(imageData, mask, run, { tile = TILE, feather = 4 } = {}) {
  const { width, height } = imageData;
  const result = new ImageData(new Uint8ClampedArray(imageData.data), width, height);
  if (imageData.__image16 && imageData.__image16.data instanceof Uint16Array) {
    result.__image16 = { width, height, data: new Uint16Array(imageData.__image16.data) };
  }
  const boxes = maskBoundingBoxes(mask, width, height);
  const tiles = uniqueTiles(boxes.flatMap((box) => tilesForBox(box, width, height, { tile })));
  const applied = createSparseBlendWeights(width);
  for (const t of tiles) {
    const inputs = extractTile(imageData, mask, t);
    let anyMask = false;
    for (let i = 0; i < inputs.mask.length; i++) if (inputs.mask[i]) { anyMask = true; break; }
    if (anyMask) {
      const weights = featherWeights(inputs.mask, t.size, feather);
      const output = await run(inputs.image, inputs.mask, t.size, { transferInputs: true });
      blendTile(result, imageData, t, output, weights, applied);
    }
  }
  return { imageData: result, tiles: tiles.length };
}
// Frozen runner conversions as of 1703835.
const headFeeds = (image, mask) => ({
  rgb: Uint8Array.from(image, (value) => Math.round(Math.min(1, Math.max(0, value)) * 255)),
  known: Uint8Array.from(mask, (value) => value > 0 ? 0 : 255)
});

// ---- fixtures ----
const W = 3000, H = 2000;
function frame(seed) {
  const data = new Uint8ClampedArray(W * H * 4), plane = new Uint16Array(W * H * 4);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const x = i % W, y = (i - x) / W;
    const v = (x * 7 + y * 13 + seed) & 0xffff;
    plane[p] = v; plane[p + 1] = (v * 3) & 0xffff; plane[p + 2] = (v ^ 0x5a5a) & 0xffff; plane[p + 3] = 65535;
    data[p] = plane[p] >> 8; data[p + 1] = plane[p + 1] >> 8; data[p + 2] = plane[p + 2] >> 8; data[p + 3] = 255;
  }
  const image = new ImageData(data, W, H);
  image.__image16 = { width: W, height: H, data: plane };
  return image;
}
const disc = (mask, cx, cy, r) => {
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if (x >= 0 && y >= 0 && x < W && y < H && Math.hypot(x - cx, y - cy) <= r) mask[y * W + x] = 255;
  }
};
const same = (a, b, label) => {
  assert.deepEqual(a.data, b.data, `${label}: 8-bit`);
  assert.deepEqual(a.__image16.data, b.__image16.data, `${label}: 16-bit`);
};
// Slots 600 px apart: a 512 px window around one never reaches another.
const slots = [];
for (let row = 0; row < 3; row++) for (let col = 0; col < 5; col++) slots.push({ x: 300 + col * 600, y: 300 + row * 600 });
const source = frame(11);
const dustSlots = slots.slice(0, 3);
const dustMask = new Uint8Array(W * H);
dustSlots.forEach(({ x, y }, i) => disc(dustMask, x + 5, y - 3, 6 + i * 3));
const geometry = { baseWidth: W, baseHeight: H, rotationAngle: 0, mirrored: false,
  rotatedWidth: W, rotatedHeight: H, cropRegion: null, width: W, height: H };
// Default brush: 2 % of the short side.
const dab = ({ x, y }) => ({ size: 0.02, points: [{ x: (x + 17) / W, y: (y + 11) / H }] });

// Chunked frame copies equal a one-shot copy, 8 and 16 bits, at any chunk size.
{
  const small = frame(3);
  for (const chunkBytes of [1, 4093, 1 << 20, 64 << 20]) {
    if (chunkBytes === 1) continue; // 24 M yields; too slow to be useful here
    const copy = await cloneImageDataChunked(small, { chunkBytes });
    assert.notEqual(copy.data, small.data);
    same(copy, { data: new Uint8ClampedArray(small.data), __image16: { data: new Uint16Array(small.__image16.data) } }, `chunk ${chunkBytes}`);
  }
  const tiny = new ImageData(Uint8ClampedArray.from({ length: 5 * 3 * 4 }, (_, i) => i * 7), 5, 3);
  const copy = await cloneImageDataChunked(tiny, { chunkBytes: 1 });
  assert.deepEqual(copy.data, tiny.data);
  assert.equal(copy.__image16, undefined, 'an 8-bit frame gains no 16-bit plane');
  let checks = 0;
  await assert.rejects(cloneImageDataChunked(small, { chunkBytes: 1 << 20, check: () => { if (++checks === 3) throw new DOMException('stop', 'AbortError'); } }), { name: 'AbortError' });
}

// The bounds hint gives the same boxes, and the stroke mask's bounds suffice.
{
  const strokes = sanitizeRepairStrokes(slots.slice(3, 9).map(dab));
  const { mask, bounds } = buildRepairMask(strokes, geometry);
  assert.deepEqual(bounds, maskBounds(mask, W, H));
  assert.deepEqual(maskBoundingBoxes(mask, W, H, { bounds }), maskBoundingBoxes(mask, W, H));
  assert.deepEqual(maskBoundingBoxes(dustMask, W, H, { bounds: maskBounds(dustMask, W, H) }), maskBoundingBoxes(dustMask, W, H));
  assert.deepEqual(maskBoundingBoxes(dustMask, W, H, { bounds: { x: -50, y: -50, width: W + 100, height: H + 100 } }), maskBoundingBoxes(dustMask, W, H));
  assert.deepEqual(maskBoundingBoxes(mask, W, H, { bounds: { x: 0, y: 0, width: 0, height: 0 } }), []);
  const started = performance.now();
  for (let i = 0; i < 20; i++) maskBoundingBoxes(mask, W, H, { bounds: buildRepairMask(strokes.slice(0, 1), geometry).bounds });
  console.log(`hinted maskBoundingBoxes + one-stroke mask at ${W}x${H}: ${((performance.now() - started) / 20).toFixed(2)} ms`);
}

// The runner's plain-loop conversions store what Uint8Array.from(..., fn) and
// Float32Array.from(..., fn) stored.
{
  const size = TILE, image = new Float32Array(3 * size * size), mask = new Float32Array(size * size);
  let state = 7;
  const next = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 4294967296;
  for (let i = 0; i < image.length; i++) image[i] = next() * 1.4 - 0.2;
  image[5] = NaN; image[6] = -0; image[7] = 1; image[8] = 0.5 / 255; image[9] = 254.5 / 255;
  for (let i = 0; i < mask.length; i++) mask[i] = next() < 0.3 ? 1 : next() < 0.1 ? 0.5 : 0;
  const expected = headFeeds(image, mask);
  let seen;
  const capture = runnerFor({ Tensor }, modelSession({ async run(feeds) { seen = feeds; return infer(feeds); } }));
  const output = await capture(image, mask, size);
  assert.deepEqual(seen.image.data, expected.rgb, 'identical rgb feed bytes');
  assert.deepEqual(seen.mask.data, expected.known, 'identical mask feed bytes');
  assert.deepEqual(output, Float32Array.from(infer(seen).result.data, (value) => value / 255), 'identical normalised output');
  const quick = runnerFor({ Tensor }, modelSession({ async run() { return { result: new Tensor('uint8', new Uint8Array(3 * size * size), [1, 3, size, size]) }; } }));
  const times = [];
  for (let i = 0; i < 9; i++) { const t = performance.now(); await quick(image, mask, size); times.push(performance.now() - t); }
  times.sort((a, b) => a - b);
  console.log(`runner feed + output conversion per 512 px tile: ${times[4].toFixed(2)} ms (median)`);
  assert.ok(times[4] < 40, `conversion stays far below the 100-130 ms of the callback form (${times[4]} ms)`);
}

// Memo: byte-bounded LRU, lookups without inserts, verify mode.
{
  const bytes = 3 * 16 * 16;
  const memo = createTileMemo({ capBytes: 3 * bytes, verify: false });
  const tileOf = (n) => ({ rgb: new Uint8Array(3 * 256).fill(n), known: new Uint8Array(256).fill(n & 1 ? 0 : 255) });
  for (let n = 0; n < 5; n++) {
    const { rgb, known } = tileOf(n);
    memo.set(memo.key(16, rgb, known), new Uint8Array(3 * 256).fill(n), rgb, known);
    assert.ok(memo.stats().bytes <= 3 * bytes);
  }
  assert.equal(memo.stats().entries, 3);
  const hit = (n) => { const { rgb, known } = tileOf(n); return memo.get(memo.key(16, rgb, known), rgb, known); };
  assert.equal(hit(0), null, 'oldest entries leave first');
  assert.equal(hit(2)[0], 2);
  memo.set(memo.key(16, tileOf(5).rgb, tileOf(5).known), new Uint8Array(3 * 256).fill(5));
  assert.equal(hit(3), null, 'a hit refreshes an entry; the least recent one is evicted');
  assert.equal(hit(2)[0], 2);
  assert.equal(memo.trim(bytes).entries, 1);
  assert.equal(memo.trim(0).bytes, 0);
  assert.equal(TILE_MEMO_BYTES, 192 * 1024 * 1024);
}

// Strokes 1..11 on top of dust. The memoised session equals an unmemoised
// runner at every step, 8 and 16 bits; earlier strokes' and all dust tiles are
// reused, so the 11th far-apart dab infers exactly one tile.
{
  const session = await createInpaintSession(new Uint8Array(1), { prefer: 'wasm', warmUp: true },
    { loadRuntime: async () => ort, backends: () => ({ webgpu: false, wasm: true }) });
  assert.equal(session.memoStats().entries, 0, 'warm-up leaves the memo empty');
  assert.equal(session.memoStats().capBytes, MAIN_REALM_TILE_MEMO_BYTES, 'a page-realm session gets the smaller cap');
  const verified = runnerFor(ort, modelSession(), { memo: createTileMemo({ verify: true }) });
  const plain = runnerFor(ort, modelSession());
  const strokes = [];
  let dustImages = null;
  for (let n = 1; n <= 11; n++) {
    strokes.push(dab(slots[3 + n]));
    const selection = buildRepairMask(sanitizeRepairStrokes(strokes), geometry);
    const before = inferences;
    const memoDust = await inpaintWithModel(source, dustMask, session.run);
    const dustInferences = inferences - before;
    const memoResult = await inpaintWithModel(memoDust.imageData, selection.mask, session.run, { maskBounds: selection.bounds });
    const strokeInferences = inferences - before - dustInferences;
    // Same passes without memo, and with the 1703835 setup.
    const plainDust = await headInpaintWithModel(source, dustMask, plain);
    const plainResult = await headInpaintWithModel(plainDust.imageData, selection.mask, plain);
    same(memoDust.imageData, plainDust.imageData, `dust pass, stroke ${n}`);
    same(memoResult.imageData, plainResult.imageData, `stroke pass, stroke ${n}`);
    const verifiedResult = await inpaintWithModel(memoDust.imageData, selection.mask, verified, { maskBounds: selection.bounds });
    same(verifiedResult.imageData, plainResult.imageData, `verified memo, stroke ${n}`);
    assert.equal(memoResult.tiles, n, 'one 512 px tile per default-size dab');
    if (n === 1) {
      assert.equal(dustInferences, dustSlots.length, 'the first commit infers every dust tile');
      dustImages = memoDust;
    } else {
      assert.equal(dustInferences, 0, `stroke ${n}: dust tiles are reused`);
    }
    assert.equal(strokeInferences, 1, `stroke ${n}: only the new dab's tile is inferred`);
  }
  // A fresh detection with the same content: no dust tile is inferred.
  const before = inferences;
  const again = await inpaintWithModel(source, new Uint8Array(dustMask), session.run);
  assert.equal(inferences - before, 0);
  same(again.imageData, dustImages.imageData, 'unchanged dust content');
  // An edit that stays inside one box's occupied 64 px cells re-infers that box only.
  const edited = new Uint8Array(dustMask);
  const { x, y } = dustSlots[1];
  disc(edited, x + 30, y, 3); // cell (14, 4) already holds the speck at (905, 297)
  assert.notDeepEqual(edited, dustMask);
  assert.deepEqual(maskBoundingBoxes(edited, W, H), maskBoundingBoxes(dustMask, W, H), 'the boxes do not move');
  const beforeEdit = inferences;
  const editedResult = await inpaintWithModel(source, edited, session.run);
  assert.equal(inferences - beforeEdit, 1, 'only the edited box infers');
  same(editedResult.imageData, (await headInpaintWithModel(source, edited, plain)).imageData, 'edited dust mask');
  // Blocks the pass wrote: pixels outside them equal the source.
  const written = new Set(editedResult.blocks.keys);
  const { size, columns } = editedResult.blocks;
  for (let i = 0; i < W * H; i += 97) {
    const px = i % W, py = (i - px) / W;
    if (written.has(((py / size) | 0) * columns + ((px / size) | 0))) continue;
    for (let c = 0; c < 4; c++) assert.equal(editedResult.imageData.data[i * 4 + c], source.data[i * 4 + c]);
  }
  assert.ok(session.memoStats().bytes <= session.memoStats().capBytes);
  assert.equal(session.memoStats().collisions, 0);
  // Batch lanes look up without inserting.
  const stats = session.memoStats();
  const lane = buildRepairMask(sanitizeRepairStrokes([dab({ x: slots[1].x + 150, y: slots[1].y }), dab({ x: slots[2].x - 150, y: slots[2].y })]), geometry);
  const laneBefore = inferences;
  await inpaintWithModel(source, lane.mask, session.run, { maskBounds: lane.bounds, memoInsert: false });
  assert.equal(inferences - laneBefore, 2, 'the lane infers its tiles');
  assert.equal(session.memoStats().entries, stats.entries, 'and stores none of them');
  await session.release();
  assert.equal(session.memoStats().entries, 0, 'release empties the memo');
  assert.equal(session.memoStats().bytes, 0);
}

// A WebGPU session that fails its warm-up is rebuilt on WASM with its own,
// empty memo; a model reload creates a new session and so a new memo.
{
  const providers = [];
  const runtime = { Tensor, InferenceSession: { create: async (bytes, { executionProviders }) => {
    providers.push(executionProviders[0]);
    return executionProviders[0] === 'webgpu' ? modelSession({ async run() { throw new Error('unsupported operator'); } }) : modelSession();
  } } };
  const deps = { loadRuntime: async () => runtime, backends: () => ({ webgpu: true, wasm: true }) };
  const session = await createInpaintSession(new Uint8Array(1), { prefer: 'webgpu', memoBytes: 4 << 20 }, deps);
  assert.deepEqual(providers, ['webgpu', 'wasm']);
  assert.equal(session.provider, 'wasm');
  const fresh = session.memoStats();
  assert.deepEqual([fresh.entries, fresh.bytes, fresh.inserts, fresh.capBytes], [0, 0, 0, 4 << 20], 'the WASM rebuild starts empty');
  const selection = buildRepairMask(sanitizeRepairStrokes([dab(slots[5])]), geometry);
  await inpaintWithModel(source, selection.mask, session.run, { maskBounds: selection.bounds });
  assert.equal(session.memoStats().entries, 1);
  const reloaded = await createInpaintSession(new Uint8Array(1), { prefer: 'wasm' }, deps);
  assert.equal(reloaded.memoStats().entries, 0, 'a reloaded model starts with an empty memo');
  await session.release(); await reloaded.release();
}

// Worker processor: initialize replaces the session and its memo, `run`
// forwards the lookup-only flag, `trim` shrinks and reports.
{
  const sessions = [];
  const process = createInpaintWorkerProcessor({ createSession: async (bytes, options) => {
    const created = await createInpaintSession(bytes, { ...options, warmUp: false }, { loadRuntime: async () => ort, backends: () => ({ webgpu: false, wasm: true }) });
    sessions.push(created);
    return created;
  } });
  await process({ type: 'initialize', id: 1, modelBytes: new Uint8Array(1), options: { prefer: 'wasm' } });
  const tile = extractTile(source, dustMask, { x: dustSlots[0].x - 200, y: dustSlots[0].y - 200, size: TILE });
  const message = (id, insert) => ({ type: 'run', id, image: tile.image.slice(), mask: tile.mask.slice(), size: TILE, insert });
  const first = await process(message(2));
  assert.equal(first.transfers[0], first.payload.output.buffer);
  const reused = await process(message(3));
  assert.deepEqual(reused.payload.output, first.payload.output);
  assert.notEqual(reused.payload.output.buffer, first.payload.output.buffer, 'each hit transfers a fresh buffer');
  const report = (await process({ type: 'trim', id: 4, bytes: Infinity })).payload.memo;
  assert.equal(report.entries, 1); assert.equal(report.hits, 1); assert.equal(report.inserts, 1);
  const other = extractTile(source, dustMask, { x: dustSlots[1].x - 200, y: dustSlots[1].y - 200, size: TILE });
  await process({ type: 'run', id: 5, image: other.image, mask: other.mask, size: TILE, insert: false });
  assert.equal((await process({ type: 'trim', id: 6, bytes: Infinity })).payload.memo.entries, 1, 'batch lanes do not insert');
  assert.equal((await process({ type: 'trim', id: 7, bytes: 0 })).payload.memo.entries, 0, 'trim evicts');
  await process(message(8));
  await process({ type: 'initialize', id: 9, modelBytes: new Uint8Array(1), options: { prefer: 'wasm' } });
  assert.equal(sessions[0].memoStats().entries, 0, 'the replaced session released its memo');
  assert.equal((await process({ type: 'trim', id: 10, bytes: Infinity })).payload.memo.entries, 0, 'initialize starts empty');
  await process({ type: 'release', id: 11 });
  assert.equal(sessions[1].memoStats().entries, 0);
  assert.equal((await process({ type: 'trim', id: 12, bytes: Infinity })).payload.memo, null, 'no session, no memo');
}

console.log('AI repair tile memo: memoised passes byte-identical to inference, 1 tile for the 11th far dab, 0 for unchanged dust, cap/trim/release/initialize/fallback/lanes hold');
