// RAW post-decode steps (#232): everything between LibRaw's imageData()
// result and the planes the app keeps, as a plain module. The per-decode
// worker (workers/rawPostDecodeWorker.js) runs it, and so does every
// main-thread fallback, so both paths produce the same bytes. The steps run in
// the order the loader always used:
//   1. rawResultToRgb16          normalise LibRaw's samples to 16 bits
//   2. packRGBToImage16          RGBA16 plane; the RGB16 source is released
//   3. looksLikeBayerSnow        garbled output stops here, before any repair
//   4. suppressSensorDefects     unless the caller passed false
//   5. toRGBA8                   the >>> 8 mirror
//   6. film statistics           only when requested (photo without settings)
// Nothing here imports libraw-wasm or touches the DOM.
import { rawResultToRgb16 } from './rawResultToRgb16.js';
import { packRGBToImage16, toRGBA8 } from '../silvercore/util/image16.js';
import { looksLikeBayerSnow } from '../silvercore/util/garbledCheck.js';
import { suppressSensorDefects } from '../silvercore/util/sensorDefects.js';
import { detectFilmType } from './filmTypeDetection.js';
import { autoDetectFilmBase, normalizeBorderBufferPct } from './filmBaseDetection.js';

function noDefects() {
  return { repaired: 0, dead: 0, hot: 0, perChannel: [0, 0, 0] };
}

// Free an ArrayBuffer now instead of whenever GC gets to it. Only plain
// ArrayBuffers with the (feature-detected) transfer() can be detached.
function detachBuffer(buffer) {
  if (!buffer || typeof ArrayBuffer === 'undefined' || !(buffer instanceof ArrayBuffer)) return;
  if (typeof buffer.transfer !== 'function' || buffer.byteLength === 0) return;
  try { buffer.transfer(0); } catch {}
}

/**
 * Steps 1–2. Returns the RGBA16 plane `{ width, height, data }`.
 *
 * With `releaseSource` (the default) every source buffer that the RGBA16
 * plane does not live in is detached as soon as packing is done: the RGB16
 * plane and an 8-bit source. A 4-channel source is wrapped rather than copied,
 * so its buffer IS the RGBA16 plane and is never detached.
 */
export function packRawResult(result, { releaseSource = true } = {}) {
  const source = result?.data;
  const { rgb16, channels } = rawResultToRgb16(result);
  const image16 = packRGBToImage16(result.width, result.height, rgb16, channels);
  if (releaseSource) {
    const kept = image16.data.buffer;
    if (rgb16.buffer !== kept) detachBuffer(rgb16.buffer);
    const sourceBuffer = source?.buffer;
    if (sourceBuffer && sourceBuffer !== kept && sourceBuffer !== rgb16.buffer) detachBuffer(sourceBuffer);
  }
  return image16;
}

/**
 * Step 6 on the final planes, exactly as the main thread would compute them
 * on the returned ImageData (whose `__image16` is this plane).
 */
export function computeFilmStats(image16, rgba8, borderBufferPct) {
  const { width, height } = image16;
  const probe = { width, height, data: rgba8, __image16: image16 };
  const buffer = normalizeBorderBufferPct(borderBufferPct);
  return {
    borderBufferPct: buffer,
    filmType: detectFilmType(probe),
    filmBase: autoDetectFilmBase(probe, buffer)
  };
}

/**
 * Steps 3–6 from a packed plane. `from: 'repaired'` resumes after a worker
 * that already ran the defect pass (with its `defects` stats) failed later.
 * `progress`, when given, records how far the steps got, so a worker can
 * hand back the right plane on failure.
 *
 * @returns {{ garbled: true } | { garbled: false, width: number, height: number,
 *   rgba16: Uint16Array, rgba8: Uint8ClampedArray, defects: object, filmStats: object | null }}
 */
export function finishRawPostDecode(image16, options = {}, { from = 'packed', defects = null } = {}, progress = null) {
  if (from !== 'repaired') {
    if (looksLikeBayerSnow(image16)) return { garbled: true };
    defects = options.suppressSensorDefects === false ? noDefects() : suppressSensorDefects(image16);
    if (progress) { progress.stage = 'repaired'; progress.defects = defects; }
  }
  const rgba8 = toRGBA8(image16).data;
  const filmStats = options.filmStats ? computeFilmStats(image16, rgba8, options.filmStats.borderBufferPct) : null;
  return {
    garbled: false,
    width: image16.width,
    height: image16.height,
    rgba16: image16.data,
    rgba8,
    defects: defects || noDefects(),
    filmStats
  };
}

