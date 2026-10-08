// Cross-origin isolation at runtime (#264 Part A).
//
// The page and its workers are cross-origin isolated where the server sends
// COOP `same-origin` + COEP `require-corp` (scripts/cross-origin-isolation.mjs:
// the Vite servers, both vercel.json files, the desktop app's asset protocol).
// Isolated, `SharedArrayBuffer` exists and can be posted to workers, so a
// 16-bit plane can be handed to a worker without a copy. Elsewhere (a
// webview that does not isolate, a host without the headers) every caller
// keeps the copy path it had.
//
// Shared planes follow one rule (write-once): before a plane is published,
// exactly one thread writes it (row bands of one job count as one writer);
// after that, nobody does. The guard below hashes a shared plane before and
// after each worker job in dev, debug and smoke runs and reports any change.

// The message type of the isolation probe every worker answers
// (workers/isolationProbe.js; public/codecs/heif-worker.js spells it out).
export const ISOLATION_PROBE = 'nc-isolation-probe';

/** What a realm (page or worker) reports about itself. */
export function describeRealmIsolation(scope = globalThis) {
  return {
    crossOriginIsolated: scope?.crossOriginIsolated === true,
    sharedArrayBuffer: typeof scope?.SharedArrayBuffer === 'function',
    secureContext: scope?.isSecureContext === true
  };
}

/** True when this realm (page or worker) is cross-origin isolated. */
export function isCrossOriginIsolated(env = globalThis) {
  return Boolean(env) && env.crossOriginIsolated === true;
}

// `?sharedPlanes=0` keeps the copy path on an isolated page (a kill switch for
// comparisons and field reports). Workers never read it: the page decides and
// tells them.
function sharedPlanesDisabledByPage(env) {
  try {
    const search = env?.location?.search || '';
    return new URLSearchParams(search).get('sharedPlanes') === '0';
  } catch {
    return false;
  }
}

/**
 * Whether WASM threads can run here: isolated AND a SharedArrayBuffer
 * constructor. macOS WKWebView (the desktop app on tauri://localhost) reports
 * `crossOriginIsolated === true` without exposing SharedArrayBuffer, so the
 * flag alone is not enough.
 */
export function sharedMemoryAvailable(env = globalThis) {
  return isCrossOriginIsolated(env) && typeof env?.SharedArrayBuffer === 'function';
}

/**
 * Whether 16-bit planes may be allocated in shared memory here: isolated,
 * with a SharedArrayBuffer constructor, and not switched off on the page.
 */
export function sharedPlanesAvailable(env = globalThis) {
  return sharedMemoryAvailable(env) && !sharedPlanesDisabledByPage(env);
}

/** True when `view` is backed by a SharedArrayBuffer. */
export function isSharedPlane(view) {
  return typeof SharedArrayBuffer === 'function'
    && Boolean(view) && ArrayBuffer.isView(view)
    && view.buffer instanceof SharedArrayBuffer;
}

/**
 * A zeroed Uint16Array of `length` samples, in shared memory when `shared`
 * is true and this realm can share it (sharedPlanesAvailable), else a plain
 * one. Only whole-plane outputs go through here: the plane is built where it
 * is allocated, so publishing it needs no copy.
 */
export function allocPlane16(length, { shared = false, env = globalThis } = {}) {
  const count = Math.max(0, Math.floor(Number(length) || 0));
  if (shared && sharedMemoryAvailable(env)) {
    return new Uint16Array(new env.SharedArrayBuffer(count * 2));
  }
  return new Uint16Array(count);
}

// ---------------------------------------------------------------- the guard

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

// The guard's hash state: two 32-bit lanes over little-endian words, and the
// bytes of each range that do not fill a word.
function hashState(seed) {
  return { h1: 0x2F0F1CE5 ^ seed, h2: 0x85EBCA6B, tail: 0 };
}

