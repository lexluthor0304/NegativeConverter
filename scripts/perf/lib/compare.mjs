// Budget and compare logic: pure functions over metric summaries, so the
// status rules that decide the exit code are unit-tested without a browser.
//
// Status per metric (see docs/performance-benchmark.md):
//   pass          target met after (or tracked metric within noise)
//   open          target not met after, and not a regression beyond noise
//   improved      better beyond tolerance, min–max ranges do not overlap
//   regressed     worse beyond tolerance, ranges do not overlap   -> exit 1
//   broke-budget  met the target before, misses it after by more than noise -> exit 1
// String metrics: `identical` / `differs` (export pixel hashes fail the run
// unless a pixel change is allowed; a conversion route change is flagged).

import { rangesOverlap, formatSummary, round } from './stats.mjs';

export const DEFAULT_TOLERANCE = Object.freeze({ rel: 0.10, abs: 0 });
export const FAILING_STATUSES = new Set(['regressed', 'broke-budget', 'pixels-changed', 'missing-after', 'scenario-failed', 'recipe-changed']);

function segmentsMatch(pattern, key) {
  const a = pattern.split('.');
  const b = key.split('.');
  if (a.length !== b.length) return false;
  return a.every((part, i) => part === '*' || part === b[i]);
}

/** Summary keys may carry the fixture: `s2.cyan.dpr2.updatesPerSecond@synthetic-60mp.dng`. */
export function baseKey(key) {
  const at = key.indexOf('@');
  return at < 0 ? key : key.slice(0, at);
}

/** Exact key first, then the most specific wildcard pattern (fewest `*`). */
export function findMetricDef(budgets, fullKey) {
  const key = baseKey(fullKey);
  const metrics = budgets?.metrics || {};
  if (metrics[key]) return { key, ...metrics[key] };
  let best = null;
  for (const [pattern, def] of Object.entries(metrics)) {
    if (!pattern.includes('*') || !segmentsMatch(pattern, key)) continue;
    const stars = pattern.split('.').filter(part => part === '*').length;
    if (!best || stars < best.stars) best = { stars, def: { key: pattern, ...def } };
  }
  return best ? best.def : null;
}

export function meetsTarget(def, value) {
  if (!def || def.target === undefined || def.target === null || !Number.isFinite(value)) return null;
  if (def.better === 'higher') return value >= def.target;
  if (def.better === 'lower') return value <= def.target;
  return null;
}

export function toleranceFor(def, reference) {
  const tolerance = { ...DEFAULT_TOLERANCE, ...(def?.tolerance || {}) };
  return Math.max(Math.abs(reference || 0) * (tolerance.rel || 0), tolerance.abs || 0);
}

function isStringSummary(summary) {
  return summary && 'value' in summary;
}

export function isPixelHashKey(key) {
  return /Sha256$/.test(baseKey(key));
}

export function isRouteKey(key) {
  const base = baseKey(key);
  return /(^|\.)route(s)?(\.|$)/.test(base) || /\.filmType$/.test(base);
}

function recipeValue(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch {} }
  const canonical = item => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return JSON.stringify(canonical(value));
}

/** One row of the compare table. */
export function compareMetric(key, def, before, after) {
  const row = { key, def, before, after, deltaPct: null, status: 'pass', note: '' };
  if (!before || !after) {
    row.status = before && !/\.status(?:@|$)/.test(key) ? 'missing-after' : 'missing';
    row.note = before ? 'not measured after' : 'not measured before';
    return row;
  }
  if (isStringSummary(before) || isStringSummary(after)) {
    const same = isStringSummary(before) && isStringSummary(after)
      && before.value === after.value && before.value !== 'mixed';
    if (/\.status(?:@|$)/.test(key)) row.status = after.value === 'ok' ? 'pass' : 'scenario-failed';
    else if (/\.(rotationAngle|mirrored|cropRegion)(?:@|$)/.test(key)) row.status = isStringSummary(before) && isStringSummary(after)
      && before.value !== 'mixed' && recipeValue(before.value) === recipeValue(after.value) ? 'identical' : 'recipe-changed';
    else if (isPixelHashKey(key)) row.status = same ? 'identical' : 'pixels-changed';
    else if (isRouteKey(key)) row.status = same ? 'identical' : 'route-changed';
    else row.status = same ? 'identical' : 'differs';
    return row;
  }
  const b = before.median, a = after.median;
  if (!Number.isFinite(b) || !Number.isFinite(a)) {
    row.status = Number.isFinite(b) && !Number.isFinite(a) ? 'missing-after' : 'missing';
    row.note = 'no numeric value';
    return row;
  }
  const delta = a - b;
  row.deltaPct = b === 0 ? (a === 0 ? 0 : null) : (delta / Math.abs(b)) * 100;
  const allowed = toleranceFor(def, b);
  const direction = def?.better;
  const worse = direction === 'lower' ? delta > allowed : direction === 'higher' ? -delta > allowed : false;
  const better = direction === 'lower' ? -delta > allowed : direction === 'higher' ? delta > allowed : false;
  const overlap = rangesOverlap(before, after);
  const metBefore = meetsTarget(def, b);
  const metAfter = meetsTarget(def, a);
  if (metBefore === true && metAfter === false) {
    if (worse) row.status = 'broke-budget';
    else { row.status = 'open'; row.note = 'target missed within noise'; }
  } else if (worse && !overlap) {
    row.status = 'regressed';
  } else if (better && !overlap) {
    row.status = 'improved';
  } else if (metAfter === null) {
    row.status = 'pass';
    if (worse || better) row.note = 'change within overlapping ranges';
  } else {
    row.status = metAfter ? 'pass' : 'open';
  }
  return row;
}

