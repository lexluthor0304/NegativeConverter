/**
 * One renderer-wide memory budget (#258).
 *
 * Every full-resolution decode, batch lane and background frame asks here
 * before it allocates, and every consumer that keeps pixels (the open photo,
 * the photo caches, history, bounded stores, long-lived workers) is counted
 * by one ledger. The budget is sized from the machine's RAM and from WebKit's
 * kill limit, so the same rule holds in Chrome, WebView2, WKWebView and
 * WebKitGTK.
 *
 * - Foreground reservations (the photo being opened) are granted at once,
 *   even over budget, and evict nothing.
 * - User jobs (Export All, Auto Frame Selected, a manual Analyze Roll, ...)
 *   and background work (automatic roll analysis, tiles, prefetch) wait in
 *   one queue: user requests ahead of every background request, FIFO within
 *   a priority, and only the head can be granted, so a small request never
 *   overtakes a large one. The head is granted while no foreground
 *   reservation is outstanding and reserved + retained + bytes fits the
 *   budget; if it does not, `onPressure(shortfall)` may evict caches first.
 *   With nothing else of its kind outstanding the head is granted anyway (the
 *   progress rule), so the worst case is one item at a time, never a stall.
 *
 * Pure: no DOM, no workers; timers are injected. main.js supplies the ledger,
 * the eviction policy and the RAM source.
 */

import { backingBuffers } from './photoSessionCache.js';

export const GIB = 1024 ** 3;
// budget = min(RAM_FRACTION x RAM, WebKit's active kill limit - margin).
export const MEMORY_BUDGET_RAM_FRACTION = 0.45;
// WebKit: thresholdForMemoryKillOfActiveProcess with one page: 7 + 1 GiB, or
// 15 + 1 GiB above 16 GiB of RAM (MemoryPressureHandler.cpp; the UI-process
// MemoryFootprintMonitor on WebKit main keeps the same limits).
export const WEBKIT_ACTIVE_KILL_BYTES = 8 * GIB;
export const WEBKIT_ACTIVE_KILL_BYTES_LARGE_RAM = 16 * GIB;
export const WEBKIT_LARGE_RAM_BYTES = 16 * GIB;
// What the estimates miss: GC lag, WASM heaps, code and image caches.
export const KILL_LIMIT_MARGIN_BYTES = 2 * GIB;
// Safari, Firefox and Chrome before 147 report no navigator.deviceMemory.
export const UNKNOWN_RAM_BYTES = 8 * GIB;
// The low-memory plans (deviceMemory <= 4 on the web) apply to real RAM too.
export const LOW_MEMORY_RAM_BYTES = 4 * GIB;
// WebKit on macOS and Linux: Strict policy from half of min(3 GiB, RAM). Each
// 30 s tick under Strict throws away JIT code, decoded images and font caches.
export const WEBKIT_STRICT_THRESHOLD_BYTES = 1.5 * GIB;
// A decoded frame: the 8-bit RGBA plane and its 16-bit RGBA mirror.
export const DECODED_BYTES_PER_PIXEL = 12;
// Waiting requests are re-evaluated at least this often.
export const WAIT_RECHECK_MS = 1000;
// WebKit hosts: the idle check runs this long after the last release and input.
export const IDLE_CHECK_DELAY_MS = 10_000;
// Ledger bytes the idle check trims to; calibrate against logged footprints.
export const IDLE_RETAINED_TARGET_BYTES = 1 * GIB;
// localStorage key: RAM in GiB for benchmarks and the 2-lane parity run.
export const RAM_OVERRIDE_KEY = 'nc_memory_ram_gib_v1';

export const PRIORITIES = Object.freeze(['foreground', 'user', 'background']);

function positive(value) {
  return Number.isFinite(value) && value > 0;
}

/**
 * The budget for a machine with `ramBytes` of RAM (unknown: 8 GiB). One
 * formula for every engine: WebKit kills the WebContent process at its active
 * limit, and on Chromium the same cap keeps a 16 GB machine out of swap.
 *
 * @param {{ramBytes?: number|null, engine?: string}} [options]
 */