function mixRange(state, buffer, byteOffset, byteLength) {
  const wordCount = Math.floor(byteLength / 4);
  let { h1, h2 } = state;
  if (LITTLE_ENDIAN && byteOffset % 4 === 0) {
    const words = new Uint32Array(buffer, byteOffset, wordCount);
    for (let i = 0; i < wordCount; i++) {
      const w = words[i];
      h1 = Math.imul(h1 ^ w, 0x01000193);
      h2 = Math.imul((h2 << 5) | (h2 >>> 27), 5) ^ w;
    }
  } else {
    const bytes = new Uint8Array(buffer, byteOffset, wordCount * 4);
    for (let i = 0; i < bytes.length; i += 4) {
      const w = (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0;
      h1 = Math.imul(h1 ^ w, 0x01000193);
      h2 = Math.imul((h2 << 5) | (h2 >>> 27), 5) ^ w;
    }
  }
  const rest = new Uint8Array(buffer, byteOffset + wordCount * 4, byteLength - wordCount * 4);
  let tail = state.tail;
  for (let i = 0; i < rest.length; i++) tail = Math.imul(tail ^ rest[i], 0x01000193);
  Object.assign(state, { h1, h2, tail });
}

function hashString(state, suffix) {
  return `${(state.h1 >>> 0).toString(16)}${(state.h2 >>> 0).toString(16)}:${(state.tail >>> 0).toString(16)}:${suffix}`;
}

/**
 * A content hash of a typed-array view (every byte, in little-endian 32-bit
 * words), for the guard and tests. Not cryptographic: it only has to notice
 * that a plane changed.
 */
export function hashPlane(view) {
  if (!view || !ArrayBuffer.isView(view)) return '';
  const state = hashState(Math.floor(view.byteLength / 4));
  mixRange(state, view.buffer, view.byteOffset, view.byteLength);
  return hashString(state, view.byteLength);
}

// The guard samples planes in pages of this size.
const GUARD_PAGE_BYTES = 4096;

/**
 * `hashPlane` for the guard: a view of up to `budgetBytes` whole; a larger one
 * by every `stride`-th 4 KB page and its last page, the stride chosen so that
 * about `budgetBytes` are read. Any write that spans `stride` pages or more
 * (at 4 MP, two rows of RGBA16) changes the sampled hash; the same view and
 * budget always sample the same pages.
 */
export function hashPlaneSample(view, budgetBytes = Infinity) {
  if (!view || !ArrayBuffer.isView(view)) return '';
  if (!(view.byteLength > budgetBytes)) return hashPlane(view);
  const pages = Math.ceil(view.byteLength / GUARD_PAGE_BYTES);
  const stride = Math.max(1, Math.ceil(pages / Math.max(1, Math.floor(budgetBytes / GUARD_PAGE_BYTES))));
  const state = hashState(pages);
  const mixPage = (page) => {
    const start = page * GUARD_PAGE_BYTES;
    mixRange(state, view.buffer, view.byteOffset + start, Math.min(GUARD_PAGE_BYTES, view.byteLength - start));
  };
  for (let page = 0; page < pages; page += stride) mixPage(page);
  if ((pages - 1) % stride !== 0) mixPage(pages - 1);
  return hashString(state, `${view.byteLength}/${stride}`);
}

const guardState = {
  enabled: null,
  fullBytes: 0,
  checks: 0,
  sampled: 0,
  violations: []
};

// Dev (every browser smoke run), `?debug=1` and `?planeGuard=1` hash. A plane
// of up to 4 MB is hashed whole, a larger one by a page sample of about 4 MB
// (hashPlaneSample), so the guard costs an interaction a few milliseconds,
// not the ~50 ms a whole 4 MP plane takes; `?planeGuard=1` hashes every byte
// of every plane, `?planeGuard=0` turns the guard off.
const GUARD_SAMPLE_BYTES = 4 * 1024 * 1024;

function readGuardConfig(env = globalThis) {
  let param = null;
  let debug = false;
  try {
    const params = new URLSearchParams(env?.location?.search || '');
    param = params.get('planeGuard');
    debug = params.get('debug') === '1';
  } catch { /* no location: a worker or Node */ }
  let dev = false;
  try { dev = Boolean(import.meta.env?.DEV); } catch { dev = false; }
  if (param === '0') return { enabled: false, fullBytes: 0 };
  if (param === '1') return { enabled: true, fullBytes: Infinity };
  return { enabled: dev || debug, fullBytes: GUARD_SAMPLE_BYTES };
}

/**
 * Test and smoke hook: force the guard on or off (null re-reads the page).
 * `fullBytes`: planes up to this size are hashed whole, larger ones sampled.
 */
export function configurePlaneGuard({ enabled = null, fullBytes = Infinity } = {}) {
  if (enabled === null) {
    guardState.enabled = null;
    return;
  }
  guardState.enabled = Boolean(enabled);
  guardState.fullBytes = fullBytes;
}

function guardConfig() {
  if (guardState.enabled === null) {
    const config = readGuardConfig();
    guardState.enabled = config.enabled;
    guardState.fullBytes = config.fullBytes;
  }
  return guardState;
}

/**
 * Hashes the shared planes among `views` before a worker job; `verify()`
 * after the job hashes them again and records (and logs) every plane that
 * changed. Plain planes are ignored: a worker gets its own copy of those. A
 * no-op unless the guard is enabled.
 * @param {string} label the job, for the report
 * @param {Array<ArrayBufferView|null|undefined>} views
 * @returns {{ verify(): boolean }} verify() is false when a plane changed
 */
export function guardSharedPlanes(label, views) {
  const config = guardConfig();
  if (!config.enabled) return { verify: () => true };
  const watched = [];
  const budget = config.fullBytes;
  for (const view of views || []) {
    if (!isSharedPlane(view) || watched.some((entry) => entry.view === view)) continue;
    if (view.byteLength > budget) config.sampled++;
    watched.push({ view, before: hashPlaneSample(view, budget) });
  }
  if (!watched.length) return { verify: () => true };
  let done = false;
  return {
    verify() {
      if (done) return true;
      done = true;
      let intact = true;
      for (const entry of watched) {
        config.checks++;
        const after = hashPlaneSample(entry.view, budget);
        if (after === entry.before) continue;
        intact = false;
        const violation = { label, bytes: entry.view.byteLength, before: entry.before, after };
        config.violations.push(violation);
        console.error('[isolation] a shared plane changed during a worker job (write-once rule broken):', violation);
      }
      return intact;
    }
  };
}

/** What the guard has done: { enabled, checks, sampled, violations }. */
export function planeGuardReport() {
  const config = guardConfig();
  return {
    enabled: config.enabled,
    checks: config.checks,
    sampled: config.sampled,
    violations: config.violations.slice()
  };
}

// ------------------------------------------------------ derived 8-bit planes

// ImageData whose 8-bit plane is its 16-bit plane `>>> 8`, sample for sample:
// a fresh RAW decode (the post-decode pass builds its mirror that way) and the
// geometry outputs of such a frame (the kernels copy or derive both planes
// alike). A worker that holds the shared 16-bit plane derives the 8-bit bytes
// itself instead of receiving a copy of them (#264). The mark holds while
// `__image16.data` is the plane it was made from: a published plane is not
// written again (the write-once rule).
const derivedEightBit = new WeakMap();

/** Marks `image` as carrying an 8-bit plane derived from its 16-bit one. Returns it. */
export function markDerivedEightBit(image) {
  const data16 = image?.__image16?.data;
  if (image && typeof image === 'object' && data16) derivedEightBit.set(image, data16);
  return image;
}

/** True when `image`'s 8-bit plane is its current 16-bit plane `>>> 8`. */
export function hasDerivedEightBit(image) {
  const data16 = image?.__image16?.data;
  return Boolean(data16) && derivedEightBit.get(image) === data16;
}

/** The 8-bit RGBA bytes of a 16-bit plane (`>>> 8`), as toImageData8 makes them. */
export function deriveEightBit(data16) {
  const out = new Uint8ClampedArray(data16.length);
  for (let i = 0; i < data16.length; i++) out[i] = data16[i] >>> 8;
  return out;
}
