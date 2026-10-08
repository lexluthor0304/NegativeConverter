import assert from 'node:assert/strict';
import { learnedDefaultsKey, learnedDelta, recordLearnedObservation, estimateLearnedDefaults, applyLearnedDefaults, sanitizeLearnedRecord, withoutLearnedDefaults, snapLearnedDefaults } from './learnedDefaults.js';
const key = learnedDefaultsKey({ filmType: 'color', filmEdge: { filmName: 'Portra' } }, { lab: 'Lab A' });
assert.notEqual(key, learnedDefaultsKey({ filmType: 'color', filmEdge: { filmName: 'Gold' } }, { lab: 'Lab A' }));
assert.deepEqual(learnedDelta({ coreTemperature: 0, wbR: 1 }, { coreTemperature: 12, wbR: 1.4 }, ['coreTemperature', 'wbR']), { coreTemperature: 12 });
let record;
for (let i = 0; i < 3; i++) record = recordLearnedObservation(record, { key, rollId: String(i), frameId: 'a', delta: { coreTemperature: 12, corePaper: 'ra4' } });
assert.equal(estimateLearnedDefaults(record).offsets.coreTemperature, 6, 'three roll medians, k=3');
assert.equal(estimateLearnedDefaults(record).choices.corePaper, 'ra4');
record = recordLearnedObservation(record, { key, rollId: '2', frameId: 'a', delta: { coreTemperature: 12, corePaper: 'ra4' } });
assert.equal(record.rolls.length, 3, 'repeated export is not another vote');
assert.equal(applyLearnedDefaults({ coreTemperature: 2 }, record).coreTemperature, 8);
assert.equal(sanitizeLearnedRecord({ ...record, version: 999 }), null);
assert.equal(estimateLearnedDefaults({ ...record, rolls: record.rolls.slice(0, 2) }).choices.corePaper, undefined);
assert.deepEqual(learnedDelta({ coreTemperature: 0 }, { coreTemperature: 0 }, ['coreTemperature']), {});
// A retype re-applies learned defaults under the new key (#231).
const automatic = { filmType: 'positive', coreTemperature: 2, coreExposure: 5, corePaper: 'none', cropRegion: { left: 1 } };
const learned = applyLearnedDefaults(automatic, record);
assert.equal(learned.corePaper, 'ra4');
const restored = withoutLearnedDefaults({ ...learned, filmType: 'bw', cropRegion: { left: 2 } }, automatic);
assert.deepEqual(restored, { ...automatic, filmType: 'bw', cropRegion: { left: 2 } }, 'only learned keys return to the automatic recipe');
assert.equal(withoutLearnedDefaults(automatic, automatic), automatic, 'nothing learned, nothing to undo');
assert.notEqual(learnedDefaultsKey({ filmType: 'bw' }), learnedDefaultsKey({ filmType: 'positive' }), 'film type is part of the key');
// One roll's offset is a quarter of the edit (k=3): snapped as a slider would
// (step 1, ties toward +infinity, within its range), only on learned keys.
{
  const one = recordLearnedObservation(null, { key, rollId: 'r', frameId: 'f', delta: { coreTemperature: 6, coreContrast: -6 } });
  const learnedOnce = applyLearnedDefaults({ coreTemperature: 0, coreContrast: 0, wbB: 1.234 }, one);
  assert.equal(learnedOnce.coreTemperature, 1.5);
  const slider = (key, value) => Math.min(100, Math.max(-100, Math.round(value)));
  const snapped = snapLearnedDefaults(learnedOnce, slider);
  assert.equal(snapped.coreTemperature, 2);
  assert.equal(snapped.coreContrast, -1, 'a tie snaps toward +infinity, as a range input does');
  assert.equal(snapped.wbB, 1.234, 'keys that are not learned stay as they are');
  assert.deepEqual(snapped.learnedDefaults, learnedOnce.learnedDefaults);
  assert.equal(snapLearnedDefaults(snapped, slider), snapped, 'snapping twice changes nothing');
  const plain = { coreTemperature: 1.5 };
  assert.equal(snapLearnedDefaults(plain, slider), plain, 'nothing learned, nothing snapped');
  assert.equal(snapLearnedDefaults(learnedOnce, (k, v) => v), learnedOnce, 'no slider keeps the value');
}
console.log('learned defaults: stock/lab keys, shrinkage, majority, idempotence, whitelist, slider snap passed');
