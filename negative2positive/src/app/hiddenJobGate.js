/**
 * Hidden-job gate (#241): when long jobs may start their next item while the
 * window is hidden.
 *
 * The desktop window runs with WebKit's background throttling disabled, so a
 * hidden macOS app keeps exporting and analysing. WebKit then marks the hidden
 * WebContent process inactive after 8 minutes and lowers its kill limit on a
 * 16 GB Mac from 8 GiB (7 + 1 per page) to 4 GiB (3 + 1 per page); above it
 * the process is killed and the app reloads to the import screen. A hidden
 * 60 MP job needs an estimated 5-6.5 GB. Every caller (batch exports, roll
 * analysis, the thumbnail lane) asks here before an item starts:
 *
 * - visible: admit at once, with the caller's normal lane plan;
 * - hidden on macOS WebKit: one item in flight across all callers; for the
 *   first HIDDEN_GRACE_MS the active 8 GiB limit still applies, so no byte
 *   check; after that only when resident + estimated bytes fit HIDDEN_BUDGET,
 *   otherwise the item waits until the window is visible again or its signal
 *   aborts (running items finish);
 * - hidden on Chromium or WebKitGTK: the normal plan (no per-renderer limit
 *   for hidden pages there).
 *
 * Pure: no DOM. main.js supplies visibility, the platform test and the
 * resident-bytes estimate, and forwards visibilitychange.
 *
 * The WebKit figures below come from its source (MemoryPressureHandler.cpp,
 * PerformanceMonitor.cpp) and can change with a macOS release: re-check them,
 * and HIDDEN_GRACE_MS, for each one. #258 replaces this local estimate with
 * its renderer-wide budget.
 */

// WebKit: delayBeforeProcessMayBecomeInactive, restarted each time the page hides.
export const WEBKIT_INACTIVE_DELAY_MS = 8 * 60 * 1000;
// WebKit: thresholdForMemoryKillOfInactiveProcess with one page, RAM <= 16 GiB.
export const WEBKIT_INACTIVE_KILL_BYTES = 4 * 1024 ** 3;
// Hidden time during which the active limit still applies. It leaves the last
// admitted item (a 60 MP JPEG at 20 % of the visible rate takes about 105 s,
// estimate) time to finish before the 8-minute transition. Set it to 0 once a
// shipped macOS applies the UI-process MemoryFootprintMonitor, which enforces
// 4 GiB on background pages at its next 30 s poll.
export const HIDDEN_GRACE_MS = 5 * 60 * 1000;
// Counted bytes allowed after the grace period. The uncounted rest of the
// process (about 1 GB with one 60 MP photo open, estimate) must fit between
// this and the 4 GiB kill limit.
export const HIDDEN_BUDGET_BYTES = 3.3e9;
// One in-flight frame, per pixel (batchExportScheduler's measured figure,
// until #256 records its lane footprint).
export const LANE_BYTES_PER_PIXEL = 50;

/**
 * The hidden limits apply to WebKit on a Mac: the desktop app's WKWebView and
 * Safari. The UA test is inferenceBackend's; WebKitGTK on Linux has neither
 * the inactive policy nor these limits.
 */
export function hiddenJobLimitsApply({
  platform = globalThis.navigator?.platform || '',
  userAgent = globalThis.navigator?.userAgent || ''
} = {}) {
  const webkit = /AppleWebKit/.test(userAgent) && !/(Chrome|Chromium|Edg|OPR)\//.test(userAgent);
  return webkit && /^Mac/.test(platform);
}

/**
 * Bytes one item needs while it runs. The RAW decode peak and the post-decode
 * lane peak do not coincide, so the larger of the two counts, not their sum.
 */
