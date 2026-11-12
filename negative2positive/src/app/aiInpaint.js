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
  return maskClusters(mask, width, height, { cell, context, bounds }).clusters.map((cluster) => cluster.box);
}

/**
 * The masked areas as clusters of touching occupied grid cells (the grouping
 * behind maskBoundingBoxes): `clusters[i]` holds its cells' range (minC..maxC,
 * minR..maxR) and its box; `clusterOf[row * cols + col]` is the cluster of a
 * grid cell, or -1. Two clusters are at least one empty cell apart.
 */
export function maskClusters(mask, width, height, { cell = 64, context = CONTEXT, bounds = null } = {}) {
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
  const clusterOf = new Int32Array(cols * rows).fill(-1);
  const clusters = [];
  for (let start = 0; start < occupied.length; start++) {
    if (!occupied[start] || clusterOf[start] >= 0) continue;
    // Flood fill over 8-connected occupied cells.
    const id = clusters.length;
    const stack = [start];
    clusterOf[start] = id;
    let minC = cols; let maxC = -1; let minR = rows; let maxR = -1;
    while (stack.length) {
      const idx = stack.pop();
      const c = idx % cols; const r = (idx - c) / cols;
      if (c < minC) minC = c; if (c > maxC) maxC = c; if (r < minR) minR = r; if (r > maxR) maxR = r;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const nc = c + dc; const nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const n = nr * cols + nc;
        if (occupied[n] && clusterOf[n] < 0) { clusterOf[n] = id; stack.push(n); }
      }
    }
    const x0 = Math.max(0, minC * cell - context); const y0 = Math.max(0, minR * cell - context);
    const x1 = Math.min(width, (maxC + 1) * cell + context); const y1 = Math.min(height, (maxR + 1) * cell + context);
    clusters.push({ minC, maxC, minR, maxR, box: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });
  }
  return { cell, cols, rows, clusterOf, clusters };
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

// ---- mosaics ----
//
// The MI-GAN pipeline costs the same for every call (its generator always
// runs at 512 px: about 0.07 s on WebGPU, 0.75 s on one WASM thread), and a
// speck a dozen pixels across needs only the few dozen pixels around it. So
// small clusters do not get a tile each: a window is cut around every one and
// the windows are laid side by side in one 512 px input, sixteen of 128 px or
// four of 256 px (or a mix: a quadrant holds one 256 px window or four 128 px
// ones). A cluster too large for a 256 px window that is thin all along (a
// hair, a scratch) goes in piece by piece: each grid cell's part of it in a
// 128 px window of its own, the rest of the line masked beside it. Only what
// is large and thick (a brushed area) keeps the tiles.
// docs/technical-depth.md has the measurements against known pixels.

/** Pixels of real picture a cluster keeps on every side inside its window, for a 512 px input. */
export const MOSAIC_CONTEXT = 32;
/** A long cluster goes in by pieces while the mask fills at most this share of every piece's window. */
export const MOSAIC_PIECE_SHARE = 0.12;

// A long cluster cell by cell: the centre of each cell's own mask pixels, or
// null when a 128 px window around one holds more mask than a thin line leaves.
function clusterPieces(mask, width, height, grid, id, size, share) {
  const { cell, cols, clusterOf, clusters } = grid;
  const { minC, maxC, minR, maxR } = clusters[id];
  const limit = share * size * size;
  const pieces = [];
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      if (clusterOf[r * cols + c] !== id) continue;
      let x0 = width, y0 = height, x1 = 0, y1 = 0;
      const cellX1 = Math.min(width, (c + 1) * cell), cellY1 = Math.min(height, (r + 1) * cell);
      for (let y = r * cell; y < cellY1; y++) {
        const row = y * width;
        for (let x = c * cell; x < cellX1; x++) {
          if (!mask[row + x]) continue;
          if (x < x0) x0 = x; if (x >= x1) x1 = x + 1;
          if (y < y0) y0 = y; if (y >= y1) y1 = y + 1;
        }
      }
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const left = Math.min(width - size, Math.max(0, Math.round(cx - size / 2)));
      const top = Math.min(height - size, Math.max(0, Math.round(cy - size / 2)));
      let masked = 0;
      for (let y = top; y < top + size; y++) {
        const row = y * width;
        for (let x = left; x < left + size; x++) if (mask[row + x]) masked++;
      }
      if (masked > limit) return null;
      pieces.push({ cluster: id, cell: r * cols + c, cx, cy });
    }
  }
  return pieces;
}