/**
 * All steps. `options`: `{ suppressSensorDefects?: boolean, filmStats?: { borderBufferPct } | null }`.
 */
export function runRawPostDecode(result, options = {}, progress = null) {
  const image16 = packRawResult(result, options);
  if (progress) { progress.stage = 'packed'; progress.image16 = image16; }
  return finishRawPostDecode(image16, options, { from: 'packed' }, progress);
}

// ---------------------------------------------------------------------------
// Worker protocol. Kept here (not in the worker entry) so tests can drive the
// exact message handling without a real Worker.
// ---------------------------------------------------------------------------

const VIEW_TYPES = { Uint8Array, Uint8ClampedArray, Uint16Array };

/** Describe a typed-array view so it can cross postMessage with its buffer transferred. */
export function describeView(view) {
  return {
    kind: view.constructor.name,
    buffer: view.buffer,
    byteOffset: view.byteOffset,
    length: view.length
  };
}

/** Rebuild a view described by describeView. */
export function viewFromDescription(desc) {
  const Type = VIEW_TYPES[desc?.kind];
  if (!Type || !desc.buffer) throw new TypeError(`Unsupported view: ${desc?.kind}`);
  return new Type(desc.buffer, desc.byteOffset, desc.length);
}

/** Whether a LibRaw result's samples can be transferred to the worker. */
export function isTransferableRawData(data) {
  return Boolean(data)
    && Object.prototype.hasOwnProperty.call(VIEW_TYPES, data.constructor?.name)
    && data instanceof VIEW_TYPES[data.constructor.name]
    && typeof ArrayBuffer !== 'undefined'
    && data.buffer instanceof ArrayBuffer;
}

/**
 * Handle one message on the worker side. `reply(message, transfer)` posts back.
 *
 * - `{ type: 'ping', id }` → `{ type: 'pong', id }`
 * - `{ type: 'process', id, width, height, bits, colors, input, options }` →
 *   `{ type: 'result', id, garbled: true }`, or
 *   `{ type: 'result', id, width, height, rgba16, rgba8, defects, filmStats }`
 *   with both planes transferred, or on failure
 *   `{ type: 'error', id, message, code, stage, input? | rgba16?, defects? }`
 *   handing back whatever pixels are still intact: the untouched input when
 *   packing had not finished ('input'), else the RGBA16 plane — before the
 *   defect pass ran ('packed') or after it ('repaired').
 */
export function handleRawPostDecodeMessage(msg, reply) {
  if (msg?.type === 'ping') {
    reply({ type: 'pong', id: msg.id });
    return;
  }
  const id = msg?.id;
  if (msg?.type !== 'process') {
    reply({ type: 'error', id, message: `Unknown message type: ${msg?.type}`, stage: 'input' });
    return;
  }
  const progress = { stage: 'input', image16: null, defects: null };
  try {
    const data = viewFromDescription(msg.input);
    const outcome = runRawPostDecode(
      { width: msg.width, height: msg.height, bits: msg.bits, colors: msg.colors, data },
      msg.options || {},
      progress
    );
    if (outcome.garbled) {
      reply({ type: 'result', id, garbled: true });
      return;
    }
    const rgba16 = describeView(outcome.rgba16);
    const rgba8 = describeView(outcome.rgba8);
    reply({
      type: 'result',
      id,
      garbled: false,
      width: outcome.width,
      height: outcome.height,
      rgba16,
      rgba8,
      defects: outcome.defects,
      filmStats: outcome.filmStats
    }, [rgba16.buffer, rgba8.buffer]);
  } catch (err) {
    const message = {
      type: 'error',
      id,
      message: err?.message || String(err),
      code: err?.code,
      name: err?.name,
      stage: progress.stage
    };
    const transfer = [];
    if (progress.stage === 'input') {
      if (msg.input?.buffer?.byteLength > 0) {
        message.input = msg.input;
        transfer.push(msg.input.buffer);
      }
    } else if (progress.image16?.data?.buffer?.byteLength > 0) {
      message.rgba16 = describeView(progress.image16.data);
      if (progress.stage === 'repaired') message.defects = progress.defects;
      transfer.push(message.rgba16.buffer);
    }
    reply(message, transfer);
  }
}
