import { yieldTaskForJob } from './yieldToPaint.js';
import { loadInferenceRuntime } from './inferenceRuntime.js';
import { defaultInferencePreference } from './inferenceBackend.js';
import { murmurHash3x86_128 } from './contentHash.js';
import { fetchModelBytes as fetchCachedModelBytes } from './modelCache.js';
export { readCachedModel, writeCachedModel } from './modelCache.js';
// On-device AI inpainting for dust and scratches: a learned inpainter (the
// MI-GAN Places2 pipeline, MIT) run by onnxruntime-web on WebGPU where the
// browser has it and on WASM otherwise, over 512-px tiles restricted to the
// mask's bounding boxes with context padding, blended back with a feathered
// edge. Nothing leaves the device; the model is fetched once and cached in
// IndexedDB, or loaded from a file the user picks. Without a model or a
// runtime the caller keeps TELEA (DustRemoval.js). The tiling and blending
// maths is pure and tested; the runtime glue lives at the bottom.

// The onnxruntime-web wasm binary ships with the app (Vite emits it as an
// asset next to the lazy chunk), so the runtime works offline in the desktop
// build and needs no CDN entry in the CSP.
// Bundled with web and desktop builds; no third-party request is required.
// A literal new URL() so Vite fingerprints it into immutable /assets: a
// replaced model gets a new URL, and with it a new IndexedDB key.
export const DEFAULT_MODEL_URL = new URL('../assets/models/migan_pipeline_v2.onnx', import.meta.url).href;
const DEFAULT_MODEL_FAMILY = 'migan_pipeline_v2';
export const MODEL_LICENCE = 'MI-GAN (Picsart AI Research), MIT; see models/MI-GAN-LICENSE.txt';
export const TILE = 512;
export const CONTEXT = 64;
export const OVERLAP = 32;
export const FEATHER = 4;
// Inference results kept per session: about 244 tiles of 512 px in the AI
// worker, fewer when the session runs in the page itself.
export const TILE_MEMO_BYTES = 192 * 1024 * 1024;
export const MAIN_REALM_TILE_MEMO_BYTES = 48 * 1024 * 1024;
// Frame copies are split so that no task holds the page for long.
export const CLONE_CHUNK_BYTES = 8 * 1024 * 1024;

// ---- tiling maths ----

