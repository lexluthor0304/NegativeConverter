// Film statistics per decoded plane (#232 part 4).
//
// `autoDetectFilmBase` and the automatic `detectFilmType` are pure functions
// of the plane, so a result computed once for an ImageData stays valid for as
// long as nobody rewrites that plane in place (nothing in the app does: every
// geometry step produces a new ImageData; a future in-place writer must call
// forgetFilmStats). Entries are keyed by the ImageData object in a WeakMap and
// tied to its current `data` and `__image16`, so re-attaching a different
// 16-bit plane misses instead of returning stale numbers.
//
// The RAW post-decode worker computes both statistics on the plane it
// returns; loadRawFile primes this cache with them, so createDefaultSettings
// on a fresh RAW decode costs no main-thread sorting. Everything else (TIFF,
// JPEG, PNG, previews, transformed images) computes here on first use.
import { autoDetectFilmBase, normalizeBorderBufferPct } from './filmBaseDetection.js';
import { detectFilmType } from './filmTypeDetection.js';

const entries = new WeakMap();

// Diagnostics for tests and the #230 harness: how often each statistic was
// actually computed on this thread, and how often a cached (or worker-primed)
// result was served instead.
export const filmStatsCounters = { filmBaseComputed: 0, filmBaseHits: 0, filmTypeComputed: 0, filmTypeHits: 0 };

function entryFor(imageData) {
  const image16 = imageData.__image16 || null;
  let entry = entries.get(imageData);
  if (!entry || entry.data !== imageData.data || entry.image16 !== image16) {
    entry = { data: imageData.data, image16, filmBase: new Map(), filmType: null };
    entries.set(imageData, entry);
  }
  return entry;
}

function cacheable(imageData) {
  return Boolean(imageData) && typeof imageData === 'object';
}

/**
 * autoDetectFilmBase, memoised per (ImageData, effective border buffer).
 * Always returns a fresh copy.
 */
export function cachedAutoDetectFilmBase(imageData, borderBufferPct = 10) {
  if (!cacheable(imageData)) return autoDetectFilmBase(imageData, borderBufferPct);
  const key = normalizeBorderBufferPct(borderBufferPct);
  const entry = entryFor(imageData);
  let result = entry.filmBase.get(key);
  if (result) {
    filmStatsCounters.filmBaseHits++;
  } else {
    filmStatsCounters.filmBaseComputed++;
    result = autoDetectFilmBase(imageData, key);
    entry.filmBase.set(key, result);
  }
  return { ...result };
}

/**
 * detectFilmType(imageData) with its default options, memoised per ImageData.
 * Always returns a fresh copy.
 */
export function cachedDetectFilmType(imageData) {
  if (!cacheable(imageData)) return detectFilmType(imageData);
  const entry = entryFor(imageData);
  if (entry.filmType) {
    filmStatsCounters.filmTypeHits++;
  } else {
    filmStatsCounters.filmTypeComputed++;
    entry.filmType = detectFilmType(imageData);
  }
  return { ...entry.filmType };
}

/**
 * Store statistics computed elsewhere (the post-decode worker) on exactly the
 * plane `imageData` holds. `borderBufferPct` is the buffer the film base was
 * computed with; a later request for another buffer computes afresh.
 */
export function primeFilmStats(imageData, { borderBufferPct, filmBase = null, filmType = null } = {}) {
  if (!cacheable(imageData)) return;
  const entry = entryFor(imageData);
  if (filmBase && typeof filmBase === 'object') {
    entry.filmBase.set(normalizeBorderBufferPct(borderBufferPct), { ...filmBase });
  }
  if (filmType && typeof filmType === 'object') entry.filmType = { ...filmType };
}

/** Drop everything cached for this ImageData (call after writing its pixels in place). */
export function forgetFilmStats(imageData) {
  if (cacheable(imageData)) entries.delete(imageData);
}

/** Test/diagnostic hook: whether statistics are cached for this plane and buffer. */
export function hasCachedFilmBase(imageData, borderBufferPct = 10) {
  if (!cacheable(imageData)) return false;
  const entry = entries.get(imageData);
  return Boolean(entry && entry.data === imageData.data && entry.image16 === (imageData.__image16 || null)
    && entry.filmBase.has(normalizeBorderBufferPct(borderBufferPct)));
}
