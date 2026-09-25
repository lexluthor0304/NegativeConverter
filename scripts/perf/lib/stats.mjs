// Small, dependency-free statistics for the benchmark harness. Every summary
// the reports print goes through here, so the definitions live in one place:
// quantiles interpolate linearly between closest ranks (numpy's default), and
// a summary over repetitions is the median with its (min–max) range.

export function finite(values) {
  return (values || []).filter(value => typeof value === 'number' && Number.isFinite(value));
}

export function sorted(values) {
  return finite(values).sort((a, b) => a - b);
}

/** q in [0, 1]; null for an empty list. */
export function quantile(values, q) {
  const list = sorted(values);
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const position = Math.min(1, Math.max(0, q)) * (list.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return list[lower] + (list[upper] - list[lower]) * (position - lower);
}

export const median = values => quantile(values, 0.5);
export const p95 = values => quantile(values, 0.95);

export function mean(values) {
  const list = finite(values);
  return list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null;
}

export function sum(values) {
  return finite(values).reduce((total, value) => total + value, 0);
}

export function max(values) {
  const list = finite(values);
  return list.length ? Math.max(...list) : null;
}

export function min(values) {
  const list = finite(values);
  return list.length ? Math.min(...list) : null;
}

/** Latency-style summary of one sample set (a single drag, for example). */
export function distribution(values) {
  const list = finite(values);
  return { n: list.length, p50: median(list), p95: p95(list), max: max(list) };
}

/**
 * Summary over repetitions: median with (min–max). Strings (hashes, routes)
 * summarise to the common value, or to `mixed` with the distinct values.
 */
export function summarize(values) {
  const present = (values || []).filter(value => value !== null && value !== undefined);
  if (present.length && present.every(value => typeof value === 'string' || typeof value === 'boolean')) {
    const distinct = [...new Set(present.map(String))];
    return distinct.length === 1
      ? { value: present[0], n: present.length }
      : { value: 'mixed', distinct, n: present.length };
  }
  const list = finite(present);
  if (!list.length) return { median: null, min: null, max: null, n: 0, values: [] };
  return { median: median(list), min: min(list), max: max(list), n: list.length, values: list };
}

/** Closed ranges [aMin, aMax] and [bMin, bMax] share at least one point. */
export function rangesOverlap(a, b) {
  if (!a || !b) return true;
  const aMin = a.min ?? a.median, aMax = a.max ?? a.median;
  const bMin = b.min ?? b.median, bMax = b.max ?? b.median;
  if (![aMin, aMax, bMin, bMax].every(Number.isFinite)) return true;
  return aMin <= bMax && bMin <= aMax;
}

/**
 * Collect per-repetition metric maps ({ key: value }) into summaries per key.
 * Keys missing from some repetitions summarise over the ones that have them.
 */
export function summarizeRepetitions(repetitions) {
  const keys = new Set();
  for (const rep of repetitions) for (const key of Object.keys(rep || {})) keys.add(key);
  const out = {};
  for (const key of [...keys].sort()) out[key] = summarize(repetitions.map(rep => rep?.[key]));
  return out;
}

export function round(value, digits = 1) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** "12.3 (10.1–14.0)" for a summary; "–" when empty. */
export function formatSummary(summary, digits = 1) {
  if (!summary) return '–';
  if ('value' in summary) return summary.value === 'mixed' ? `mixed (${summary.distinct.join(', ')})` : String(summary.value);
  if (summary.median === null || summary.median === undefined) return '–';
  const m = round(summary.median, digits);
  if (summary.n <= 1 || (summary.min === summary.max)) return String(m);
  return `${m} (${round(summary.min, digits)}–${round(summary.max, digits)})`;
}