// The mask pixels of a cluster: their bounds, x1 and y1 exclusive.
function clusterPixelBounds(mask, width, height, grid, id) {
  const { cell, cols, clusterOf, clusters } = grid;
  const { minC, maxC, minR, maxR } = clusters[id];
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      if (clusterOf[r * cols + c] !== id) continue;
      const cellX1 = Math.min(width, (c + 1) * cell), cellY1 = Math.min(height, (r + 1) * cell);
      for (let y = r * cell; y < cellY1; y++) {
        const row = y * width;
        for (let x = c * cell; x < cellX1; x++) {
          if (!mask[row + x]) continue;
          if (x < x0) x0 = x; if (x >= x1) x1 = x + 1;
          if (y < y0) y0 = y; if (y >= y1) y1 = y + 1;
        }
      }
    }
  }
  return { x0, y0, x1, y1 };
}

/**
 * The inferences a pass over the mask needs. Returns the cluster grid, the
 * mosaics (`canvases`: each a list of windows { x, y, size, at: { x, y },
 * cluster, cell, blend } laid out in one tile-sized input; a window writes
 * back its cluster's pixels, or those in grid cell `cell` alone when it is a
 * piece of a long cluster (-1 otherwise); windows with `blend: false` only
 * fill room that would otherwise be empty), the tiles of the clusters left
 * to tiles, and `tiled[cluster]`, 1 for those.
 * The layout depends on the mask alone, so the same mask is always repaired
 * by the same inputs. A frame smaller than a tile, or `mosaic: false`, keeps
 * every cluster on tiles.
 */