/** Bounding box of the mask, or null when it is empty. */
export function maskBounds(mask, width, height) {
  let minX = width; let minY = height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (!mask[row + x]) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Boxes around the masked areas: the mask is looked at through a coarse grid,
 * touching occupied cells are merged, and each box grows by `context` pixels so
 * the model sees what surrounds a speck. Far-apart specks get their own boxes,
 * so only the tiles that hold dust are inferred. `bounds` ({ x, y, width,
 * height }), when the caller knows it, is a rectangle outside which the mask is
 * empty: only its rows and columns are scanned, and the boxes are the same.
 */
export function maskBoundingBoxes(mask, width, height, { cell = 64, context = CONTEXT, bounds = null } = {}) {
  const cols = Math.ceil(width / cell); const rows = Math.ceil(height / cell);
  const occupied = new Uint8Array(cols * rows);
  const left = bounds ? Math.max(0, bounds.x) : 0;
  const right = bounds ? Math.min(width, bounds.x + bounds.width) : width;
  const top = bounds ? Math.max(0, bounds.y) : 0;
  const bottom = bounds ? Math.min(height, bounds.y + bounds.height) : height;
  for (let y = top; y < bottom; y++) {
    const row = y * width;
    const cy = (y / cell) | 0;
    for (let x = left; x < right; x++) if (mask[row + x]) occupied[cy * cols + ((x / cell) | 0)] = 1;
  }
  const seen = new Uint8Array(cols * rows);
  const boxes = [];
  for (let start = 0; start < occupied.length; start++) {
    if (!occupied[start] || seen[start]) continue;
    // Flood fill over 8-connected occupied cells.
    const stack = [start];
    seen[start] = 1;
    let minC = cols; let maxC = -1; let minR = rows; let maxR = -1;
    while (stack.length) {
      const idx = stack.pop();
      const c = idx % cols; const r = (idx - c) / cols;
      if (c < minC) minC = c; if (c > maxC) maxC = c; if (r < minR) minR = r; if (r > maxR) maxR = r;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const nc = c + dc; const nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const n = nr * cols + nc;
        if (occupied[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
    }
    const x0 = Math.max(0, minC * cell - context); const y0 = Math.max(0, minR * cell - context);
    const x1 = Math.min(width, (maxC + 1) * cell + context); const y1 = Math.min(height, (maxR + 1) * cell + context);
    boxes.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  }
  return boxes;
}

/**
 * 512-px windows covering a box, overlapping by `overlap`, kept inside the
 * image where it is large enough; a smaller image yields one window at the
 * origin that extractTile pads.
 */
export function tilesForBox(box, width, height, { tile = TILE, overlap = OVERLAP } = {}) {
  const step = Math.max(1, tile - 2 * overlap);
  const positions = (start, length, limit) => {
    if (limit <= tile) return [0];
    const out = [];
    let p = Math.max(0, start - overlap);
    const end = Math.min(limit, start + length + overlap);
    while (true) {
      const clamped = Math.min(p, limit - tile);
      out.push(clamped);
      if (clamped + tile >= end) break;
      p += step;
    }
    return out;
  };
  const tiles = [];
  for (const y of positions(box.y, box.height, height)) {
    for (const x of positions(box.x, box.width, width)) tiles.push({ x, y, size: tile });
  }
  return tiles;
}

/** Deduplicates tiles that several boxes produced. */
export function uniqueTiles(tiles) {
  const seen = new Set();
  return tiles.filter((t) => { const key = `${t.x},${t.y}`; if (seen.has(key)) return false; seen.add(key); return true; });
}

/**
 * The model inputs for one tile: NCHW float32 RGB in 0..1 and a 0/1 mask,
 * edge-replicated where the tile reaches past the image.
 */
export function extractTile(imageData, mask, tile) {
  const { width, height, data } = imageData;
  const size = tile.size;
  const image = new Float32Array(3 * size * size);
  const maskOut = new Float32Array(size * size);
  const plane = size * size;
  for (let ty = 0; ty < size; ty++) {
    const sy = Math.min(height - 1, Math.max(0, tile.y + ty));
    for (let tx = 0; tx < size; tx++) {
      const sx = Math.min(width - 1, Math.max(0, tile.x + tx));
      const src = (sy * width + sx) * 4;
      const dst = ty * size + tx;
      image[dst] = data[src] / 255;
      image[plane + dst] = data[src + 1] / 255;
      image[2 * plane + dst] = data[src + 2] / 255;
      const inside = tile.x + tx >= 0 && tile.x + tx < width && tile.y + ty >= 0 && tile.y + ty < height;
      maskOut[dst] = inside && mask[sy * width + sx] ? 1 : 0;
    }
  }
  return { image, mask: maskOut };
}

/**
 * Blend weights for a tile: 1 inside the mask, fading to 0 over `feather`
 * pixels outside it, so the model's fill meets the original without a seam.
 */
export function featherWeights(maskTile, size, feather = FEATHER) {
  const weights = new Float32Array(size * size);
  for (let i = 0; i < weights.length; i++) weights[i] = maskTile[i] ? 1 : 0;
  // Successive dilations, each ring one step lower.
  let frontier = weights.slice();
  for (let ring = 1; ring <= feather; ring++) {
    const next = frontier.slice();
    const value = 1 - ring / (feather + 1);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (frontier[i] > 0) continue;
        const touch = (x > 0 && frontier[i - 1] > 0) || (x < size - 1 && frontier[i + 1] > 0) || (y > 0 && frontier[i - size] > 0) || (y < size - 1 && frontier[i + size] > 0);
        if (touch) { next[i] = 1; weights[i] = Math.max(weights[i], value); }
      }
    }
    frontier = next;
  }
  return weights;
}

// Allocate overlap history only in blocks reached by a repaired pixel. A single
// speck on a 60 MP scan must not reserve a 240 MB full-frame float plane.
export function createSparseBlendWeights(width, { blockSize = 64 } = {}) {
  const columns = Math.ceil(width / blockSize);
  const blocks = new Map();
  return {
    accept(pixel, value) {
      const y = Math.floor(pixel / width), x = pixel - y * width;
      const key = Math.floor(y / blockSize) * columns + Math.floor(x / blockSize);
      const offset = (y % blockSize) * blockSize + x % blockSize;
      let block = blocks.get(key);
      if (!block) { block = new Float32Array(blockSize * blockSize); blocks.set(key, block); }
      if (block[offset] >= value) return false;
      block[offset] = value;
      return true;
    },
    blockSize, columns,
    // Keys (row * columns + column) of the blocks holding a written pixel.
    keys() { return [...blocks.keys()]; },
    get allocatedBytes() { return blocks.size * blockSize * blockSize * Float32Array.BYTES_PER_ELEMENT; }
  };
}

const yieldToEventLoop = () => (typeof globalThis.scheduler?.yield === 'function'
  ? globalThis.scheduler.yield() : yieldTaskForJob());

async function copyInChunks(target, source, chunkBytes, check) {
  const step = Math.max(1, Math.floor(chunkBytes / source.BYTES_PER_ELEMENT));
  for (let offset = 0; offset < source.length; offset += step) {
    if (offset) { await yieldToEventLoop(); check?.(); }
    target.set(source.subarray(offset, Math.min(source.length, offset + step)), offset);
  }
}

/**
 * Copies an ImageData (and its 16-bit plane, when present) in chunks with a
 * yield between them: the bytes of a one-shot copy, without one long task on
 * a 60 MP frame. `check` runs after each yield and may throw to abandon it.
 */
export async function cloneImageDataChunked(imageData, { chunkBytes = CLONE_CHUNK_BYTES, check = null } = {}) {
  const { width, height } = imageData;
  const data = new Uint8ClampedArray(imageData.data.length);
  await copyInChunks(data, imageData.data, chunkBytes, check);
  const result = new ImageData(data, width, height);
  if (imageData.__image16 && imageData.__image16.data instanceof Uint16Array) {
    const plane = new Uint16Array(imageData.__image16.data.length);
    await copyInChunks(plane, imageData.__image16.data, chunkBytes, check);
    result.__image16 = { width, height, data: plane };
  }
  return result;
}

function checkInpaintCurrent(signal, shouldContinue) {
  if (signal?.aborted || (shouldContinue && !shouldContinue())) {
    throw new DOMException('AI repair was superseded', 'AbortError');
  }
}

/**
 * Writes the model output for a tile into `result` (8-bit data plus the
 * 16-bit plane when present), only where the weights are non-zero, blending
 * against the untouched `source`. `applied` remembers the weight each pixel
 * already received so overlapping tiles never blend a pixel twice.
 * `output` is NCHW float32, on the 0..1 or 0..255 scale (detected).
 */
export function blendTile(result, source, tile, output, weights, applied = null) {
  const { width, height } = result;
  const size = tile.size;
  const plane = size * size;
  let peak = 0;
  for (let i = 0; i < output.length; i += 97) if (output[i] > peak) peak = output[i];
  const scale = peak > 1.5 ? 1 / 255 : 1;
  const plane16 = result.__image16 && result.__image16.data instanceof Uint16Array ? result.__image16.data : null;
  const source16 = source.__image16 && source.__image16.data instanceof Uint16Array ? source.__image16.data : null;
  let touched = 0;
  for (let ty = 0; ty < size; ty++) {
    const y = tile.y + ty;
    if (y < 0 || y >= height) continue;
    for (let tx = 0; tx < size; tx++) {
      const x = tile.x + tx;
      if (x < 0 || x >= width) continue;
      const w = weights[ty * size + tx];
      if (w <= 0) continue;
      const pixel = y * width + x;
      if (applied) {
        if (applied.accept) {
          if (!applied.accept(pixel, w)) continue;
        } else {
          if (applied[pixel] >= w) continue;
          applied[pixel] = w;
        }
      }
      const src = ty * size + tx;
      const dst = pixel * 4;
      for (let c = 0; c < 3; c++) {
        const model = Math.min(1, Math.max(0, output[c * plane + src] * scale));
        const original = source16 ? source16[dst + c] / 65535 : source.data[dst + c] / 255;
        const value = original + (model - original) * w;
        result.data[dst + c] = Math.round(value * 255);
        if (plane16) plane16[dst + c] = Math.round(value * 65535);
      }
      touched++;
    }
  }
  return touched;
}

/**
 * Runs the model over every tile the mask needs. `run(image, mask, size)` is
 * the inference call: it receives the NCHW inputs and resolves to the NCHW
 * output. Returns a new ImageData (16-bit plane copied when present), the
 * tile count and the 64 px blocks the blend wrote (`blocks.keys`, in rows of
 * `blocks.columns`); pixels outside them equal the input.
 * `maskBounds` is maskBoundingBoxes' scan hint. `memoInsert: false` asks a
 * memoising session to look tiles up without storing new ones (batch lanes).
 * Boxes and the first tile come before the copy of the frame: that tile infers
 * while the copy proceeds in chunks.
 */
export async function inpaintWithModel(imageData, mask, run, {
  tile = TILE, onProgress = null, feather = FEATHER, signal = null, shouldContinue = null,
  maskBounds = null, memoInsert = true, cloneChunkBytes = CLONE_CHUNK_BYTES
} = {}) {
  checkInpaintCurrent(signal, shouldContinue);
  const { width, height } = imageData;
  const boxes = maskBoundingBoxes(mask, width, height, { bounds: maskBounds });
  const tiles = uniqueTiles(boxes.flatMap((box) => tilesForBox(box, width, height, { tile })));
  const runOptions = { transferInputs: true, signal, shouldContinue };
  if (!memoInsert) runOptions.insert = false;
  // Tile-local inputs are no longer needed once the weights exist. Worker
  // sessions can transfer them instead of copying 4 MB on every tile.
  const start = (t) => {
    const inputs = extractTile(imageData, mask, t);
    let anyMask = false;
    for (let i = 0; i < inputs.mask.length; i++) if (inputs.mask[i]) { anyMask = true; break; }
    if (!anyMask) return null;
    const weights = featherWeights(inputs.mask, t.size, feather);
    return { weights, output: run(inputs.image, inputs.mask, t.size, runOptions) };
  };
  let next = 0, early = null;
  while (next < tiles.length && !early) {
    checkInpaintCurrent(signal, shouldContinue);
    early = start(tiles[next]);
    if (!early) next++;
  }
  // A superseded pass may abandon the copy while this inference is queued.
  early?.output.catch(() => {});
  const result = await cloneImageDataChunked(imageData, { chunkBytes: cloneChunkBytes,
    check: () => checkInpaintCurrent(signal, shouldContinue) });
  const applied = createSparseBlendWeights(width);
  let done = 0;
  for (let index = 0; index < tiles.length; index++) {
    const t = tiles[index];
    // Tiles before `next` hold no mask; without an early tile none does.
    let task = null;
    if (index === next) task = early;
    else if (index > next) {
      checkInpaintCurrent(signal, shouldContinue);
      task = start(t);
    }
    if (task) {
      const output = await task.output;
      checkInpaintCurrent(signal, shouldContinue);
      blendTile(result, imageData, t, output, task.weights, applied);
    }
    done++;
    if (onProgress) onProgress(done, tiles.length);
  }
  return { imageData: result, tiles: tiles.length,
    blocks: { size: applied.blockSize, columns: applied.columns, keys: applied.keys() } };
}

// ---- runtime glue (browser only) ----

export function inpaintBackends() {
  return {
    webgpu: typeof navigator !== 'undefined' && Boolean(navigator.gpu),
    wasm: typeof WebAssembly === 'object'
  };
}

export const loadOrt = loadInferenceRuntime;

/**
 * Downloads the model once (IndexedDB afterwards; see modelCache.js). Writing
 * the bundled model deletes its older keys, including the unversioned
 * models/migan_pipeline_v2.onnx key of builds before the URL was hashed.
 */
export function fetchModelBytes(url, { onProgress = null } = {}) {
  return fetchCachedModelBytes(url, { onProgress, family: url === DEFAULT_MODEL_URL ? DEFAULT_MODEL_FAMILY : null });
}

/**
 * Model outputs by the exact bytes of their inputs, in a byte-bounded LRU.
 * MI-GAN's output for a tile depends only on that tile's uint8 image and mask,
 * and a WASM session returns the same bytes for the same inputs, so a stroke
 * that leaves a tile's inputs unchanged reuses its earlier result. The key is
 * the tile size plus a 128-bit hash of each feed. `verify` also keeps the feeds
 * and compares them on a hit (tests).
 */
export function createTileMemo({ capBytes = TILE_MEMO_BYTES, verify = false } = {}) {
  const entries = new Map();
  let bytes = 0, hits = 0, misses = 0, inserts = 0, collisions = 0;
  const same = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
  const evictTo = (target) => {
    for (const [key, entry] of entries) {
      if (bytes <= target) break;
      entries.delete(key);
      bytes -= entry.bytes;
    }
  };
  return {
    key: (size, rgb, known) => `${size}:${murmurHash3x86_128(rgb, size)}:${murmurHash3x86_128(known, size)}`,
    get(key, rgb, known) {
      const entry = entries.get(key);
      if (!entry || (verify && !(same(entry.rgb, rgb) && same(entry.known, known)))) {
        if (entry) collisions++;
        misses++;
        return null;
      }
      entries.delete(key);
      entries.set(key, entry);
      hits++;
      return entry.output;
    },
    set(key, output, rgb, known) {
      const entry = { output: new Uint8Array(output) };
      if (verify) { entry.rgb = rgb.slice(); entry.known = known.slice(); }
      entry.bytes = entry.output.byteLength + (verify ? rgb.byteLength + known.byteLength : 0);
      if (entry.bytes > capBytes) return;
      const previous = entries.get(key);
      if (previous) { entries.delete(key); bytes -= previous.bytes; }
      entries.set(key, entry);
      bytes += entry.bytes;
      inserts++;
      evictTo(capBytes);
    },
    trim(target) { evictTo(Math.max(0, Number(target) || 0)); return this.stats(); },
    clear() { entries.clear(); bytes = 0; },
    stats: () => ({ entries: entries.size, bytes, capBytes, hits, misses, inserts, collisions })
  };
}

// Official MI-GAN pipeline: uint8 NCHW RGB, 255 = known / 0 = repair.
// Keep the tiling API in 0..1 with 1 = repair, converting only at this boundary.
// With a `memo`, a tile whose feeds were seen before returns the stored output;
// `insert: false` (batch lanes) looks up without storing.
export function runnerFor(ort, session, { memo = null } = {}) {
  if (!session.inputNames.includes('image') || !session.inputNames.includes('mask') ||
      !session.outputNames.includes('result')) {
    throw new Error('Expected the MI-GAN pipeline ONNX model (image, mask → result)');
  }
  // Explicit normalization also handles nearly black results without guessing scale.
  const normalized = (bytes) => {
    const out = new Float32Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] / 255;
    return out;
  };
  return async (image, mask, size, { insert = true } = {}) => {
    const pixels = size * size;
    if (image.length !== pixels * 3 || mask.length !== pixels) throw new RangeError('Invalid MI-GAN tile');
    // Empty masks need no inference (also avoids empty-bounds model operators).
    let anyMask = false;
    for (let i = 0; i < mask.length; i++) if (mask[i] > 0) { anyMask = true; break; }
    if (!anyMask) return image.slice();
    // Plain loops store what Uint8Array.from(..., fn) stored, without a call per value.
    const rgb = new Uint8Array(image.length);
    for (let i = 0; i < image.length; i++) rgb[i] = Math.round(Math.min(1, Math.max(0, image[i])) * 255);
    const known = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) known[i] = mask[i] > 0 ? 0 : 255;
    const key = memo ? memo.key(size, rgb, known) : null;
    const cached = memo ? memo.get(key, rgb, known) : null;
    if (cached) return normalized(cached);
    const feeds = {
      image: new ort.Tensor('uint8', rgb, [1, 3, size, size]),
      mask: new ort.Tensor('uint8', known, [1, 1, size, size])
    };
    let results;
    try {
      results = await session.run(feeds);
      const output = results.result;
      if (output.type !== 'uint8' || output.dims.length !== 4 ||
          output.dims.some((value, index) => value !== [1, 3, size, size][index]) ||
          output.data.length !== pixels * 3) throw new Error('Invalid MI-GAN output');
      // Stored before the tensors are disposed; the worker transfers the result.
      if (memo && insert) memo.set(key, output.data, rgb, known);
      return normalized(output.data);
    } finally {
      for (const tensor of new Set([...Object.values(feeds), ...Object.values(results || {})])) tensor.dispose?.();
    }
  };
}

