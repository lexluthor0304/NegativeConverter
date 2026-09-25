import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HangWatchdog, collectHangDump, hangThresholdMs } from './hang.mjs';

assert.equal(hangThresholdMs({}), 30_000);
assert.equal(hangThresholdMs({ NC_PERF_HANG_S: '10' }), 10_000);

const flush = () => new Promise(resolve => setImmediate(resolve));

// A page that answers keeps the watchdog quiet.
{
  let clock = 0;
  let fired = null;
  const watchdog = new HangWatchdog({ ping: () => Promise.resolve(1), thresholdMs: 30_000, onHang: info => { fired = info; },
    now: () => clock, setTimer: () => 1, clearTimer: () => {} });
  watchdog.start();
  for (let i = 0; i < 100; i++) { clock += 1000; watchdog.tick(); await flush(); }
  assert.equal(fired, null);
}

// A page that stops answering is detected within threshold + 1 s (budget: + 5 s).
{
  let clock = 0;
  let fired = null;
  let answering = true;
  const watchdog = new HangWatchdog({
    ping: () => (answering ? Promise.resolve(1) : new Promise(() => {})),
    thresholdMs: 30_000, onHang: info => { fired = info; }, now: () => clock, setTimer: () => 1, clearTimer: () => {}
  });
  watchdog.start();
  for (let i = 0; i < 5; i++) { clock += 1000; watchdog.tick(); await flush(); }
  answering = false;
  const stalledAt = clock;
  while (!fired && clock < stalledAt + 60_000) { clock += 1000; watchdog.tick(); await flush(); }
  assert.ok(fired, 'the stall is detected');
  assert.ok(fired.detectedAt - stalledAt <= 31_000, `detected ${fired.detectedAt - stalledAt} ms after the stall`);
  assert.ok(fired.silentMs >= 30_000);
  const again = fired;
  clock += 5000; watchdog.tick(); await flush();
  assert.equal(fired, again, 'fires once');
}

// Dump collection: pause every session, read the ring buffer on the page.
{
  const dir = mkdtempSync(join(tmpdir(), 'nc-perf-hang-'));
  try {
    const makeSession = (frames, ring) => {
      const sent = [];
      let pausedHandler = null;
      return {
        sent,
        waitFor: method => new Promise(resolve => { if (method === 'Debugger.paused') pausedHandler = resolve; }),
        send: async (method, params) => {
          sent.push(method);
          if (method === 'Debugger.pause') setTimeout(() => pausedHandler({ reason: 'other', callFrames: frames }), 5);
          if (method === 'Debugger.evaluateOnCallFrame') {
            assert.equal(params.callFrameId, frames[0].callFrameId);
            return { result: { value: JSON.stringify(ring) } };
          }
          return {};
        }
      };
    };
    const page = makeSession([{ callFrameId: 'f1', functionName: 'ncInjectedHang', url: 'http://127.0.0.1:1/', location: { lineNumber: 0, columnNumber: 12 } }],
      { ring: [{ k: 'input', t: 1 }], counters: {} });
    const worker = makeSession([{ callFrameId: 'w1', functionName: 'suppressSensorDefects', url: 'http://127.0.0.1:1/assets/w.js', location: { lineNumber: 3, columnNumber: 1 } }]);
    const silentWorker = { waitFor: () => new Promise(() => {}), send: async () => { throw new Error('gone'); } };
    let traceStopped = false;
    const dump = await collectHangDump({
      connection: { send: async method => (method === 'SystemInfo.getProcessInfo' ? { processInfo: [{ type: 'renderer', id: 42, cpuTime: 12.5 }] } : {}) },
      sessions: [
        { kind: 'page', session: page },
        { kind: 'worker', url: 'w.js', session: worker },
        { kind: 'worker', url: 'gone.js', session: silentWorker }
      ],
      traceRecorder: { stop: async () => { traceStopped = true; }, file: 'trace.gz' },
      dir, label: 'selftest', info: { silentMs: 30_000 }, platform: 'test', pauseTimeoutMs: 200
    });
    assert.deepEqual(page.sent, ['Debugger.pause', 'Debugger.evaluateOnCallFrame']);
    assert.equal(dump.stacks.find(stack => stack.kind === 'page').frames[0].function, 'ncInjectedHang');
    assert.equal(dump.stacks.find(stack => stack.url === 'w.js').frames[0].function, 'suppressSensorDefects');
    assert.match(dump.stacks.find(stack => stack.url === 'gone.js').error, /no JS pause/);
    assert.deepEqual(dump.ring.ring, [{ k: 'input', t: 1 }]);
    assert.equal(traceStopped, true);
    assert.equal(dump.trace, 'trace.gz');
    assert.equal(dump.processes[0].id, 42);
    assert.equal(JSON.parse(readFileSync(join(dir, 'hang-selftest.json'), 'utf8')).label, 'selftest');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('hang: watchdog detection timing and dump collection tests passed');