/**
 * Compare two runs' metric summaries ({ key: summary }).
 * Returns rows sorted by key plus the process exit code.
 */
export function compareRuns({ budgets, before, after, allowPixelChange = false }) {
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].sort();
  const rows = keys.map(key => compareMetric(key, findMetricDef(budgets, key), before?.[key], after?.[key]));
  // Scenario failures on a newly added scenario fail even without a base.
  for (const row of rows) if (/\.status(?:@|$)/.test(row.key) && row.after?.value && row.after.value !== 'ok') row.status = 'scenario-failed';
  const recipes = rows.filter(row => row.status === 'recipe-changed');
  for (const row of rows) {
    if (!isPixelHashKey(row.key)) continue;
    const prefix = baseKey(row.key).replace(/\.(entry\d+\.)?[^.]*Sha256$/, '');
    if (recipes.some(recipe => baseKey(recipe.key).startsWith(`${prefix}.`) && recipe.key.split('@')[1] === row.key.split('@')[1])) {
      row.status = 'recipe-mismatch'; row.note = 'recipe differs; pixel comparison is inconclusive';
    }
  }
  rows.sort((a, b) => Number(/Sha256/.test(a.key)) - Number(/Sha256/.test(b.key)) || a.key.localeCompare(b.key));
  const failing = rows.filter(row => FAILING_STATUSES.has(row.status)
    && !(allowPixelChange && row.status === 'pixels-changed'));
  return {
    rows,
    failing,
    exitCode: failing.length ? 1 : 0,
    routeChanges: rows.filter(row => row.status === 'route-changed'),
    pixelChanges: rows.filter(row => row.status === 'pixels-changed'),
    pixelsIdentical: rows.some(row => isPixelHashKey(row.key))
      ? rows.filter(row => isPixelHashKey(row.key)).every(row => row.status === 'identical')
      : null
  };
}

export function formatTarget(def) {
  if (!def || def.target === undefined || def.target === null) return 'tracked';
  const unit = def.unit ? ` ${def.unit}` : '';
  return `${def.better === 'higher' ? '≥' : '≤'} ${def.target}${unit}`;
}

function formatDelta(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '–';
  const value = round(pct, 1);
  return `${value > 0 ? '+' : ''}${value} %`;
}

