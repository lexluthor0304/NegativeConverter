import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize } from './stats.mjs';
import { dragMetrics } from './metrics.mjs';
import {
  compareMetric, compareRuns, findMetricDef, meetsTarget, renderCompareMarkdown, formatTarget, collectRunSummaries
} from './compare.mjs';

const s = (...values) => summarize(values);
const budgets = {
  metrics: {
    's2.coreExposure.dpr2.inputToDrawP95Ms': { unit: 'ms', better: 'lower', target: 16, tolerance: { rel: 0.10, abs: 2 } },
    's2.coreExposure.dpr2.updatesPerSecond': { unit: '1/s', better: 'higher', target: 55, tolerance: { rel: 0.10, abs: 2 } },
    's2.*.dpr2.framesCoveredPct': { unit: '%', better: 'higher', target: 95, tolerance: { rel: 0, abs: 3 } },
    's2.*.*.framesCoveredPct': { unit: '%', better: 'higher', target: 90 },
    's6.roll.thumbnailsAllMs': { unit: 'ms', better: 'lower', tolerance: { rel: 0.1, abs: 1000 } }
  }
};

// Definitions: exact keys win over wildcards; the most specific wildcard wins.
assert.equal(findMetricDef(budgets, 's2.coreExposure.dpr2.updatesPerSecond').target, 55);
assert.equal(findMetricDef(budgets, 's2.cyan.dpr2.framesCoveredPct').target, 95);
assert.equal(findMetricDef(budgets, 's2.cyan.dpr1.framesCoveredPct').target, 90);
assert.equal(findMetricDef(budgets, 's9.png8.totalMs'), null);
assert.equal(meetsTarget({ better: 'lower', target: 16 }, 16), true);
assert.equal(meetsTarget({ better: 'higher', target: 55 }, 54.9), false);
assert.equal(meetsTarget({ better: 'lower' }, 3), null, 'tracked metrics have no target');
assert.equal(formatTarget(budgets.metrics['s2.coreExposure.dpr2.updatesPerSecond']), '≥ 55 1/s');
assert.equal(formatTarget(budgets.metrics['s6.roll.thumbnailsAllMs']), 'tracked');

const p95Def = findMetricDef(budgets, 's2.coreExposure.dpr2.inputToDrawP95Ms');
// open: target missed before and after, within noise.
assert.equal(compareMetric('k', p95Def, s(56, 55, 60), s(57, 54, 61)).status, 'open');
// improved: beyond tolerance, ranges apart, target still missed.
assert.equal(compareMetric('k', p95Def, s(56, 55, 60), s(30, 28, 33)).status, 'improved');
// improved into the budget.
assert.equal(compareMetric('k', p95Def, s(56, 55, 60), s(14, 13, 15)).status, 'improved');
// pass: target met before and after, within noise.
assert.equal(compareMetric('k', p95Def, s(12, 11, 13), s(12.5, 11, 14)).status, 'pass');
// broke-budget: met before, missed after by more than noise.
assert.equal(compareMetric('k', p95Def, s(12, 11, 13), s(20, 19, 22)).status, 'broke-budget');
// A crossing within noise is not a failure.
const crossing = compareMetric('k', p95Def, s(15.5, 15, 16), s(16.5, 16, 17));
assert.equal(crossing.status, 'open');
assert.match(crossing.note, /within noise/);
// regressed: worse beyond tolerance, ranges do not overlap, target never met.
assert.equal(compareMetric('k', p95Def, s(56, 55, 60), s(80, 75, 85)).status, 'regressed');
// Worse beyond tolerance but overlapping ranges is noise.
assert.equal(compareMetric('k', p95Def, s(56, 40, 70), s(66, 60, 90)).status, 'open');
// Higher-is-better direction.
const rateDef = findMetricDef(budgets, 's2.coreExposure.dpr2.updatesPerSecond');
assert.equal(compareMetric('k', rateDef, s(31.3, 29.3, 31.3), s(20, 19, 21)).status, 'regressed');
assert.equal(compareMetric('k', rateDef, s(58, 57, 59), s(50, 49, 51)).status, 'broke-budget');
assert.equal(compareMetric('k', rateDef, s(31.3, 29.3, 31.3), s(59, 58, 60)).status, 'improved');
// Tracked metrics: regress beyond tolerance with apart ranges, else pass.
const tracked = findMetricDef(budgets, 's6.roll.thumbnailsAllMs');
assert.equal(compareMetric('k', tracked, s(277000, 273500, 282400), s(330000, 325000, 335000)).status, 'regressed');
assert.equal(compareMetric('k', tracked, s(277000, 273500, 282400), s(278000, 276000, 281000)).status, 'pass');
// Missing and string metrics.
assert.equal(compareMetric('k', null, null, s(1)).status, 'missing');
assert.equal(compareMetric('k', null, s(1), null).status, 'missing-after');
assert.equal(compareRuns({ budgets, before: { k: s(1) }, after: {} }).exitCode, 1);
assert.equal(compareRuns({ budgets, before: {}, after: { k: s(1) } }).exitCode, 0, 'new metrics are informational');
const mismatch = compareRuns({ budgets, before: {
  's9.single.png8.geometry.rotationAngle': s('91.2'), 's9.single.png8.geometry.pixelsSha256': s('a')
}, after: { 's9.single.png8.geometry.rotationAngle': s('91.3'), 's9.single.png8.geometry.pixelsSha256': s('b') }, allowPixelChange: true });
assert.equal(mismatch.exitCode, 1, 'a recipe mismatch cannot be waived as a pixel change');
assert.equal(mismatch.rows[0].status, 'recipe-changed');
assert.equal(mismatch.rows[1].status, 'recipe-mismatch');
assert.match(renderCompareMarkdown(mismatch), /Export pixel comparison: inconclusive/);
assert.equal(compareMetric('s9.single.png16.geometry.cropRegion', null,
  s('{"left":1,"top":2,"width":10,"height":20}'), s('{"height":20,"width":10,"top":2,"left":1}')).status, 'identical',
  'crop metadata compares values rather than JSON property order');
