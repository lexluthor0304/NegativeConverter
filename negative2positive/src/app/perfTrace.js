// Stage timings for long operations (import, conversion, export, roll work).
//
// ?debug=1 keeps the old behaviour: a finished trace of 120 ms or more is
// logged with console.info. ?perf=1 (set by the benchmark harness, see
// docs/performance-benchmark.md) also turns every trace into User Timing
// entries at every duration: a mark per stage and one measure per trace, each
// with `detail`. Traces, PerformanceObserver and Safari's Web Inspector can
// see those; console output cannot be measured. With neither flag nothing is
// recorded, so the unbounded User Timing buffer never grows in normal use.

export const PERF_LOG_THRESHOLD_MS = 120;
export const PERF_ENTRY_PREFIX = 'nc:';

export function readPerfFlags(search = '') {
  const params = new URLSearchParams(search);
  return { debug: params.get('debug') === '1', userTiming: params.get('perf') === '1' };
}

function round1(ms) {
  return Math.round(ms * 10) / 10;
}

export function createPerfTraceFactory({
  debug = false,
  userTiming = false,
  performance: perf = globalThis.performance,
  log = (...args) => console.info(...args),
  thresholdMs = PERF_LOG_THRESHOLD_MS
} = {}) {
  const now = () => (perf && typeof perf.now === 'function' ? perf.now() : Date.now());
  const timing = Boolean(userTiming && perf && typeof perf.mark === 'function' && typeof perf.measure === 'function');
  let sequence = 0;

  // `detail` is structured-cloned; a value that cannot be cloned must not
  // break the operation being measured, so fall back to an entry without it.
  function mark(name, startTime, detail) {
    try { perf.mark(name, { startTime, detail }); } catch {
      try { perf.mark(name, { startTime }); } catch { /* measurement only */ }
    }
  }
  function measure(name, start, end, detail) {
    try { perf.measure(name, { start, end, detail }); } catch {
      try { perf.measure(name, { start, end }); } catch { /* measurement only */ }
    }
  }

  function createPerfTrace(label, details = {}) {
    const startedAt = now();
    let lastAt = startedAt;
    const stages = [];
    const id = ++sequence;
    if (timing) mark(`${PERF_ENTRY_PREFIX}${label}:start`, startedAt, { label, id, ...details });

    return {
      mark(stage, extra = {}) {
        const at = now();
        stages.push({
          stage,
          ms: round1(at - lastAt),
          totalMs: round1(at - startedAt),
          ...extra
        });
        if (timing) mark(`${PERF_ENTRY_PREFIX}${label}:${stage}`, at, { label, id, stage, ms: round1(at - lastAt), ...extra });
        lastAt = at;
      },
      end(extra = {}) {
        const at = now();
        const totalMs = round1(at - startedAt);
        if (timing) measure(`${PERF_ENTRY_PREFIX}${label}`, startedAt, at, { label, id, totalMs, ...details, ...extra, stages });
        if (debug && totalMs >= thresholdMs) {
          log('[perf]', label, { totalMs, ...details, ...extra, stages });
        }
      }
    };
  }

  // Durations measured elsewhere (a worker's own stage clock) that end now,
  // such as the auto-frame analyser's `stageMs`.
  function recordStages(label, stageMs, details = {}) {
    if (!stageMs || typeof stageMs !== 'object') return;
    if (timing) {
      const end = now();
      const totalMs = Object.values(stageMs).reduce((sum, ms) => sum + (Number.isFinite(ms) ? ms : 0), 0);
      measure(`${PERF_ENTRY_PREFIX}${label}`, Math.max(0, end - totalMs), end, { label, totalMs: round1(totalMs), ...details, ...stageMs });
    }
    if (debug) log('[perf]', label, { ...details, ...stageMs });
  }

  return { createPerfTrace, recordStages };
}
