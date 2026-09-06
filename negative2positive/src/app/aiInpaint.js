// On-device AI inpainting for dust and scratches: a learned inpainter (the
// LaMa ONNX export, Apache-2.0) run by onnxruntime-web on WebGPU where the
// browser has it and on WASM otherwise, over 512-px tiles restricted to the
// mask's bounding boxes with context padding, blended back with a feathered
// edge. Nothing leaves the device; the model is fetched once and cached in
// IndexedDB, or loaded from a file the user picks. Without a model or a
// runtime the caller keeps TELEA (DustRemoval.js). The tiling and blending
// maths is pure and tested; the runtime glue lives at the bottom.

// The onnxruntime-web wasm binary ships with the app (Vite emits it as an
// asset next to the lazy chunk), so the runtime works offline in the desktop
// build and needs no CDN entry in the CSP.
// Self-hosted model asset (the domain the desktop CSP already allows).
export const DEFAULT_MODEL_URL = 'https://download.neoanaloglab.com/models/lama_fp32.onnx';
export const MODEL_LICENCE = 'LaMa (Samsung AI / advimman) Apache-2.0, ONNX export by Carve';
export const TILE = 512;
export const CONTEXT = 64;
export const OVERLAP = 32;
export const FEATHER = 4;

const MODEL_DB = 'nc_ai_models';
const MODEL_STORE = 'models';

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
 * so only the tiles that hold dust are inferred.
 */
export function maskBoundingBoxes(mask, width, height, { cell = 64, context = CONTEXT } = {}) {
  const cols = Math.ceil(width / cell); const rows = Math.ceil(height / cell);
  const occupied = new Uint8Array(cols * rows);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const cy = (y / cell) | 0;
    for (let x = 0; x < width; x++) if (mask[row + x]) occupied[cy * cols + ((x / cell) | 0)] = 1;
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
      if (applied && applied[pixel] >= w) continue;
      if (applied) applied[pixel] = w;
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
 * output. Returns a new ImageData (16-bit plane copied when present).
 */
export async function inpaintWithModel(imageData, mask, run, { tile = TILE, onProgress = null, feather = FEATHER } = {}) {
  const { width, height } = imageData;
  const result = new ImageData(new Uint8ClampedArray(imageData.data), width, height);
  if (imageData.__image16 && imageData.__image16.data instanceof Uint16Array) {
    result.__image16 = { width, height, data: new Uint16Array(imageData.__image16.data) };
  }
  const boxes = maskBoundingBoxes(mask, width, height);
  const tiles = uniqueTiles(boxes.flatMap((box) => tilesForBox(box, width, height, { tile })));
  const applied = new Float32Array(width * height);
  let done = 0;
  for (const t of tiles) {
    const inputs = extractTile(imageData, mask, t);
    let anyMask = false;
    for (let i = 0; i < inputs.mask.length; i++) if (inputs.mask[i]) { anyMask = true; break; }
    if (anyMask) {
      const output = await run(inputs.image, inputs.mask, t.size);
      blendTile(result, imageData, t, output, featherWeights(inputs.mask, t.size, feather), applied);
    }
    done++;
    if (onProgress) onProgress(done, tiles.length);
  }
  return { imageData: result, tiles: tiles.length };
}

// ---- runtime glue (browser only) ----

export function inpaintBackends() {
  return {
    webgpu: typeof navigator !== 'undefined' && Boolean(navigator.gpu),
    wasm: typeof WebAssembly === 'object'
  };
}

let ortPromise = null;
export function loadOrt() {
  if (!ortPromise) {
    ortPromise = import('onnxruntime-web/webgpu').catch((error) => { ortPromise = null; throw error; });
  }
  return ortPromise;
}

function openModelDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    const request = indexedDB.open(MODEL_DB, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(MODEL_STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readCachedModel(key) {
  const db = await openModelDb();
  if (!db) return null;
  try {
    const record = await requestToPromise(db.transaction(MODEL_STORE, 'readonly').objectStore(MODEL_STORE).get(key));
    return record && record.bytes instanceof ArrayBuffer ? record.bytes : null;
  } finally { db.close(); }
}

export async function writeCachedModel(key, bytes) {
  const db = await openModelDb();
  if (!db) return false;
  try {
    await requestToPromise(db.transaction(MODEL_STORE, 'readwrite').objectStore(MODEL_STORE).put({ bytes, savedAt: Date.now() }, key));
    return true;
  } catch (error) {
    console.warn('AI model cache write failed:', error);
    return false;
  } finally { db.close(); }
}

/** Downloads the model once (IndexedDB afterwards), reporting bytes received. */
export async function fetchModelBytes(url, { onProgress = null } = {}) {
  const cached = await readCachedModel(url).catch(() => null);
  if (cached) return cached;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`model download failed (${response.status})`);
  const total = Number(response.headers.get('content-length')) || 0;
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = await response.arrayBuffer();
    await writeCachedModel(url, bytes);
    return bytes;
  }
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) onProgress(received, total);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  await writeCachedModel(url, bytes.buffer);
  return bytes.buffer;
}

function runnerFor(ort, session) {
  const [imageName, maskName] = session.inputNames;
  return async (image, mask, size) => {
    const feeds = {
      [imageName]: new ort.Tensor('float32', image, [1, 3, size, size]),
      [maskName]: new ort.Tensor('float32', mask, [1, 1, size, size])
    };
    const results = await session.run(feeds);
    return results[session.outputNames[0]].data;
  };
}

/**
 * Creates the inference session, WebGPU first, WASM otherwise. A WebGPU
 * session is warmed up on one blank tile before it is trusted: a model whose
 * operators the WebGPU provider cannot run (LaMa's Fourier layers today)
 * creates fine and fails on the first inference, so the failure has to be
 * caught here and the session rebuilt on WASM. Returns { session, provider,
 * run } where `run` matches inpaintWithModel's callback.
 */
export async function createInpaintSession(modelBytes, { prefer = 'webgpu', warmUp = true } = {}) {
  const ort = await loadOrt();
  const backends = inpaintBackends();
  const attempts = prefer === 'webgpu' && backends.webgpu ? [['webgpu', 'wasm'], ['wasm']] : [['wasm']];
  let lastError = null;
  for (const executionProviders of attempts) {
    let session = null;
    try {
      session = await ort.InferenceSession.create(modelBytes, { executionProviders, graphOptimizationLevel: 'all' });
      const run = runnerFor(ort, session);
      if (warmUp && executionProviders[0] === 'webgpu') {
        await run(new Float32Array(3 * TILE * TILE), new Float32Array(TILE * TILE), TILE);
      }
      return { session, provider: executionProviders[0], run, inputNames: session.inputNames, outputNames: session.outputNames };
    } catch (error) {
      lastError = error;
      if (session) { try { await session.release?.(); } catch {} }
    }
  }
  throw lastError || new Error('no execution provider');
}