assert.equal(compareRuns({ budgets, before: {}, after: { 's2.status': s('hang') } }).exitCode, 1);

// Replayed S2 GPU tick samples compare as an improvement over the old 31 Hz
// worker path, rather than the zero-rate regression the LUT fallback caused.
const replay = [{ k: 'res', cls: 'convert', t: 10, rt: 0, w: 1800, h: 1200, hash: 'old' }];
for (let i = 0; i < 180; i++) {
  const t = 1000 + i * 1000 / 60;
  replay.push({ k: 'input', type: 'input', id: 'coreExposure', v: i + 1, t, tr: true },
    { k: 'gl.upload', c: 'glCanvas', t: t + 1, w: 256, h: 256, hash: `lut${i}` },
    { k: 'gl.draw', c: 'glCanvas', t: t + 6, sig: i });
}
const replayed = dragMetrics(replay, { targetId: 'coreExposure', window: { start: 1000, release: 4000, end: 4500 } });
const replayCompare = compareRuns({ budgets, before: { 's2.coreExposure.dpr2.updatesPerSecond': s(31) },
  after: { 's2.coreExposure.dpr2.updatesPerSecond': s(replayed.updatesPerSecond) } });
assert.equal(replayCompare.exitCode, 0);
assert.equal(replayCompare.rows[0].status, 'improved');
assert.equal(compareMetric('s9.png8.imported.pixelsSha256', null, s('aa', 'aa'), s('aa', 'aa')).status, 'identical');
assert.equal(compareMetric('s9.png8.imported.pixelsSha256', null, s('aa'), s('bb')).status, 'pixels-changed');
assert.equal(compareMetric('s1.photo0.route', null, s('positive'), s('bw')).status, 'route-changed');
assert.equal(compareMetric('k', null, s(10, 9, 11), s(30, 29, 31)).status, 'pass', 'no direction, no verdict');
assert.equal(compareMetric('k', p95Def, s(56), s(56)).deltaPct, 0);

