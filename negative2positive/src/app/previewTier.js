// Interactive preview tier (#263).
//
// The display preview is sized from geometry (viewport x DPR x zoom, up to
// 4 MP). Where compositing or GL runs in software, every redraw of that canvas
// is read back and composited on the CPU, so a drag pays for up to 4 MP per
// frame. Inside an interaction session (a slider or curve drag) the preview can
// drop to a reduced tier of about 1 MP; the session end always restores the
// normal tier, and the settled frame comes from the normal-size path.
//
// This module holds the policy and the frame sampler; main.js owns the images.

export const PREVIEW_TIER_NORMAL_MAX_PIXELS = 4_000_000;
// Tune on the Linux host. At DPR 1 and fit-to-view a 1920x1080 window already
// shows about 0.9 MP, where this tier removes nothing; try 0.5 MP there first.
export const PREVIEW_TIER_REDUCED_MAX_PIXELS = 1_000_000;
// A session drops once the median frame interval exceeds both of these.
export const PREVIEW_TIER_SLOW_FRAME_MS = 24;
// Relative to the idle rAF interval, so a host whose rAF is capped at 30 Hz
// (Low Power Mode, Energy Saver, some Linux compositors) does not read as slow.
export const PREVIEW_TIER_IDLE_RATIO = 1.3;
export const PREVIEW_TIER_MIN_INTERVALS = 10;
// The median covers the most recent intervals, so a drag that turns slow
// halfway through is not outvoted by its fast start.
export const PREVIEW_TIER_WINDOW = 30;
// A session with no input for this long ends on its own (a lost pointerup).
export const PREVIEW_TIER_WATCHDOG_MS = 1000;
// Two dropped sessions in a row start the following ones reduced; every 10th
// of those re-probes at the normal tier.
export const PREVIEW_TIER_DROP_STREAK = 2;
export const PREVIEW_TIER_REPROBE_EVERY = 10;
const DEFAULT_FRAME_MS = 1000 / 60;
const IDLE_PROBE_FRAMES = 12;
const MAX_SESSION_INTERVALS = 4000;

export function previewTierMaxPixels(tier) {
  return tier === 'reduced' ? PREVIEW_TIER_REDUCED_MAX_PIXELS : PREVIEW_TIER_NORMAL_MAX_PIXELS;
}