export function budgetFor({ ramBytes = null } = {}) {
  const ram = positive(ramBytes) ? ramBytes : UNKNOWN_RAM_BYTES;
  const kill = ram > WEBKIT_LARGE_RAM_BYTES ? WEBKIT_ACTIVE_KILL_BYTES_LARGE_RAM : WEBKIT_ACTIVE_KILL_BYTES;
  return Math.floor(Math.max(0, Math.min(MEMORY_BUDGET_RAM_FRACTION * ram, kill - KILL_LIMIT_MARGIN_BYTES)));
}

/**
 * Where the RAM figure comes from: the debug override, the desktop command
 * (`get_memory_info().totalBytes`), then `navigator.deviceMemory` (GiB,
 * Chrome 147+ reports up to 32 on desktop). `known` is false when none did.
 */
export function resolveMemoryRam({ overrideGib = null, desktopTotalBytes = null, deviceMemory = null } = {}) {
  const override = Number(overrideGib);
  if (overrideGib !== null && overrideGib !== undefined && overrideGib !== '' && positive(override)) {
    return { ramBytes: Math.round(override * GIB), source: 'override', known: true };
  }
  if (positive(desktopTotalBytes)) return { ramBytes: desktopTotalBytes, source: 'desktop', known: true };
  if (positive(deviceMemory)) return { ramBytes: Math.round(deviceMemory * GIB), source: 'deviceMemory', known: true };
  return { ramBytes: null, source: 'unknown', known: false };
}

/**
 * The page's engine: the desktop command's answer ('wkwebview', 'webkitgtk',
 * 'webview2'), else 'webkit' for a WebKit UA (inferenceBackend's test),
 * 'gecko' or 'chromium'.
 */
