// Ownership and release of export pixel planes (#250).
//
// An export copies a frame at every stage boundary only because nothing could
// tell a plane the export allocated from one the editor still shows. Producers
// that allocate a fresh plane for an export stamp its buffer here; only a
// stamped buffer may be handed to a worker without a copy (transferred), and
// only a stamped buffer may be released when the export ends. A stamp is never
// enough on its own: a buffer that a live `state.*` plane, a photo session or a
// history snapshot references is refused as well (main.js registers that
// probe), because a conversion result stamped by the worker client may also
// have become the editor's `processedImageData`.
//
// Release frees the backing store now instead of at the owning isolate's next
// major GC, which after an export may be minutes away:
// - WebKit (WKWebView, WebKitGTK, Safari): `ArrayBuffer.prototype.transfer(0)`
//   frees without a GC and throws instead of copying. Older WebKit only drops
//   the references. Never a worker sink there: transferring a buffer WebKit
//   cannot detach copies it.
// - Chromium: `transfer(0)` does not free buffers Blink co-owns (ImageData and
//   message-received buffers), so one throwaway `blob:` worker receives every
//   buffer of the call in a single transfer list and is terminated.

const ownedBuffers = new WeakSet();
const liveMutableBuffers = new WeakSet();
let liveReferenceProbe = null;

function bufferOf(value) {
  if (!value) return null;
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer instanceof ArrayBuffer ? value.buffer : null;
  return null;
}

/**
 * The `.data` and `.__image16.data` buffers of an ImageData-like item (or the
 * buffer of a typed array / ArrayBuffer), in that order, without duplicates.
 */
export function planeBuffersOf(item) {
  const buffers = [];
  const add = (buffer) => { if (buffer && !buffers.includes(buffer)) buffers.push(buffer); };
  if (!item) return buffers;
  const direct = bufferOf(item);
  if (direct) {
    add(direct);
    return buffers;
  }
  add(bufferOf(item.data));
  if (item.__image16) add(bufferOf(item.__image16.data));
  return buffers;
}

/** True when two items share a plane buffer (see planeBuffersOf). */
export function sharesPlaneBuffers(a, b) {
  if (!a || !b) return false;
  const buffers = planeBuffersOf(b);
  return planeBuffersOf(a).some((buffer) => buffers.includes(buffer));
}

/** Stamp the planes of each item as export-owned. Returns the first item. */
export function markOwnedPlanes(...items) {
  for (const item of items) {
    for (const buffer of planeBuffersOf(item)) ownedBuffers.add(buffer);
  }
  return items[0];
}

export function isOwnedBuffer(buffer) {
  return Boolean(buffer) && ownedBuffers.has(buffer);
}

/**
 * Mark the planes of an item the editor rewrites in place: its `.data` and
 * `.__image16.data` buffers (or the buffer of a typed array). The
 * dust-repaired image is one (#259): brush strokes, their undo and redo and
 * the learned-repair refresh patch it, and undo is not blocked while an
 * export runs. A copy spread over several tasks could mix rows from before
 * and after a write, so the bridges copy a marked plane in one task.
 */
export function markLiveMutableBuffer(value) {
  for (const buffer of planeBuffersOf(value)) liveMutableBuffers.add(buffer);
}

export function isLiveMutableBuffer(value) {
  const buffer = bufferOf(value);
  return Boolean(buffer) && liveMutableBuffers.has(buffer);
}

/**
 * `probe()` returns the buffers the editor still references (an iterable of
 * ArrayBuffers): live `state.*` planes, photo sessions, history snapshots.
 */
export function setLiveReferenceProbe(probe) {
  liveReferenceProbe = typeof probe === 'function' ? probe : null;
}

function liveReferences() {
  if (!liveReferenceProbe) return new Set();
  try {
    const referenced = liveReferenceProbe();
    return referenced instanceof Set ? referenced : new Set(referenced || []);
  } catch (err) {
    // Without an answer, nothing may be treated as free.
    console.warn('Plane reference probe failed; nothing is transferred or released:', err);
    return null;
  }
}

function isDetached(buffer) {
  if (typeof buffer.detached === 'boolean') return buffer.detached;
  return buffer.byteLength === 0;
}

/**
 * True when `buffer` may leave this thread without a copy: stamped, not
 * detached, and referenced by no live editor plane.
 */
export function mayTransferBuffer(buffer) {
  if (!(buffer instanceof ArrayBuffer) || !ownedBuffers.has(buffer) || isDetached(buffer)) return false;
  const referenced = liveReferences();
  return Boolean(referenced) && !referenced.has(buffer);
}