// Scales a drawing-buffer size down to `maxPixels`, keeping the aspect ratio.
// A size within the limit is returned unchanged.
export function capBackingSize(width, height, maxPixels) {
  if (!(width > 0) || !(height > 0) || width * height <= maxPixels) return { width, height };
  const scale = Math.sqrt(maxPixels / (width * height));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

// ?previewTier=reduced forces every session into the reduced tier;
// ?previewTier=normal keeps every session normal. Tests and field checks only.
export function parsePreviewTierOverride(search) {
  let value = null;
  try {
    value = new URLSearchParams(search || '').get('previewTier');
  } catch {
    value = null;
  }
  return value === 'reduced' || value === 'normal' ? value : null;
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function frameIntervalStats(intervals) {
  const sorted = [...intervals].sort((a, b) => a - b);
  return { count: sorted.length, p50: median(sorted), p95: percentile(sorted, 0.95) };
}

// True when the recent frame intervals are slow in absolute terms and for this
// host. `intervals` must already exclude the first interval of the session.
export function isSlowFrameSample(intervals, idleInterval, {
  thresholdMs = PREVIEW_TIER_SLOW_FRAME_MS,
  idleRatio = PREVIEW_TIER_IDLE_RATIO,
  minIntervals = PREVIEW_TIER_MIN_INTERVALS,
  window = PREVIEW_TIER_WINDOW
} = {}) {
  if (!Array.isArray(intervals) || intervals.length < minIntervals) return false;
  const recent = intervals.length > window ? intervals.slice(-window) : intervals;
  const value = median(recent);
  const idle = Number.isFinite(idleInterval) && idleInterval > 0 ? idleInterval : DEFAULT_FRAME_MS;
  return value > thresholdMs && value > idleRatio * idle;
}

export function createPreviewTierController({
  requestFrame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null,
  cancelFrame = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  isHidden = () => false,
  force = null,
  onChange = () => {},
  onSessionEnd = () => {},
  measureBacking = () => null
} = {}) {
  let tier = 'normal';
  let session = null;
  let environmentReason = null;
  let idleInterval = null;
  let dropStreak = 0;
  let memoryStarts = 0;
  let idleProbe = null;
  let lastSummary = null;

  function setTier(next, reason) {
    if (tier === next) return;
    tier = next;
    onChange(next, reason);
  }

  // The tier the next session starts in, and why. No side effects.
  function nextStart() {
    if (force === 'reduced') return { tier: 'reduced', reason: 'forced' };
    if (force === 'normal') return { tier: 'normal', reason: 'forced' };
    if (environmentReason) return { tier: 'reduced', reason: environmentReason };
    if (dropStreak >= PREVIEW_TIER_DROP_STREAK) {
      return memoryStarts < PREVIEW_TIER_REPROBE_EVERY - 1
        ? { tier: 'reduced', reason: 'slow-sessions' }
        : { tier: 'normal', reason: 'reprobe' };
    }
    return { tier: 'normal', reason: null };
  }

  function noteBacking() {
    if (!session) return;
    const backing = measureBacking();
    if (!backing || !(backing.width > 0) || !(backing.height > 0)) return;
    session.backing = backing;
    if (!session.maxBacking || backing.width * backing.height > session.maxBacking.width * session.maxBacking.height) {
      session.maxBacking = backing;
    }
  }

  function frame(time) {
    if (!session) return;
    session.frame = 0;
    const stamp = Number.isFinite(time) ? time : now();
    if (isHidden()) {
      // A hidden page paints nothing; the gap after it is no frame time.
      session.lastTime = null;
    } else {
      if (session.lastTime !== null) {
        const interval = stamp - session.lastTime;
        // The first interval holds the pointerdown work (undo snapshot and
        // the like), not a frame of the drag.
        if (!session.firstDropped) session.firstDropped = true;
        else if (session.intervals.length < MAX_SESSION_INTERVALS) session.intervals.push(interval);
      }
      session.lastTime = stamp;
      noteBacking();
      if (tier === 'normal' && force !== 'normal' && isSlowFrameSample(session.intervals, idleInterval)) {
        session.trigger = 'slow-frames';
        setTier('reduced', 'slow-frames');
      }
    }
    if (session && requestFrame) session.frame = requestFrame(frame);
  }

  function armWatchdog() {
    if (!session) return;
    if (session.watchdog) clearTimer(session.watchdog);
    session.watchdog = setTimer(() => {
      if (session) session.watchdog = null;
      end('watchdog');
    }, PREVIEW_TIER_WATCHDOG_MS);
  }

  function begin(kind = 'slider') {
    if (session) {
      armWatchdog();
      return tier;
    }
    abortIdleProbe();
    const start = nextStart();
    session = {
      kind, startTier: start.tier, startReason: start.reason, trigger: start.tier === 'reduced' ? start.reason : null,
      probe: start.reason === 'reprobe',
      startedAt: now(), intervals: [], lastTime: null, firstDropped: false,
      frame: 0, watchdog: null, backing: null, maxBacking: null
    };
    if (start.reason === 'slow-sessions') memoryStarts += 1;
    if (requestFrame) session.frame = requestFrame(frame);
    armWatchdog();
    if (start.tier === 'reduced') setTier('reduced', start.reason);
    noteBacking();
    return tier;
  }

  function touch() {
    if (session) armWatchdog();
  }

  // Ends the open session (of `kind`, when given). Returns its summary.
  function end(endReason = 'end', kind = null) {
    if (!session || (kind && session.kind !== kind)) return null;
    const closing = session;
    session = null;
    if (closing.frame) cancelFrame(closing.frame);
    if (closing.watchdog) clearTimer(closing.watchdog);
    const stats = frameIntervalStats(closing.intervals);
    const reduced = tier === 'reduced';
    const conclusive = stats.count >= PREVIEW_TIER_MIN_INTERVALS;
    if (closing.startTier === 'normal' && force === null && !environmentReason) {
      if (closing.trigger === 'slow-frames') dropStreak += 1;
      else if (conclusive) dropStreak = 0;
      // A conclusive re-probe starts the count of reduced sessions over,
      // whichever way it went.
      if (closing.probe && (conclusive || closing.trigger === 'slow-frames')) memoryStarts = 0;
    }
    lastSummary = {
      kind: closing.kind, reduced, startTier: closing.startTier, startReason: closing.startReason,
      trigger: closing.trigger, endReason, intervals: stats.count, p50: stats.p50, p95: stats.p95,
      idleInterval: idleInterval ?? DEFAULT_FRAME_MS,
      // The drawing buffer at the end of the session, and the largest one.
      backing: closing.backing, maxBacking: closing.maxBacking,
      durationMs: now() - closing.startedAt
    };
    setTier('normal', endReason);
    onSessionEnd(lastSummary);
    return lastSummary;
  }

  function abortIdleProbe() {
    if (!idleProbe) return;
    if (idleProbe.frame) cancelFrame(idleProbe.frame);
    idleProbe = null;
  }

  // The rAF interval of this host while nothing happens: after load and after
  // each visibility change. A session starting meanwhile discards the probe.
  function measureIdleInterval() {
    abortIdleProbe();
    if (!requestFrame || session || isHidden()) return false;
    const probe = { frame: 0, last: null, intervals: [], skipped: false };
    idleProbe = probe;
    const step = (time) => {
      if (idleProbe !== probe) return;
      probe.frame = 0;
      if (session || isHidden()) { idleProbe = null; return; }
      const stamp = Number.isFinite(time) ? time : now();
      if (probe.last !== null) {
        if (!probe.skipped) probe.skipped = true;
        else probe.intervals.push(stamp - probe.last);
      }
      probe.last = stamp;
      if (probe.intervals.length >= IDLE_PROBE_FRAMES - 2) {
        idleInterval = median(probe.intervals);
        idleProbe = null;
        return;
      }
      probe.frame = requestFrame(step);
    };
    probe.frame = requestFrame(step);
    return true;
  }

  // Frame times restart after the page was hidden.
  function resetFrameClock() {
    if (!session) return;
    session.lastTime = null;
    session.firstDropped = false;
  }

  function setEnvironment(reason) {
    environmentReason = reason || null;
  }

  return {
    begin, touch, end, measureIdleInterval, resetFrameClock, setEnvironment, nextStart,
    get tier() { return tier; },
    get active() { return Boolean(session); },
    get sessionKind() { return session ? session.kind : null; },
    get idleInterval() { return idleInterval; },
    get lastSummary() { return lastSummary; },
    get force() { return force; }
  };
}
