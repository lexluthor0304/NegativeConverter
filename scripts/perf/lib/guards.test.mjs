import assert from 'node:assert/strict';
import {
  parseSwapUsage, parsePressureLevel, parsePmsetBatt, parsePmsetTherm, memoryCeilingBytes,
  evaluatePreflight, evaluateRunGuards, waitForQuietMachine, freeDiskBytes, GiB
} from './guards.mjs';

// Real macOS 27 output formats.
assert.deepEqual(parseSwapUsage('vm.swapusage: total = 17152.00M  used = 13231.31M  free = 3920.69M  (encrypted)'), {
  total: 17152 * 1024 ** 2, used: Math.round(13231.31 * 1024 ** 2), free: Math.round(3920.69 * 1024 ** 2)
});
assert.equal(parseSwapUsage('vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)').used, 0);
assert.equal(parseSwapUsage('').used, null);
assert.deepEqual(parsePressureLevel('kern.memorystatus_vm_pressure_level: 1'), { level: 1, name: 'normal' });
assert.deepEqual(parsePressureLevel('kern.memorystatus_vm_pressure_level: 4'), { level: 4, name: 'critical' });
assert.equal(parsePressureLevel('').name, 'unknown');
assert.deepEqual(parsePmsetBatt("Now drawing from 'AC Power'\n -InternalBattery-0 (id=24641635)\t100%; finishing charge; 0:00 remaining present: true"),
  { source: 'AC Power', percent: 100, onBattery: false });
assert.equal(parsePmsetBatt("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t54%; discharging").onBattery, true);
const therm = parsePmsetTherm('Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\nNote: No CPU power status has been recorded');
assert.equal(therm.thermalWarningLevel, 0);
assert.equal(therm.performanceWarningLevel, 0);
assert.equal(parsePmsetTherm('CPU_Speed_Limit = 70\nThermal Warning Level = 2').cpuSpeedLimit, 70);

// Memory ceiling: env override or 60 % of RAM (9.6 GB of 16 GB).
assert.equal(memoryCeilingBytes({ NC_PERF_MEM_CEILING_GB: '3' }, 16 * GiB), 3 * GiB);
assert.equal(memoryCeilingBytes({}, 16 * GiB), Math.round(16 * GiB * 0.6));

assert.deepEqual(evaluatePreflight({ pressure: { level: 1, name: 'normal' }, freeDisk: 30 * GiB }), { ok: true, problems: [] });
const refused = evaluatePreflight({ pressure: { level: 2, name: 'warn' }, freeDisk: 14 * GiB });
assert.equal(refused.ok, false);
assert.equal(refused.problems.length, 2);

const base = { ceilingBytes: 9.6 * GiB, swapUsedAtStart: 13 * GiB, freeDisk: 30 * GiB };
assert.equal(evaluateRunGuards({ ...base, browserBytes: 5 * GiB, swapUsed: 14 * GiB }), null);
assert.equal(evaluateRunGuards({ ...base, browserBytes: 9.7 * GiB, swapUsed: 13 * GiB }).reason, 'memory-ceiling');
assert.match(evaluateRunGuards({ ...base, browserBytes: 5 * GiB, swapUsed: 15.1 * GiB }).detail, /swap grew/);
assert.match(evaluateRunGuards({ ...base, browserBytes: 5 * GiB, swapUsed: 13 * GiB, freeDisk: 19 * GiB }).detail, /free disk/);

// Load guard: waits, then labels the run noisy instead of refusing it.
{
  let clock = 0;
  const loads = [7, 6, 3];
  const quiet = await waitForQuietMachine({ cores: 8, readLoad: () => loads.shift() ?? 3, sleep: async ms => { clock += ms; }, now: () => clock });
  assert.equal(quiet.noisy, false);
  assert.equal(quiet.waitedMs, 10_000);
  clock = 0;
  const noisy = await waitForQuietMachine({ cores: 8, readLoad: () => 12, sleep: async ms => { clock += ms; }, now: () => clock });
  assert.equal(noisy.noisy, true);
  assert.ok(noisy.waitedMs >= 120_000);
}

assert.ok(freeDiskBytes('.') > 0);
assert.equal(freeDiskBytes('/definitely/not/here'), null);

console.log('guards: sysctl/pmset parsers, ceiling, pre-flight, run guards and load guard tests passed');