export function memoryEngine({ desktopEngine = null, userAgent = globalThis.navigator?.userAgent || '' } = {}) {
  if (typeof desktopEngine === 'string' && desktopEngine) return desktopEngine;
  if (/AppleWebKit/.test(userAgent) && !/(Chrome|Chromium|Edg|OPR)\//.test(userAgent)) return 'webkit';
  if (/Gecko\/\d/.test(userAgent) && /Firefox\//.test(userAgent)) return 'gecko';
  return 'chromium';
}

/** Engines whose WebContent process runs WebKit's 30 s memory monitor. */
export function hasPeriodicMemoryPurge(engine) {
  return engine === 'wkwebview' || engine === 'webkitgtk' || engine === 'webkit';
}

function abortError(signal) {
  const reason = signal?.reason;
  if (reason?.name === 'AbortError') return reason;
  if (typeof DOMException === 'function') return new DOMException('Memory reservation aborted', 'AbortError');
  const error = new Error('Memory reservation aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * @param {object} [options]
 * @param {number} [options.budgetBytes] the ceiling (budgetFor())
 * @param {() => number} [options.retainedBytes] the ledger's total
 * @param {(needBytes: number, request: {priority: string, label: string, bytes: number}) => number} [options.onPressure]
 *   synchronous; evicts toward `needBytes` and returns the bytes freed
 * @param {(fn: Function, ms: number) => any} [options.setTimer]
 * @param {(id: any) => void} [options.clearTimer]
 * @param {number} [options.recheckMs] fallback re-evaluation while a request waits
 * @param {(event: object) => void} [options.onEvent] grant/wait/release/abort/resize/pressure
 */
export function createMemoryBudget({
  budgetBytes = budgetFor(),
  retainedBytes = () => 0,
  onPressure = () => 0,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  recheckMs = WAIT_RECHECK_MS,
  onEvent = null
} = {}) {
  let budget = Math.max(0, Number(budgetBytes) || 0);
  const outstanding = new Set();
  const reserved = { foreground: 0, user: 0, background: 0 };
  let foregroundCount = 0;
  let jobCount = 0;
  // Waiting user and background requests: every user request ahead of every
  // background one, FIFO within a priority.
  const queue = [];
  let timer = null;
  let evaluating = false;
  let again = false;
  let grants = 0;

  const reservedTotal = () => reserved.foreground + reserved.user + reserved.background;
  const readRetained = () => {
    try { return Math.max(0, Number(retainedBytes()) || 0); } catch { return 0; }
  };
  const emit = (event) => {
    if (!onEvent) return;
    try { onEvent(event); } catch { /* logging never breaks admission */ }
  };

  function makeHandle(bytes, priority, label) {
    const handle = {
      bytes,
      priority,
      label,
      released: false,
      release() {
        if (handle.released) return;
        handle.released = true;
        outstanding.delete(handle);
        reserved[priority] -= handle.bytes;
        if (priority === 'foreground') foregroundCount -= 1;
        else jobCount -= 1;
        emit({ type: 'release', label, priority, bytes: handle.bytes, reserved: reservedTotal() });
        evaluate();
      },
      // The real size became known (a decode's metadata): never waits, like
      // an item already in flight; shrinking wakes the waiters.
      resize(next) {
        if (handle.released) return;
        const size = Math.max(0, Number(next) || 0);
        if (size === handle.bytes) return;
        const previous = handle.bytes;
        reserved[priority] += size - previous;
        handle.bytes = size;
        emit({ type: 'resize', label, priority, bytes: size, previous, reserved: reservedTotal() });
        if (size < previous) evaluate();
      }
    };
    return handle;
  }

  function grant(bytes, priority, label, rule) {
    const handle = makeHandle(bytes, priority, label);
    outstanding.add(handle);
    reserved[priority] += bytes;
    if (priority === 'foreground') foregroundCount += 1;
    else jobCount += 1;
    grants += 1;
    emit({ type: 'grant', label, priority, bytes, rule, reserved: reservedTotal(), retained: readRetained(), budget });
    return handle;
  }

  // null: the head waits; otherwise the rule it is granted under.
  function admission(head) {
    if (foregroundCount > 0) return null;
    const shortfall = () => reservedTotal() + readRetained() + head.bytes - budget;
    let need = shortfall();
    if (need <= 0) return 'fits';
    let freed = 0;
    try {
      freed = Math.max(0, Number(onPressure(need, { priority: head.priority, label: head.label, bytes: head.bytes })) || 0);
    } catch { freed = 0; }
    emit({ type: 'pressure', label: head.label, priority: head.priority, need, freed });
    need = shortfall();
    if (need <= 0) return 'pressure';
    return jobCount === 0 ? 'progress' : null;
  }

  function detach(entry) {
    entry.signal?.removeEventListener?.('abort', entry.onAbort);
  }

  function armTimer() {
    if (!queue.length) {
      if (timer !== null) clearTimer(timer);
      timer = null;
      return;
    }
    if (timer !== null) return;
    timer = setTimer(() => {
      timer = null;
      evaluate();
    }, recheckMs);
    if (timer && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
  }

  function evaluate() {
    // onPressure may poke, and a release may run from inside a grant's
    // continuation: evaluate once more afterwards instead of re-entering.
    if (evaluating) { again = true; return; }
    evaluating = true;
    try {
      do {
        again = false;
        while (queue.length) {
          const head = queue[0];
          const rule = admission(head);
          if (!rule) break;
          queue.shift();
          detach(head);
          head.resolve(grant(head.bytes, head.priority, head.label, rule));
        }
      } while (again);
    } finally {
      evaluating = false;
    }
    armTimer();
  }

  function enqueue(entry) {
    if (entry.priority === 'user') {
      let at = queue.findIndex(waiting => waiting.priority !== 'user');
      if (at < 0) at = queue.length;
      queue.splice(at, 0, entry);
    } else {
      queue.push(entry);
    }
  }

  return {
    /**
     * Resolves with a handle once `bytes` may be used; release() it once the
     * memory is really gone (after the sink, when the frame is dropped). A
     * foreground request is recorded synchronously and never waits. `signal`
     * rejects a waiting request with an AbortError; a granted handle is the
     * owner's to release.
     *
     * @param {number} bytes
     * @param {{priority?: 'foreground'|'user'|'background', signal?: AbortSignal|null, label?: string}} [options]
     */
    reserve(bytes, { priority = 'background', signal = null, label = '' } = {}) {
      if (!PRIORITIES.includes(priority)) return Promise.reject(new TypeError(`Unknown memory priority: ${priority}`));
      if (signal?.aborted) return Promise.reject(abortError(signal));
      const size = Math.max(0, Number(bytes) || 0);
      if (priority === 'foreground') return Promise.resolve(grant(size, priority, label, 'foreground'));
      return new Promise((resolve, reject) => {
        const entry = { bytes: size, priority, label, signal, resolve, onAbort: null };
        if (signal) {
          entry.onAbort = () => {
            const at = queue.indexOf(entry);
            if (at < 0) return;
            queue.splice(at, 1);
            emit({ type: 'abort', label, priority, bytes: size });
            reject(abortError(signal));
            evaluate();
          };
          signal.addEventListener('abort', entry.onAbort, { once: true });
        }
        enqueue(entry);
        evaluate();
        if (queue.includes(entry)) {
          emit({ type: 'wait', label, priority, bytes: size, reserved: reservedTotal(), budget, position: queue.indexOf(entry) });
        }
      });
    },
    /** A new ceiling (hidden window, RAM known): revokes nothing, re-evaluates waiters. */
    setBudget(bytes) {
      budget = Math.max(0, Number(bytes) || 0);
      evaluate();
    },
    /** Something let memory go (a cache shrank): re-evaluate waiters. */
    poke() { evaluate(); },
    snapshot() {
      return {
        budget,
        retained: readRetained(),
        reserved: reservedTotal(),
        foreground: reserved.foreground,
        user: reserved.user,
        background: reserved.background,
        grants,
        outstanding: [...outstanding].map(({ label, priority, bytes }) => ({ label, priority, bytes })),
        waiting: queue.map(({ label, priority, bytes }) => ({ label, priority, bytes }))
      };
    },
    get budget() { return budget; },
    /** Outstanding user and background reservations. */
    get jobs() { return jobCount; },
    get foregroundOutstanding() { return foregroundCount; },
    get waiting() { return queue.length; },
    get idle() { return outstanding.size === 0 && queue.length === 0; },
    dispose() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    }
  };
}

/**
 * Bytes every consumer retains, each ArrayBuffer counted once and attributed
 * to the first consumer (in the given order) that holds it: the active
 * editor, then the photo sessions, previews, history (only what nothing
 * above holds), bounded stores and worker residents.
 *
 * @param {() => Array<{name: string, roots?: () => any, buffers?: () => Iterable<ArrayBuffer>, bytes?: () => number}>} consumers
 *   `roots`: object graphs walked like the session cache's (planes with
 *   their __image16); `buffers`: ArrayBuffers already unique to that
 *   consumer; `bytes`: opaque resident bytes (worker heaps)
 */
export function createRetainedLedger(consumers) {
  const list = typeof consumers === 'function' ? consumers : () => consumers;
  function measure() {
    const seen = new Set();
    const breakdown = {};
    let total = 0;
    for (const consumer of list() || []) {
      let bytes = 0;
      const own = new Set();
      try {
        if (consumer.roots) backingBuffers(consumer.roots(), own);
        if (consumer.buffers) for (const buffer of consumer.buffers() || []) if (buffer) own.add(buffer);
      } catch { /* a consumer that cannot be read counts as empty */ }
      for (const buffer of own) {
        if (seen.has(buffer)) continue;
        seen.add(buffer);
        bytes += Number(buffer.byteLength) || 0;
      }
      if (consumer.bytes) {
        try { bytes += Math.max(0, Number(consumer.bytes()) || 0); } catch { /* opaque bytes unknown */ }
      }
      breakdown[consumer.name] = (breakdown[consumer.name] || 0) + bytes;
      total += bytes;
    }
    return { total, breakdown };
  }
  return {
    retained: () => measure().total,
    measure
  };
}

/**
 * Runs eviction steps in order until `needBytes` are freed. Each step gets
 * what is still missing and returns what it freed.
 */
export function relievePressure(needBytes, steps) {
  let freed = 0;
  for (const step of steps) {
    const remaining = needBytes - freed;
    if (remaining <= 0) break;
    let got = 0;
    try { got = Math.max(0, Number(step(remaining)) || 0); } catch { got = 0; }
    freed += got;
  }
  return freed;
}

/**
 * A memory claim for one piece of work, shared by the caller and the loader:
 * reserved up front from an estimate (`reserve(pixels)`), or at the loader
 * gate once the decode's real size is known (`atDecode`). A claim already
 * held is corrected to the real size there (never waiting); a `fixed` one
 * (an Export All lane, planned on the batch's largest frame) is left as it
 * is. Nothing decodes unreserved and nothing is counted twice.
 *
 * @param {ReturnType<typeof createMemoryBudget>} budget
 * @param {object} options
 * @param {'foreground'|'user'|'background'} [options.priority]
 * @param {AbortSignal|null} [options.signal]
 * @param {string} [options.label]
 * @param {(size: {pixels: number, decodeBytes: number|null, kind?: string, fromHeader?: boolean}) => number} options.bytesFor
 *   bytes for a frame of `pixels` whose decode peaks at `decodeBytes` (null
 *   when the loader did not say: a decode without LibRaw, or a header size)
 * @param {() => Promise<number>|number} [options.headerPixels] pixels from the
 *   file's header when a decode has no size of its own
 * @param {{release: () => void}|null} [options.handle] an existing reservation
 *   that already covers the work (`fixed`)
 */
export function createMemoryClaim(budget, {
  priority = 'user',
  signal = null,
  label = '',
  bytesFor,
  headerPixels = () => 0,
  handle: existing = null
} = {}) {
  if (typeof bytesFor !== 'function' && !existing) throw new TypeError('A memory claim needs bytesFor()');
  let handle = existing;
  const fixed = Boolean(existing);
  let pending = null;
  let released = false;
  // Releasing a claim that still waits withdraws its request too.
  const withdraw = new AbortController();
  const forward = () => withdraw.abort(signal.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener?.('abort', forward, { once: true });

  async function take(bytes) {
    if (handle || released) return handle;
    if (pending) return pending;
    pending = budget.reserve(bytes, { priority, signal: withdraw.signal, label }).then((granted) => {
      pending = null;
      if (released) { granted.release(); return null; }
      handle = granted;
      return granted;
    }, (error) => {
      pending = null;
      throw error;
    });
    return pending;
  }

  return {
    get held() { return Boolean(handle); },
    get fixed() { return fixed; },
    get priority() { return priority; },
    get bytes() { return handle ? handle.bytes : 0; },
    /** Reserve up front for a frame of about `pixels`. */
    reserve(pixels, decodeBytes = null) {
      if (fixed || handle) return Promise.resolve(handle);
      return take(bytesFor({ pixels: Math.max(0, Number(pixels) || 0), decodeBytes }));
    },
    /**
     * The loader gate: `kind` ('raw' for LibRaw, 'scan' for UTIF or the
     * browser), with `width`/`height`/`estimatedBytes` of a LibRaw decode, or
     * no size for a decode that has none before it runs (the header's size
     * is used then).
     */
    async atDecode({ kind = 'raw', width = 0, height = 0, estimatedBytes = null } = {}) {
      if (released || fixed) return;
      const pixels = Math.max(0, Number(width) || 0) * Math.max(0, Number(height) || 0);
      const decodeBytes = positive(estimatedBytes) ? estimatedBytes : null;
      if (handle) {
        if (pixels > 0) handle.resize?.(bytesFor({ pixels, decodeBytes, kind }));
        return;
      }
      if (pixels > 0) {
        await take(bytesFor({ pixels, decodeBytes, kind }));
        return;
      }
      const header = Math.max(0, Number(await headerPixels()) || 0);
      await take(bytesFor({ pixels: header, decodeBytes: null, kind, fromHeader: true }));
    },
    release() {
      if (released) return;
      released = true;
      signal?.removeEventListener?.('abort', forward);
      if (pending) withdraw.abort(new DOMException('Memory claim released', 'AbortError'));
      if (!fixed) handle?.release();
      handle = null;
    }
  };
}

/**
 * The idle check's clock (WebKit hosts): `onIdle` runs `delayMs` after the
 * last `note()` (a release, pointer, key or wheel input) while `canRun()`
 * holds; a check that finds work outstanding re-arms itself.
 */
export function createIdleCheck({
  delayMs = IDLE_CHECK_DELAY_MS,
  onIdle,
  canRun = () => true,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id)
} = {}) {
  if (typeof onIdle !== 'function') throw new TypeError('createIdleCheck needs onIdle()');
  let timer = null;
  let enabled = true;
  function arm() {
    if (!enabled) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(fire, delayMs);
    if (timer && typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
  }
  function fire() {
    timer = null;
    let ready = false;
    try { ready = Boolean(canRun()); } catch { ready = false; }
    if (!ready) { arm(); return; }
    try { onIdle(); } catch { /* the next activity re-arms */ }
  }
  return {
    note() { arm(); },
    setEnabled(next) {
      enabled = Boolean(next);
      if (!enabled && timer !== null) { clearTimer(timer); timer = null; }
    },
    get armed() { return timer !== null; },
    dispose() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    }
  };
}