/** Markdown table for PR descriptions. */
export function renderCompareMarkdown(result, { baseLabel = 'before', headLabel = 'after', title = null } = {}) {
  const lines = [];
  if (title) lines.push(`### ${title}`, '');
  if (result.scope?.type === 'probe/control') {
    lines.push(`Probe/control comparison: intended common scenarios ${result.scope.scenarios.join(', ') || 'none'}, DPR ${result.scope.dprs.join(', ') || 'none'}; control.* metrics and scenario statuses only.`, '');
  }
  if (result.scopeError) lines.push(`Comparison refused: ${result.scopeError}.`, '');
  lines.push(`| metric | target | ${baseLabel} median (min–max) | ${headLabel} median (min–max) | Δ % | status | export pixels |`);
  lines.push('|---|---|---|---|---|---|---|');
  for (const row of result.rows) {
    const pixels = isPixelHashKey(row.key) ? (row.status === 'identical' ? 'identical'
      : row.status === 'pixels-changed' ? 'differ' : 'inconclusive') : '–';
    const status = row.note ? `${row.status} (${row.note})` : row.status;
    const shorten = summary => {
      if (!summary) return '–';
      if ('value' in summary && typeof summary.value === 'string' && summary.value.length > 16) {
        return `\`${summary.value.slice(0, 12)}…\``;
      }
      return formatSummary(summary);
    };
    lines.push(`| \`${row.key}\` | ${formatTarget(row.def)} | ${shorten(row.before)} | ${shorten(row.after)} | ${formatDelta(row.deltaPct)} | ${status} | ${pixels} |`);
  }
  lines.push('');
  const counts = {};
  for (const row of result.rows) counts[row.status] = (counts[row.status] || 0) + 1;
  lines.push(`Statuses: ${Object.entries(counts).map(([status, n]) => `${status} ${n}`).join(', ') || 'none'}.`);
  if (result.pixelsIdentical !== null) {
    const inconclusive = result.rows.some(row => isPixelHashKey(row.key) && !['identical', 'pixels-changed'].includes(row.status));
    lines.push(inconclusive ? 'Export pixel comparison: inconclusive (missing measurement or different recipe).'
      : `Export pixels identical: ${result.pixelsIdentical ? 'yes' : 'no'}.`);
  }
  if (result.routeChanges.length) {
    lines.push(`Conversion route changed: ${result.routeChanges.map(row => `\`${row.key}\` ${row.before?.value} → ${row.after?.value}`).join('; ')}.`);
  }
  lines.push(`Exit status: ${result.exitCode}.`);
  return lines.join('\n');
}

/**
 * Flatten a run from results.json into { key@fixture: summary } for
 * comparison: every scenario's per-fixture `summary` map. Keys are already
 * scenario-prefixed (s2.coreExposure.dpr2.updatesPerSecond).
 */
export function collectRunSummaries(run) {
  const out = {};
  for (const [id, scenario] of Object.entries(run?.scenarios || {})) {
    out[`${id}.status`] = { value: scenario.status || 'ok', n: 1 };
    for (const [fixture, group] of Object.entries(scenario.fixtures || {})) {
      for (const [key, summary] of Object.entries(group.summary || {})) out[`${key}@${fixture}`] = summary;
    }
  }
  return out;
}

/** Record intent before any repetition, including fixtures that fail to report. */
export function comparisonSelection(scenarios, groups, dprs) {
  return { scenarios: scenarios.map(scenario => scenario.id), dprs,
    fixtures: Object.fromEntries(scenarios.map(scenario => {
      const list = groups[scenario.fixtureGroup] || [];
      const grouped = scenario.fixtureGroup === 'roll' || scenario.fixtureGroup.startsWith('export');
      return [scenario.id, grouped ? (list.length ? [`${scenario.fixtureGroup} (${list.length} files)`] : [])
        : list.map(fixture => fixture.label || fixture.name)];
    })) };
}

/** Only documented saved probe/control comparisons intersect intended scopes.
 * Never intersect measured metric keys: missing measurements inside this
 * scope still have to reach compareRuns and its failure gates.
 */
export function probeControlSummaries({ before, after, saved, selection }) {
  const prior = saved.selection || {
    scenarios: Object.keys(before?.scenarios || {}), dprs: saved.conditions?.dprs,
    fixtures: Object.fromEntries(Object.entries(before?.scenarios || {}).map(([id, scenario]) => [id,
      Object.keys(scenario.fixtures || {})]))
  };
  const intersect = (a, b) => a.filter(value => b.includes(value));
  const scenarios = intersect(prior.scenarios, selection.scenarios);
  const fixtures = Object.fromEntries(scenarios.map(id => [id, intersect(prior.fixtures[id] || [], selection.fixtures[id] || [])]));
  const dprs = prior.dprs ? intersect(prior.dprs, selection.dprs) : selection.dprs;
  const select = run => {
    const out = Object.fromEntries(Object.entries(collectRunSummaries(run)).filter(([key]) => {
      const id = key.split('.')[0];
      if (!scenarios.includes(id)) return false;
      if (/\.status$/.test(key)) return true;
      if (!key.includes('.control.')) return false;
      const at = key.indexOf('@');
      if (at < 0 || !fixtures[id].includes(key.slice(at + 1))) return false;
      const dpr = /\.dpr(\d+)(?:\.|@)/.exec(key);
      return !dpr || dprs.includes(Number(dpr[1]));
    }));
    for (const id of scenarios) if (!run?.scenarios?.[id]) out[`${id}.status`] = { value: 'missing', n: 1 };
    return out;
  };
  return { before: select(before), after: select(after),
    scope: { type: 'probe/control', metrics: 'control.* and scenario statuses', scenarios, fixtures, dprs },
    compatible: dprs.length > 0 && scenarios.some(id => fixtures[id].length > 0) };
}

/** Pick a baseline from budgets.json for a fixture and route. */
export function findBaseline(def, { ref, fixture, route } = {}) {
  const list = def?.baselines || [];
  return list.find(entry => (!ref || entry.ref === ref)
    && (!fixture || entry.fixture === fixture)
    && (!route || !entry.route || entry.route === route)) || null;
}
