import assert from 'node:assert/strict';
import { runDeviceRecovery } from './p0DeviceRecovery.js';

const previous = Object.fromEntries(['document', 'localStorage', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
try {
  const scenarios = [
    { name: 'existing roll', checkpoint: { sourceIds: ['owned-original'] }, marker: null, expected: 'device-recovery-blocked' },
    { name: 'interrupted preparation', checkpoint: null, marker: { phase: 'preparing' }, expected: 'device-recovery-failed' },
    { name: 'wrong checkpoint after restart', checkpoint: { sourceIds: [] }, marker: { phase: 'prepared', count: 4 }, expected: 'device-recovery-failed' },
    { name: 'web preview', native: false, checkpoint: null, marker: null, expected: 'device-recovery-failed' },
    { name: 'retry with unknown original', retryOf: 'previous', checkpoint: { sourceIds: ['owned-original'] },
      sources: [{ name: 'personal.jpg', size: 5 }], previousMarker: { phase: 'preparing' }, marker: null, expected: 'device-recovery-blocked' },
    { name: 'retry without ownership marker', retryOf: 'previous', checkpoint: { sourceIds: ['fixture-original'] },
      sources: [{ name: 'a.jpg', size: 5 }], marker: null, expected: 'device-recovery-blocked' }
  ];
  for (const scenario of scenarios) {
    let imports = 0, writes = 0, clicks = 0, clears = 0;
    const reports = [];
    globalThis.document = { querySelectorAll: () => [], getElementById: () => ({ click() { ++clicks; } }) };
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: {
      getItem: key => JSON.stringify(key.endsWith('previous') ? scenario.previousMarker || null : scenario.marker),
      setItem() { ++writes; }
    } });
    await runDeviceRecovery({
      plan: { deviceRecovery: 'guard-test', retryOf: scenario.retryOf, fixtures: [{ file: 'a.jpg', size: 5 }, { file: 'b.jpg', size: 7 }] },
      mobileRecovery: { open: async () => ({ checkpoint: scenario.checkpoint, sources: scenario.sources }), clear() { ++clears; } },
      invoke: async () => ({ os: scenario.native === false ? 'web' : 'ios', capabilities: { sourceRecovery: true } }),
      report: async (event, payload) => reports.push({ event, ...payload }),
      importFixtures: async () => { ++imports; }, errors: []
    });
    assert.equal(reports.at(-1).event, scenario.expected, scenario.name);
    assert.deepEqual({ imports, writes, clicks, clears }, { imports: 0, writes: 0, clicks: 0, clears: 0 }, scenario.name);
    if (scenario.expected === 'device-recovery-failed') assert.ok(reports.at(-1).message.length > 0);
  }
  // The real input handler replaces the roll on every change. A full run must
  // use one multi-file selection, then visit every image before terminating.
  const fixtures = ['a.jpg', 'b.heic', 'c.NEF', 'd.dng'].map(file => ({ file, size: 5 }));
  let queue = [], active = 0, imports = 0, exports = [], savedMarker;
  const edits = [0, 0, 0, 0], reports = [];
  const exposure = { get value() { return edits[active]; }, set value(v) { edits[active] = Number(v); }, dispatchEvent() {} };
  globalThis.document = {
    body: { dataset: {} },
    querySelectorAll: () => queue,
    querySelector(selector) {
      if (selector.includes('.active')) return { dataset: { index: String(active) } };
      const index = Number(selector.match(/data-index="(\d+)"/)[1]);
      return queue[index] && { click() { active = index; } };
    },
    getElementById(id) {
      if (id === 'mobileRecoveryStatus') return { dataset: { status: 'saved' } };
      if (id === 'studioFilename') return { textContent: queue[active]?.file };
      if (id === 'coreExposure') return exposure;
      return null;
    }
  };
  globalThis.window = {};
  globalThis.localStorage = { getItem: () => null, setItem: (_, value) => { savedMarker = JSON.parse(value); } };
  await runDeviceRecovery({ plan: { deviceRecovery: 'one-selection', fixtures },
    mobileRecovery: { open: async () => ({ checkpoint: null }), flush: async () => {} },
    invoke: async () => ({ os: 'ios', capabilities: { sourceRecovery: true } }),
    report: async (event, payload) => reports.push({ event, ...payload }),
    waitFor: async (label, condition) => assert.ok(condition(), label), studioSettled: () => true,
    importFixtures: async selected => { ++imports; queue = selected; active = 0; return { becameCurrent: true }; },
    exportCurrent: async () => { exports.push(queue[active].file); return {}; },
    frameFacts: () => ({}), memorySnapshot: () => ({}), takeRawLog: () => [], errors: []
  });
  assert.equal(imports, 1);
  assert.deepEqual(exports, fixtures.map(f => f.file));
  assert.deepEqual(edits, [17, 31, 0, 0]);
  assert.equal(savedMarker.phase, 'prepared');
  assert.equal(reports.at(-1).event, 'device-recovery-prepared');
  console.log('ok: device harness imports one complete roll, exports each image, and preserves unknown or incomplete work');
} finally {
  for (const [key, descriptor] of Object.entries(previous)) {
    if (descriptor === undefined) delete globalThis[key]; else Object.defineProperty(globalThis, key, descriptor);
  }
}