const inWorkerRealm = () => typeof globalThis.WorkerGlobalScope === 'function'
  && globalThis instanceof globalThis.WorkerGlobalScope;

/**
 * Creates the inference session, WebGPU first, WASM otherwise. A WebGPU
 * session is warmed up on one blank tile before it is trusted: a model whose
 * operators the WebGPU provider cannot run (LaMa's Fourier layers today)
 * creates fine and fails on the first inference, so the failure has to be
 * caught here and the session rebuilt on WASM. Returns { session, provider,
 * run, release, trim, memoStats } where `run` matches inpaintWithModel's
 * callback. Each session owns its tile memo: a new session, a provider
 * fallback or a release starts empty, and `trim(bytes)` shrinks it on demand.
 */
export async function createInpaintSession(modelBytes, {
  prefer = defaultInferencePreference(), warmUp = true, memoBytes = null
} = {}, { loadRuntime = loadOrt, backends = inpaintBackends } = {}) {
  const ort = await loadRuntime();
  const available = backends();
  const attempts = defaultInferencePreference() !== 'wasm' && prefer === 'webgpu' && available.webgpu ? [['webgpu', 'wasm'], ['wasm']] : [['wasm']];
  const capBytes = Number.isFinite(memoBytes) && memoBytes >= 0 ? memoBytes
    : inWorkerRealm() ? TILE_MEMO_BYTES : MAIN_REALM_TILE_MEMO_BYTES;
  let lastError = null;
  for (const executionProviders of attempts) {
    let session = null;
    try {
      session = await ort.InferenceSession.create(modelBytes, { executionProviders, graphOptimizationLevel: 'all' });
      const memo = createTileMemo({ capBytes });
      const infer = runnerFor(ort, session, { memo });
      let pending = Promise.resolve();
      const run = (...args) => {
        const task = pending.then(() => infer(...args));
        pending = task.catch(() => {});
        return task;
      };
      const release = async () => { await pending; memo.clear(); await session.release(); };
      if (warmUp) {
        const mask = new Float32Array(TILE * TILE);
        mask[(TILE / 2) * TILE + TILE / 2] = 1;
        await run(new Float32Array(3 * TILE * TILE).fill(0.5), mask, TILE, { insert: false });
      }
      // ORT's WASM threads in this realm (#264): more than one only when the
      // realm is cross-origin isolated.
      const threads = Number(ort.env?.wasm?.numThreads) || 1;
      return { session, release, provider: executionProviders[0], threads, run, inputNames: session.inputNames, outputNames: session.outputNames,
        trim: (bytes) => memo.trim(bytes), memoStats: () => memo.stats() };
    } catch (error) {
      lastError = error;
      if (session) { try { await session.release?.(); } catch {} }
    }
  }
  throw lastError || new Error('no execution provider');
}
