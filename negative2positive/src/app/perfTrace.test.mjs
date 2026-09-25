import assert from 'node:assert/strict';
import { createPerfTraceFactory, readPerfFlags, PERF_ENTRY_PREFIX } from './perfTrace.js';

const entries = () => [...performance.getEntriesByType('mark'), ...performance.getEntriesByType('measure')];
const clear = () => { performance.clearMarks(); performance.clearMeasures(); };

assert.deepEqual(readPerfFlags(''), { debug: false, userTiming: false });
assert.deepEqual(readPerfFlags('?perf=1'), { debug: false, userTiming: true });
assert.deepEqual(readPerfFlags('?lang=en&debug=1'), { debug: true, userTiming: false });
assert.deepEqual(readPerfFlags('?perf=true'), { debug: false, userTiming: false }, 'only perf=1 switches it on');

// Flag off: the real User Timing buffer stays empty, whatever the duration.
{
  clear();
  const logs = [];
  const { createPerfTrace, recordStages } = createPerfTraceFactory({ log: (...args) => logs.push(args) });
  for (let i = 0; i < 50; i++) {
    const trace = createPerfTrace('prepareStudioPhoto', { file: 'a.dng', pixels: 60e6 });
    trace.mark('load', { bytes: 1 });
    trace.mark('convert');
    trace.end({ ok: true });
  }
  recordStages('autoFrameStages', { hough: 12, lines: 3 }, { method: 'hough' });
  assert.equal(entries().length, 0, 'no marks or measures without ?perf=1');
  assert.equal(logs.length, 0, 'no console output without ?debug=1');
}

// Flag off with a recording stand-in: not a single User Timing call.
{
  const calls = [];
  let t = 0;
  const fake = { now: () => (t += 200), mark: (...a) => calls.push(['mark', ...a]), measure: (...a) => calls.push(['measure', ...a]) };
  const { createPerfTrace, recordStages } = createPerfTraceFactory({ performance: fake, log: () => {} });
  const trace = createPerfTrace('batchExport', { files: 3 });
  trace.mark('decode');
  trace.end();
  recordStages('autoFrameStages', { a: 1 });
  assert.deepEqual(calls, []);
}

// Flag on: a mark per stage and a measure per trace, also for fast traces.
{
  clear();
  const logs = [];
  const { createPerfTrace, recordStages } = createPerfTraceFactory({ userTiming: true, log: (...args) => logs.push(args) });
  const trace = createPerfTrace('processNegative', { width: 10, height: 20 });
  trace.mark('analysis', { cached: true });
  trace.mark('convert');
  trace.end({ route: 'silvercore' });
  const marks = performance.getEntriesByType('mark').map(entry => entry.name);
  assert.deepEqual(marks, [
    `${PERF_ENTRY_PREFIX}processNegative:start`,
    `${PERF_ENTRY_PREFIX}processNegative:analysis`,
    `${PERF_ENTRY_PREFIX}processNegative:convert`
  ]);
  const [measure] = performance.getEntriesByType('measure');
  assert.equal(measure.name, `${PERF_ENTRY_PREFIX}processNegative`);
  assert.ok(measure.duration >= 0 && measure.duration < 120, 'fast traces are recorded too');
  assert.equal(measure.detail.route, 'silvercore');
  assert.equal(measure.detail.width, 10);
  assert.deepEqual(measure.detail.stages.map(stage => stage.stage), ['analysis', 'convert']);
  assert.equal(measure.detail.stages[0].cached, true);
  assert.equal(performance.getEntriesByType('mark')[1].detail.stage, 'analysis');
  assert.equal(logs.length, 0, '?perf=1 alone does not log');

  recordStages('autoFrameStages', { hough: 30, lines: 10 }, { method: 'restrictedHough' });
  const stages = performance.getEntriesByName(`${PERF_ENTRY_PREFIX}autoFrameStages`)[0];
  assert.equal(stages.detail.method, 'restrictedHough');
  assert.equal(stages.detail.hough, 30);
  assert.equal(stages.detail.totalMs, 40);
  clear();
}

// A detail that cannot be structured-cloned never breaks the traced work.
{
  clear();
  const { createPerfTrace } = createPerfTraceFactory({ userTiming: true });
  const trace = createPerfTrace('imageDataToBlob', { encoder: () => {} });
  trace.mark('encode', { callback: () => {} });
  assert.doesNotThrow(() => trace.end());
  assert.equal(performance.getEntriesByType('measure').length, 1);
  assert.equal(performance.getEntriesByType('measure')[0].detail, null);
  clear();
}

// ?debug=1 keeps the old console threshold (120 ms).
{
  let t = 0;
  const logs = [];
  const fake = { now: () => t };
  const { createPerfTrace } = createPerfTraceFactory({ debug: true, performance: fake, log: (...args) => logs.push(args) });
  const fast = createPerfTrace('fullResolutionRender');
  t += 119;
  fast.end();
  assert.equal(logs.length, 0);
  const slow = createPerfTrace('fullResolutionRender', { pixels: 5 });
  slow.mark('convert');
  t += 120;
  slow.end({ stale: false });
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1], 'fullResolutionRender');
  assert.equal(logs[0][2].totalMs, 120);
  assert.equal(logs[0][2].pixels, 5);
}

console.log('perfTrace: flag-gated User Timing and debug logging tests passed');
