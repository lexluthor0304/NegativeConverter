// Input pacing on an absolute schedule: step i fires at t0 + i × period, so a
// late step never pushes the later ones back (no drift). The last millisecond
// before a deadline is spun rather than slept because Node timers overshoot.

export const HZ_60_MS = 1000 / 60;

export function scheduleTimes(count, startMs, periodMs = HZ_60_MS) {
  return Array.from({ length: count }, (_, i) => startMs + i * periodMs);
}

/** Positions along a straight line, one per step (step 1 … count). */
export function linearPath({ x0, y0, x1, y1, count }) {
  return Array.from({ length: count }, (_, i) => {
    const f = (i + 1) / count;
    return { x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f };
  });
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Run `fire(i, scheduledMs)` for i in [0, count) on the absolute schedule.
 * `fire` is not awaited, so a slow reply from the page cannot delay the
 * next input. Returns the actual fire times and the pending results.
 */
export async function runPaced(count, fire, {
  periodMs = HZ_60_MS,
  now = () => performance.now(),
  sleep = defaultSleep,
  spinMs = 1.5,
  signal = null
} = {}) {
  const start = now();
  const firedAt = [];
  const pending = [];
  for (let i = 0; i < count; i++) {
    if (signal?.aborted) break;
    const due = start + i * periodMs;
    let remaining = due - now();
    if (remaining > spinMs) await sleep(remaining - spinMs);
    while (now() < due) { remaining = due - now(); if (remaining > spinMs) await sleep(remaining - spinMs); }
    firedAt.push(now());
    // Fired synchronously (the CDP message leaves now) but never awaited here.
    let result;
    try { result = fire(i, due); } catch (error) { result = Promise.reject(error); }
    pending.push(Promise.resolve(result));
  }
  const results = await Promise.allSettled(pending);
  return { start, firedAt, results, lateness: firedAt.map((t, i) => t - (start + i * periodMs)) };
}
