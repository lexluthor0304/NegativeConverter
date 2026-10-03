import assert from 'node:assert/strict';
import { metricsFromSelfDriven } from './webkit.mjs';

const warm = (keyT, ms) => ({
  name: 'switch:warm1Back', cls: 'warm1Back', index: 0, target: 'r0.dng', keyT,
  window: { start: keyT, end: keyT + ms + 100, frames: [], ticks: [] },
  events: [
    { k: 'mut', t: keyT + 1, what: 'filename', v: 'r0.dng' },
    { k: 'c2d', t: keyT + ms, c: 'canvas', fn: 'putImageData', w: 4, h: 3, hash: 'pixels' },
    { k: 'vis', t: keyT + ms + 1, ready: true, busy: false, ov: false }
  ]
});
const cases = {
  repeated() {
    const recorded = {};
    const metrics = metricsFromSelfDriven({ scenario: 's7', error: 'later metadata rejected',
      parts: [warm(100, 20), warm(1000, 200)] }, { record: (key, value) => { recorded[key] = value; } });
    assert.equal(metrics['s7.warm1Back.firstPixelsMs'], 110, 'both completed same-photo visits contribute to the median');
    assert.equal(recorded['s7.warm1Back.firstPixelsMs'], 110, 'the runner receives that median after a later failure');
    assert.equal(metrics['s7.warm1Back.readyMs'], 111);
  },
  emptyImport() {
    const metrics = metricsFromSelfDriven({ scenario: 's1', error: 'import rejected', parts: [{ name: 'import', before: 100 }] });
    for (const key of ['librawDecodes', 'timerGapCount', 'rafGapsOver50']) {
      assert.equal(metrics[`s1.${key}`], undefined, `${key} was never observed`);
    }
    for (const window of [{}, { start: 100, end: 200 }]) {
      const incomplete = metricsFromSelfDriven({ scenario: 's1', parts: [{ name: 'import', before: 100, window }] });
      for (const key of ['librawDecodes', 'timerGapCount', 'rafGapsOver50']) assert.equal(incomplete[`s1.${key}`], undefined);
    }
    const partial = metricsFromSelfDriven({ scenario: 's1', error: 'later rejected', parts: [{ name: 'import', before: 100,
      events: [{ k: 'req', t: 120, cls: 'libraw', fn: 'open' }] }] });
    assert.equal(partial['s1.librawDecodes'], 1, 'genuine partial event evidence survives');
    assert.equal(partial['s1.timerGapCount'], undefined, 'events alone cannot invent a timing window');
    const observed = metricsFromSelfDriven({ scenario: 's1', parts: [{ name: 'import', before: 100, events: [],
      window: { start: 100, end: 200, ticks: [100, 105, 110], frames: [100, 116] } }] });
    assert.equal(observed['s1.librawDecodes'], 0, 'a completed observation may report a genuine zero');
    assert.equal(observed['s1.timerGapCount'], 0);
    assert.equal(observed['s1.rafGapsOver50'], 0);
  }
};
for (const name of process.argv[2] ? [process.argv[2]] : Object.keys(cases)) {
  cases[name]();
  console.log(`WebKit partial samples: ${name} passed`);
}
