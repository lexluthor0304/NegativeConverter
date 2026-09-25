/**
 * When background photo work may start (#243).
 *
 * Roll analysis, lane tiles and the prefetch of the next photo each decode a
 * whole frame. Started during a photo switch or a slider drag, that decode and
 * the main-thread work around it land in the middle of the interaction. Every
 * background job therefore awaits `idle()` before its decode, and before each
 * later main-thread-heavy step with a cap, so a job paused mid-way does not
 * hold a decoded frame through a whole foreground decode.
 *
 * `idle()` resolves once the host's `isBusy()` is false (a switch, a
 * conversion, a full-resolution render or an export) and no input was noted
 * for `quietMs`. Input is fed by `noteInput()` (passive capture listeners in
 * the host), busy flags that clear call `bump()`, and a slow poll covers any
 * flag that does not. It only decides when work starts: it cannot split a
 * synchronous task, and it uses plain timers because WKWebView and WebKitGTK
 * have no `scheduler.postTask`. A hidden window is not busy here; admission
 * while hidden is hiddenJobGate's (#241).
 *
 * Pure: the clock and timers are injected.
 */

export const BACKGROUND_INPUT_QUIET_MS = 400;
export const BACKGROUND_BUSY_POLL_MS = 250;
export const BACKGROUND_STEP_WAIT_CAP_MS = 2000;

function abortError(signal) {
  const reason = signal?.reason;
  return reason?.name === 'AbortError' ? reason : new DOMException('Background job was cancelled', 'AbortError');
}

/**
 * @param {object} [options]
 * @param {() => boolean} [options.isBusy] the foreground is switching, converting or exporting
 * @param {() => number} [options.now] milliseconds, monotonic
 * @param {(fn: Function, ms: number) => any} [options.setTimer]
 * @param {(handle: any) => void} [options.clearTimer]
 * @param {number} [options.quietMs] input quiet period
 * @param {number} [options.pollMs] re-check interval while busy
 */
export function createBackgroundGate({
  isBusy = () => false,
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  quietMs = BACKGROUND_INPUT_QUIET_MS,
  pollMs = BACKGROUND_BUSY_POLL_MS
} = {}) {
  let lastInput = -Infinity;
  let timer = null;
  let timerAt = Infinity;
  const waiters = new Set();

  // 0 when idle, otherwise how long until it is worth looking again.
  function blockedFor() {
    const since = now() - lastInput;
    if (since < quietMs) return quietMs - since;
    let busy = false;
    try { busy = Boolean(isBusy()); } catch { busy = true; }
    return busy ? pollMs : 0;
  }

  function settle(waiter, value) {
    waiters.delete(waiter);
    waiter.signal?.removeEventListener?.('abort', waiter.onAbort);
    waiter.resolve(value);
  }

  function arm(delay) {
    const at = now() + Math.max(0, delay);
    if (timer !== null && timerAt <= at) return;
    if (timer !== null) clearTimer(timer);
    timerAt = at;
    timer = setTimer(() => {
      timer = null;
      timerAt = Infinity;
      check();
    }, Math.max(0, delay));
  }

  function check() {
    if (!waiters.size) return;
    const wait = blockedFor();
    const t = now();
    let next = wait;
    for (const waiter of [...waiters]) {
      if (wait === 0) settle(waiter, true);
      else if (waiter.deadline <= t) settle(waiter, false);
      else next = Math.min(next, waiter.deadline - t);
    }
    if (waiters.size) arm(next);
  }

  return {
    /**
     * Resolves true once idle, or false when `maxWaitMs` passed first (the
     * caller proceeds anyway). Rejects with an AbortError on `signal`.
     */
    idle({ signal = null, maxWaitMs = Infinity } = {}) {
      if (signal?.aborted) return Promise.reject(abortError(signal));
      if (blockedFor() === 0) return Promise.resolve(true);
      return new Promise((resolve, reject) => {
        const waiter = { resolve, signal, deadline: now() + Math.max(0, maxWaitMs) };
        waiter.onAbort = () => {
          if (!waiters.delete(waiter)) return;
          reject(abortError(signal));
        };
        signal?.addEventListener?.('abort', waiter.onAbort, { once: true });
        waiters.add(waiter);
        check();
      });
    },
    /** Pointer, wheel, key or slider input happened now. */
    noteInput() {
      lastInput = now();
      if (waiters.size) arm(quietMs);
    },
    /** A busy flag cleared: re-check the waiters now instead of at the next poll. */
    bump() {
      if (!waiters.size) return;
      if (timer !== null) { clearTimer(timer); timer = null; timerAt = Infinity; }
      check();
    },
    isIdle: () => blockedFor() === 0,
    get lastInputAt() { return lastInput; },
    get waiting() { return waiters.size; }
  };
}
