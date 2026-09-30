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
 * Whether 16-bit planes may be allocated in shared memory here: isolated,
 * with a SharedArrayBuffer constructor, and not switched off on the page.
 */
export function sharedPlanesAvailable(env = globalThis) {
  return isCrossOriginIsolated(env)
    && typeof env.SharedArrayBuffer === 'function'
    && !sharedPlanesDisabledByPage(env);
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
  if (shared && isCrossOriginIsolated(env) && typeof env.SharedArrayBuffer === 'function') {
    return new Uint16Array(new env.SharedArrayBuffer(count * 2));
  }
  return new Uint16Array(count);
}

// ---------------------------------------------------------------- the guard

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * A content hash of a typed-array view (every byte, in little-endian 32-bit
 * words), for the guard and tests. Not cryptographic: it only has to notice
 * that a plane changed.
 */
export function hashPlane(view) {
  if (!view || !ArrayBuffer.isView(view)) return '';
  const wordCount = Math.floor(view.byteLength / 4);
  let h1 = 0x2F0F1CE5 ^ wordCount;
  let h2 = 0x85EBCA6B;
  const mix = (w) => {
    h1 = Math.imul(h1 ^ w, 0x01000193);
    h2 = Math.imul((h2 << 5) | (h2 >>> 27), 5) ^ w;
  };
  if (LITTLE_ENDIAN && view.byteOffset % 4 === 0) {
    const words = new Uint32Array(view.buffer, view.byteOffset, wordCount);
    for (let i = 0; i < wordCount; i++) mix(words[i]);
  } else {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, wordCount * 4);
    for (let i = 0; i < bytes.length; i += 4) mix((bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24)) >>> 0);
  }
  let tail = 0;
  const rest = new Uint8Array(view.buffer, view.byteOffset + wordCount * 4, view.byteLength - wordCount * 4);
  for (let i = 0; i < rest.length; i++) tail = Math.imul(tail ^ rest[i], 0x01000193);
  return `${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}:${(tail >>> 0).toString(16)}:${view.byteLength}`;
}

const guardState = {
  enabled: null,
  maxBytes: 0,
  checks: 0,
  skipped: 0,
  violations: []
};

// Dev (every browser smoke run), `?debug=1` and `?planeGuard=1` hash; above
// 256 MB (about 32 MP) only an explicit `?planeGuard=1` does, so a dev session
// on 60 MP files is not slowed by it. `?planeGuard=0` turns it off.
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
  if (param === '0') return { enabled: false, maxBytes: 0 };
  if (param === '1') return { enabled: true, maxBytes: Infinity };
  return { enabled: dev || debug, maxBytes: 256 * 1024 * 1024 };
}

/** Test and smoke hook: force the guard on or off (null re-reads the page). */
export function configurePlaneGuard({ enabled = null, maxBytes = Infinity } = {}) {
  if (enabled === null) {
    guardState.enabled = null;
    return;
  }
  guardState.enabled = Boolean(enabled);
  guardState.maxBytes = maxBytes;
}

function guardConfig() {
  if (guardState.enabled === null) {
    const config = readGuardConfig();
    guardState.enabled = config.enabled;
    guardState.maxBytes = config.maxBytes;
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
  for (const view of views || []) {
    if (!isSharedPlane(view) || watched.some((entry) => entry.view === view)) continue;
    if (view.byteLength > config.maxBytes) {
      config.skipped++;
      continue;
    }
    watched.push({ view, before: hashPlane(view) });
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
        const after = hashPlane(entry.view);
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

/** What the guard has done: { enabled, checks, skipped, violations }. */
export function planeGuardReport() {
  const config = guardConfig();
  return {
    enabled: config.enabled,
    checks: config.checks,
    skipped: config.skipped,
    violations: config.violations.slice()
  };
}