export function planInpaint(mask, width, height, {
  tile = TILE, overlap = OVERLAP, bounds = null, mosaic = true, pieceShare = MOSAIC_PIECE_SHARE
} = {}) {
  const grid = maskClusters(mask, width, height, { bounds });
  const { cell, clusters } = grid;
  const tiled = new Uint8Array(clusters.length);
  const small = tile >> 2, medium = tile >> 1, context = Math.round(tile * MOSAIC_CONTEXT / TILE);
  const smalls = [], mediums = [];
  const usable = mosaic && tile % 4 === 0 && width >= tile && height >= tile;
  for (let id = 0; id < clusters.length; id++) {
    const { minC, maxC, minR, maxR } = clusters[id];
    if (!usable) { tiled[id] = 1; continue; }
    // A cluster spanning n cells is more than (n - 2) cells long.
    const span = Math.max(maxC - minC, maxR - minR) + 1;
    if ((span - 2) * cell + 2 * context < medium) {
      const { x0, y0, x1, y1 } = clusterPixelBounds(mask, width, height, grid, id);
      const long = Math.max(x1 - x0, y1 - y0);
      const unit = { cluster: id, cell: -1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
      if (long + 2 * context <= small) { smalls.push(unit); continue; }
      if (long + 2 * context <= medium) { mediums.push(unit); continue; }
    }
    const pieces = pieceShare > 0 ? clusterPieces(mask, width, height, grid, id, small, pieceShare) : null;
    if (pieces) smalls.push(...pieces);
    else tiled[id] = 1;
  }
  // A window of `size` px centred on a unit, kept inside the frame.
  const windowOf = (unit, size, atX, atY, blend = true) => ({
    x: Math.min(width - size, Math.max(0, Math.round(unit.cx - size / 2))),
    y: Math.min(height - size, Math.max(0, Math.round(unit.cy - size / 2))),
    size, at: { x: atX, y: atY }, cluster: unit.cluster, cell: unit.cell, blend
  });
  // Quadrants: one 256 px window, or up to four 128 px ones.
  const quadrants = mediums.map((unit) => [unit]);
  for (let i = 0; i < smalls.length; i += 4) quadrants.push(smalls.slice(i, i + 4));
  const canvases = [];
  for (let i = 0; i < quadrants.length; i += 4) {
    let group = quadrants.slice(i, i + 4);
    const units = group.flat();
    // Room to spare goes to context: one unit takes the whole input, up to
    // four take a quadrant each.
    if (units.length === 1) { canvases.push([windowOf(units[0], tile, 0, 0)]); continue; }
    if (units.length <= 4) group = units.map((unit) => [unit]);
    const windows = [];
    for (let q = 0; q < 4; q++) {
      // An unused quadrant shows a used one again: the model sees picture, not a blank.
      const members = group[q % group.length], blend = q < group.length;
      const qx = (q & 1) * medium, qy = (q >> 1) * medium;
      if (members.length === 1) { windows.push(windowOf(members[0], medium, qx, qy, blend)); continue; }
      for (let k = 0; k < 4; k++) {
        windows.push(windowOf(members[k % members.length], small, qx + (k & 1) * small, qy + (k >> 1) * small, blend && k < members.length));
      }
    }
    canvases.push(windows);
  }
  const boxes = clusters.filter((cluster, id) => tiled[id]).map((cluster) => cluster.box);
  const tiles = uniqueTiles(boxes.flatMap((box) => tilesForBox(box, width, height, { tile, overlap })));
  return { grid, canvases, tiles, tiled };
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
 * `output` is NCHW float32, on the 0..1 or 0..255 scale (detected); `from`
 * ({ size, x, y }) says where the tile sits in it when it is a mosaic's.
 */
export function blendTile(result, source, tile, output, weights, applied = null, from = null) {
  const { width, height } = result;
  const size = tile.size;
  // `from`: the tile is a window of a larger square output (a mosaic), at (x, y) in it.
  const side = from ? from.size : size, fromX = from ? from.x : 0, fromY = from ? from.y : 0;
  const plane = side * side;
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
      const src = (fromY + ty) * side + fromX + tx;
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
 * Runs the model over everything the mask needs: mosaics of the small
 * clusters, tiles for the rest (planInpaint). `run(image, mask, size)` is
 * the inference call: it receives the NCHW inputs and resolves to the NCHW
 * output. Returns a new ImageData (16-bit plane copied when present), the
 * number of inputs (`tiles`) and the 64 px blocks the blend wrote
 * (`blocks.keys`, in rows of `blocks.columns`); pixels outside them equal the
 * input.
 * `maskBounds` is the cluster scan's hint. `memoInsert: false` asks a
 * memoising session to look inputs up without storing new ones (batch lanes).
 * `mosaic: false` keeps every cluster on tiles, `pieceShare: 0` the long ones (measurements).
 * The plan and the first input come before the copy of the frame: that input
 * infers while the copy proceeds in chunks.
 */
export async function inpaintWithModel(imageData, mask, run, {
  tile = TILE, onProgress = null, feather = FEATHER, signal = null, shouldContinue = null,
  maskBounds = null, memoInsert = true, cloneChunkBytes = CLONE_CHUNK_BYTES, mosaic = true, pieceShare = undefined
} = {}) {
  checkInpaintCurrent(signal, shouldContinue);
  const { width, height, data } = imageData;
  const { grid, canvases, tiles, tiled } = planInpaint(mask, width, height, { tile, bounds: maskBounds, mosaic, pieceShare });
  const { cell, cols, clusterOf } = grid;
  const jobs = [...canvases.map((windows) => ({ windows })), ...tiles.map((t) => ({ tile: t }))];
  const runOptions = { transferInputs: true, signal, shouldContinue };
  if (!memoInsert) runOptions.insert = false;
  let result = null, applied = null;
  // Tile-local inputs are no longer needed once the weights exist. Worker
  // sessions can transfer them instead of copying 4 MB on every tile.
  const startTile = (t) => {
    const inputs = extractTile(imageData, mask, t);
    // The model never sees dust as picture, so its mask holds every masked
    // pixel; the tile writes back only the clusters that were left to tiles.
    let own = inputs.mask;
    if (canvases.length) {
      own = new Float32Array(inputs.mask.length);
      for (let ty = 0; ty < t.size; ty++) {
        const gridRow = (((t.y + ty) / cell) | 0) * cols;
        for (let tx = 0; tx < t.size; tx++) {
          const i = ty * t.size + tx;
          if (inputs.mask[i] && tiled[clusterOf[gridRow + (((t.x + tx) / cell) | 0)]]) own[i] = 1;
        }
      }
    }
    let anyMask = false;
    for (let i = 0; i < own.length; i++) if (own[i]) { anyMask = true; break; }
    if (!anyMask) return null;
    const weights = featherWeights(own, t.size, feather);
    return { output: run(inputs.image, inputs.mask, t.size, runOptions),
      blend: (output) => { blendTile(result, imageData, t, output, weights, applied); } };
  };
  // A mosaic: every window's pixels and mask side by side; a window writes
  // back its own cluster only (another cluster's pixels inside it are masked
  // for the model and repaired from their own window).
  const startCanvas = (windows) => {
    const plane = tile * tile;
    const image = new Float32Array(3 * plane), maskOut = new Float32Array(plane);
    const writes = [];
    for (const win of windows) {
      const own = win.blend ? new Float32Array(win.size * win.size) : null;
      for (let wy = 0; wy < win.size; wy++) {
        const sy = win.y + wy, gridRow = ((sy / cell) | 0) * cols;
        let src = (sy * width + win.x) * 4, pixel = sy * width + win.x, dst = (win.at.y + wy) * tile + win.at.x;
        for (let wx = 0; wx < win.size; wx++, src += 4, pixel++, dst++) {
          image[dst] = data[src] / 255;
          image[plane + dst] = data[src + 1] / 255;
          image[2 * plane + dst] = data[src + 2] / 255;
          if (!mask[pixel]) continue;
          maskOut[dst] = 1;
          if (!own) continue;
          const gridCell = gridRow + (((win.x + wx) / cell) | 0);
          if (win.cell >= 0 ? gridCell === win.cell : clusterOf[gridCell] === win.cluster) own[wy * win.size + wx] = 1;
        }
      }
      if (own) writes.push({ win, weights: featherWeights(own, win.size, feather) });
    }
    return { output: run(image, maskOut, tile, runOptions),
      blend: (output) => {
        for (const { win, weights } of writes) {
          blendTile(result, imageData, win, output, weights, applied, { size: tile, x: win.at.x, y: win.at.y });
        }
      } };
  };
  const start = (job) => (job.windows ? startCanvas(job.windows) : startTile(job.tile));
  let next = 0, early = null;
  while (next < jobs.length && !early) {
    checkInpaintCurrent(signal, shouldContinue);
    early = start(jobs[next]);
    if (!early) next++;
  }
  // A superseded pass may abandon the copy while this inference is queued.
  early?.output.catch(() => {});
  result = await cloneImageDataChunked(imageData, { chunkBytes: cloneChunkBytes,
    check: () => checkInpaintCurrent(signal, shouldContinue) });
  applied = createSparseBlendWeights(width);
  let done = 0;
  for (let index = 0; index < jobs.length; index++) {
    // Tiles before `next` hold no mask of their own; without an early job none does.
    let task = null;
    if (index === next) task = early;
    else if (index > next) {
      checkInpaintCurrent(signal, shouldContinue);
      task = start(jobs[index]);
    }
    if (task) {
      const output = await task.output;
      checkInpaintCurrent(signal, shouldContinue);
      task.blend(output);
    }
    done++;
    if (onProgress) onProgress(done, jobs.length);
  }
  return { imageData: result, tiles: jobs.length,
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
 * `numThreads` loads the runtime with that many WASM threads (measurements;
 * it only takes effect on the realm's first load).
 */
export async function createInpaintSession(modelBytes, {
  prefer = defaultInferencePreference(), warmUp = true, memoBytes = null, numThreads = null
} = {}, { loadRuntime = loadOrt, backends = inpaintBackends } = {}) {
  const ort = await loadRuntime(Number.isInteger(numThreads) ? { numThreads } : {});
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