// Whole-run exit status.
const before = {
  's2.coreExposure.dpr2.inputToDrawP95Ms': s(56, 55, 60),
  's2.coreExposure.dpr2.updatesPerSecond': s(31.3, 29.3, 31.3),
  's9.png8.imported.pixelsSha256': s('aa', 'aa'),
  's1.photo0.route': s('positive')
};
const noise = {
  's2.coreExposure.dpr2.inputToDrawP95Ms': s(57, 54, 61),
  's2.coreExposure.dpr2.updatesPerSecond': s(30.5, 29, 32),
  's9.png8.imported.pixelsSha256': s('aa', 'aa'),
  's1.photo0.route': s('positive')
};
const within = compareRuns({ budgets, before, after: noise });
assert.equal(within.exitCode, 0, 'every change within noise exits 0');
assert.equal(within.pixelsIdentical, true);
const regressed = compareRuns({ budgets, before, after: { ...noise, 's2.coreExposure.dpr2.updatesPerSecond': s(20, 19, 21) } });
assert.equal(regressed.exitCode, 1);
assert.deepEqual(regressed.failing.map(row => row.key), ['s2.coreExposure.dpr2.updatesPerSecond']);
const pixels = compareRuns({ budgets, before, after: { ...noise, 's9.png8.imported.pixelsSha256': s('bb') } });
assert.equal(pixels.exitCode, 1, 'changed export pixels fail unless allowed');
assert.equal(pixels.pixelsIdentical, false);
assert.equal(compareRuns({ budgets, before, after: { ...noise, 's9.png8.imported.pixelsSha256': s('bb') }, allowPixelChange: true }).exitCode, 0);
const route = compareRuns({ budgets, before, after: { ...noise, 's1.photo0.route': s('bw') } });
assert.equal(route.exitCode, 0, 'a route change is flagged, not failed');
assert.equal(route.routeChanges.length, 1);

const markdown = renderCompareMarkdown(regressed, { baseLabel: '1703835', headLabel: 'HEAD' });
assert.match(markdown, /\| metric \| target \| 1703835 median \(min–max\) \| HEAD median \(min–max\) \| Δ % \| status \| export pixels \|/);
assert.match(markdown, /`s2.coreExposure.dpr2.updatesPerSecond` \| ≥ 55 1\/s \| 31.3 \(29.3–31.3\) \| 20 \(19–21\) \| -36.1 % \| regressed \| – \|/);
assert.match(markdown, /`s9.png8.imported.pixelsSha256` \| tracked \| aa \| aa \| – \| identical \| identical \|/);
assert.match(markdown, /Exit status: 1\./);

assert.deepEqual(collectRunSummaries({ scenarios: { s1: { fixtures: { 'a.dng': { summary: { 's1.x': 1 } } } }, s2: { fixtures: { 'b.tif': { summary: { 's2.y': 2 } } } } } }),
  { 's1.status': { value: 'ok', n: 1 }, 's1.x@a.dng': 1, 's2.status': { value: 'ok', n: 1 }, 's2.y@b.tif': 2 });
assert.equal(findMetricDef(budgets, 's2.coreExposure.dpr2.updatesPerSecond@synthetic-60mp-cfa.dng').target, 55, 'the fixture suffix is ignored for budgets');
assert.equal(compareMetric('s9.png8.imported.pixelsSha256@x.dng', null, s('a'), s('b')).status, 'pixels-changed');

// The checked-in budgets file parses and every entry is well formed.
const here = dirname(fileURLToPath(import.meta.url));
const file = JSON.parse(readFileSync(join(here, '..', 'budgets.json'), 'utf8'));
for (const [key, def] of Object.entries(file.metrics)) {
  assert.ok(['lower', 'higher'].includes(def.better), `${key}: better`);
  assert.ok(def.unit, `${key}: unit`);
  if (def.target !== undefined) assert.ok(Number.isFinite(def.target), `${key}: target`);
  assert.ok(def.tolerance && Number.isFinite(def.tolerance.rel) && Number.isFinite(def.tolerance.abs), `${key}: tolerance`);
  for (const baseline of def.baselines || []) {
    assert.ok(baseline.ref && baseline.fixture && baseline.source, `${key}: baseline needs ref, fixture and source`);
    assert.ok('route' in baseline, `${key}: baseline route`);
    assert.ok(baseline.range === null || (Array.isArray(baseline.range) && baseline.range.length === 2), `${key}: range`);
  }
}

console.log('compare: statuses, exit codes, markdown and budgets.json tests passed');