// ------------------------------------------------------------ release engine

let engineOverride = null;
let workerFactoryOverride = null;
let sinkUrl = null;

/** 'webkit', 'chromium' or 'none' (drop references only). */
export function detectReleaseEngine(env = globalThis) {
  const nav = env && env.navigator;
  if (!nav) return 'none';
  const brands = nav.userAgentData && Array.isArray(nav.userAgentData.brands) ? nav.userAgentData.brands : null;
  if (brands && brands.some((brand) => /Chromium|Google Chrome|Microsoft Edge/i.test(brand.brand || ''))) return 'chromium';
  const ua = String(nav.userAgent || '');
  if (/Chrome\/|Chromium\/|CriOS\/|Edg\//.test(ua)) return 'chromium';
  if (/AppleWebKit\//.test(ua)) return 'webkit';
  return 'none';
}

/** Test hook: force the engine and the throwaway-worker factory. */
export function configurePlaneRelease({ engine = null, workerFactory = null } = {}) {
  engineOverride = engine;
  workerFactoryOverride = workerFactory;
}

function releaseEngine() {
  return engineOverride || detectReleaseEngine();
}

const SINK_SOURCE = 'onmessage=function(){postMessage(0)}';
const SINK_TERMINATE_AFTER_MS = 2000;

function createSinkWorker() {
  if (workerFactoryOverride) return workerFactoryOverride();
  if (typeof Worker !== 'function' || typeof Blob !== 'function' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  if (!sinkUrl) sinkUrl = URL.createObjectURL(new Blob([SINK_SOURCE], { type: 'text/javascript' }));
  return new Worker(sinkUrl);
}

// Every buffer goes in one transfer list; the worker is terminated once it
// has them (or after a bound, if it never answers), which frees them with its
// isolate. A worker that cannot start leaves the references to be dropped.
function releaseThroughWorker(buffers) {
  let sink;
  try {
    sink = createSinkWorker();
  } catch {
    sink = null;
  }
  if (!sink) return false;
  let timer = null;
  const finish = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    try { sink.terminate(); } catch { /* already gone */ }
  };
  try {
    sink.onmessage = finish;
    sink.onerror = finish;
    sink.postMessage(null, buffers);
  } catch {
    finish();
    return false;
  }
  timer = setTimeout(finish, SINK_TERMINATE_AFTER_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return true;
}

function releaseByTransfer(buffers) {
  let freed = 0;
  for (const buffer of buffers) {
    if (typeof buffer.transfer !== 'function') continue;
    try {
      buffer.transfer(0);
      freed++;
    } catch {
      // A buffer the engine refuses to detach keeps its references dropped.
    }
  }
  return freed;
}

/**
 * Free the planes of `items` that this export owns. Collects `.data` and
 * `.__image16.data` of each item; skips duplicates and detached buffers;
 * refuses unstamped buffers and buffers a live editor plane references.
 * Never throws.
 * @returns {{released: number, bytes: number, refused: number, skipped: number, method: string}}
 */
export function releaseOwnedPlanes(...items) {
  const summary = { released: 0, bytes: 0, refused: 0, skipped: 0, method: 'none' };
  const candidates = [];
  for (const item of items) {
    for (const buffer of planeBuffersOf(item)) {
      if (candidates.includes(buffer)) continue;
      candidates.push(buffer);
    }
  }
  if (!candidates.length) return summary;
  const referenced = liveReferences();
  const releasable = [];
  for (const buffer of candidates) {
    if (isDetached(buffer)) {
      summary.skipped++;
      continue;
    }
    if (!ownedBuffers.has(buffer) || !referenced || referenced.has(buffer)) {
      summary.refused++;
      continue;
    }
    releasable.push(buffer);
  }
  if (!releasable.length) return summary;
  const bytes = releasable.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const engine = releaseEngine();
  try {
    if (engine === 'webkit') {
      summary.method = releaseByTransfer(releasable) ? 'transfer' : 'drop';
    } else if (engine === 'chromium') {
      summary.method = releaseThroughWorker(releasable) ? 'worker' : 'drop';
    } else {
      summary.method = 'drop';
    }
  } catch {
    summary.method = 'drop';
  }
  for (const buffer of releasable) ownedBuffers.delete(buffer);
  summary.released = releasable.length;
  summary.bytes = bytes;
  return summary;
}