export function estimateHiddenJobBytes(pixels, decodeBytes = 0) {
  const px = Math.max(0, Number(pixels) || 0);
  return Math.max(Math.max(0, Number(decodeBytes) || 0), px * LANE_BYTES_PER_PIXEL);
}

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('Hidden-job admission aborted', 'AbortError');
  const error = new Error('Hidden-job admission aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * @param {object} options
 * @param {() => boolean} options.isHidden document.visibilityState === 'hidden'
 * @param {() => boolean} [options.limitsApply] hiddenJobLimitsApply()
 * @param {() => number} [options.residentBytes] counted bytes the page holds
 * @param {() => number} [options.now]
 * @param {number} [options.graceMs]
 * @param {number} [options.budgetBytes]
 * @param {(status: object) => void} [options.onChange] held/paused changes
 * @param {() => void} [options.onHiddenAdmit] before each admission under the
 *   hidden limits (shed idle workers between frames)
 * @param {() => void} [options.onGraceExpired] hidden for graceMs
 * @param {() => void} [options.onIdle] the last admitted item was released and
 *   nothing waits (a job ended)
 */
export function createHiddenJobGate({
  isHidden,
  limitsApply = () => false,
  residentBytes = () => 0,
  now = () => Date.now(),
  graceMs = HIDDEN_GRACE_MS,
  budgetBytes = HIDDEN_BUDGET_BYTES,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  onChange = () => {},
  onHiddenAdmit = () => {},
  onGraceExpired = () => {},
  onIdle = () => {}
} = {}) {
  if (typeof isHidden !== 'function') throw new TypeError('createHiddenJobGate needs isHidden()');
  const waiters = [];
  let inFlight = 0;
  let hiddenSince = isHidden() ? now() : null;
  let graceTimer = null;
  let safeMode = false;
  let paused = false;
  let pumping = false;

  const limited = () => safeMode || Boolean(limitsApply());
  const graceOver = () => hiddenSince !== null && now() - hiddenSince >= graceMs;

  // null: admit; otherwise why the item is held.
  function holdReason(bytes) {
    const hidden = isHidden();
    if (!hidden) return safeMode && inFlight > 0 ? 'one-in-flight' : null;
    if (!limited()) return null;
    if (inFlight > 0) return 'one-in-flight';
    if (!graceOver()) return null;
    return residentBytes() + bytes <= budgetBytes ? null : 'budget';
  }

  function setPaused(next) {
    if (paused === next) return;
    paused = next;
    onChange(status());
  }

  function makeRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inFlight -= 1;
      pump();
      if (!inFlight && !waiters.length) onIdle();
    };
  }

  function admitNow() {
    if (isHidden() && limited()) onHiddenAdmit();
    inFlight += 1;
    return makeRelease();
  }

  function pump() {
    if (pumping) return;
    pumping = true;
    try {
      let held = false;
      while (waiters.length) {
        const waiter = waiters[0];
        const reason = holdReason(waiter.bytes);
        if (reason) { held = reason === 'budget'; break; }
        waiters.shift();
        waiter.signal?.removeEventListener?.('abort', waiter.onAbort);
        waiter.resolve(admitNow());
      }
      setPaused(held);
    } finally {
      pumping = false;
    }
  }

  function armGraceTimer() {
    if (graceTimer !== null) clearTimer(graceTimer);
    graceTimer = setTimer(() => {
      graceTimer = null;
      if (hiddenSince === null) return;
      onGraceExpired();
      pump();
    }, graceMs);
  }

  function status() {
    return {
      hidden: hiddenSince !== null,
      limited: limited(),
      inFlight,
      waiting: waiters.length,
      paused,
      safeMode,
      heldBytes: waiters.length ? waiters[0].bytes : 0,
      hiddenForMs: hiddenSince === null ? 0 : now() - hiddenSince
    };
  }

  if (hiddenSince !== null) armGraceTimer();

  return {
    /**
     * Wait until one item may start. Resolves with release(), which the caller
     * runs once the item's memory is gone (after its sink). Rejects with an
     * AbortError when `signal` aborts first.
     */
    admit({ bytes = 0, signal = null } = {}) {
      if (signal?.aborted) return Promise.reject(abortError());
      const need = Math.max(0, Number(bytes) || 0);
      if (!waiters.length && !holdReason(need)) return Promise.resolve(admitNow());
      return new Promise((resolve, reject) => {
        const waiter = { bytes: need, resolve, signal, onAbort: null };
        if (signal) {
          waiter.onAbort = () => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            reject(abortError());
            pump();
          };
          signal.addEventListener('abort', waiter.onAbort, { once: true });
        }
        waiters.push(waiter);
        pump();
      });
    },
    /** Forward every visibilitychange. */
    visibilityChanged() {
      const hidden = isHidden();
      if (hidden && hiddenSince === null) {
        hiddenSince = now();
        armGraceTimer();
      } else if (!hidden && hiddenSince !== null) {
        hiddenSince = null;
        if (graceTimer !== null) clearTimer(graceTimer);
        graceTimer = null;
      }
      pump();
    },
    /** Resident bytes dropped (memory shed): held items may fit now. */
    recheck() { pump(); },
    /** Crash-loop guard: one item in flight even while visible, hidden limits everywhere. */
    setSafeMode(enabled) {
      safeMode = Boolean(enabled);
      pump();
    },
    /** A job is running or waiting to start an item. */
    get busy() { return inFlight > 0 || waiters.length > 0; },
    get inFlight() { return inFlight; },
    get waiting() { return waiters.length; },
    get paused() { return paused; },
    get safeMode() { return safeMode; },
    /** Hidden and past the grace period (idle shedding is due). */
    get graceOver() { return graceOver(); },
    status,
    dispose() {
      if (graceTimer !== null) clearTimer(graceTimer);
      graceTimer = null;
    }
  };
}
