import assert from 'node:assert/strict';
import { parseArgs, UsageError, ALL_SCENARIOS, QUICK_SCENARIOS } from './args.mjs';
import { scheduleTimes, runPaced, linearPath } from './pacing.mjs';

const defaults = parseArgs([], {});
assert.equal(defaults.mode, 'run');
assert.deepEqual(defaults.scenarios, ALL_SCENARIOS);
assert.equal(defaults.fixtures, 'synthetic');
assert.equal(defaults.reps, 3);
assert.deepEqual(defaults.dprs, [1, 2]);
assert.equal(defaults.profile, true);
assert.equal(defaults.probe, true);
assert.equal(defaults.port, 5297, 'defaults differ from the smoke test (5197 / 9224)');
assert.equal(defaults.cdpPort, 9324);

const quick = parseArgs(['--quick'], {});
assert.deepEqual(quick.scenarios, QUICK_SCENARIOS);
assert.deepEqual(quick.dprs, [2]);
assert.equal(quick.rollSize, 4, 'a short roll keeps --quick within its time budget');
assert.equal(quick.profile, false);
assert.equal(parseArgs(['--quick', '--roll-size', '12'], {}).rollSize, 12);

const compare = parseArgs(['--compare', '1703835', 'HEAD', '--scenarios', 's2,s4,m', '--fixtures', 'real'], {});
assert.equal(compare.mode, 'compare');
assert.deepEqual(compare.compare, ['1703835', 'HEAD']);
assert.deepEqual(compare.scenarios, ['s2', 's4'], 'm is always sampled and not a scenario of its own');
assert.equal(compare.fixtures, 'real');

assert.equal(parseArgs(['--against', 'output/perf/x/results.json'], {}).mode, 'against');
assert.equal(parseArgs(['--head', '../wt-233'], {}).headWorktree, '../wt-233');
assert.equal(parseArgs(['--reps=5', '--film-type=bw'], {}).reps, 5);
assert.equal(parseArgs(['--film-type', 'positive'], {}).filmType, 'positive');
assert.equal(parseArgs(['--no-probe', '--scenarios', 's1,s2'], {}).probe, false);
assert.throws(() => parseArgs(['--no-probe'], {}), UsageError, 'control runs are limited to s1 and s2');
assert.equal(parseArgs(['--inject-hang'], {}).injectHang, true);
assert.equal(parseArgs(['--record-baselines'], {}).recordBaselines, true);
assert.equal(parseArgs([], { NC_PERF_PORT: '6000' }).port, 6000);

for (const bad of [['--compare', 'a'], ['--scenarios', 's10'], ['--fixtures', 'x'], ['--reps', '0'], ['--dpr', '3'],
  ['--browser', 'firefox'], ['--bogus'], ['stray'], ['--compare', 'a', 'b', '--against', 'r.json'],
  ['--browser', 'safari', '--dpr', '1'], ['--roll-size', '1']]) {
  assert.throws(() => parseArgs(bad, {}), UsageError, bad.join(' '));
}

// Absolute 60 Hz schedule.
assert.deepEqual(scheduleTimes(3, 100, 10), [100, 110, 120]);
assert.deepEqual(linearPath({ x0: 0, y0: 0, x1: 10, y1: 20, count: 2 }), [{ x: 5, y: 10 }, { x: 10, y: 20 }]);
{
  // A fake clock where every fire costs 30 ms: later steps must not drift.
  let clock = 0;
  const fired = [];
  const result = await runPaced(5, (i, due) => { fired.push(due); }, {
    periodMs: 50,
    now: () => clock,
    sleep: async ms => { clock += ms; },
    spinMs: 0
  });
  assert.deepEqual(fired, [0, 50, 100, 150, 200]);
  assert.ok(result.lateness.every(late => late >= 0 && late < 1e-9));
}
{
  // A late step (the process stalled 120 ms) is fired immediately; the next
  // ones keep their original deadlines.
  let clock = 0;
  const times = [];
  let stalled = false;
  await runPaced(4, () => { times.push(clock); if (!stalled) { stalled = true; clock += 120; } }, {
    periodMs: 50, now: () => clock, sleep: async ms => { clock += ms; }, spinMs: 0
  });
  assert.deepEqual(times, [0, 120, 120, 150]);
}

console.log('args and pacing: option parsing and absolute 60 Hz schedule tests passed');
