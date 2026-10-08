// Full #238 HSL parity sweep (about 1–2 min): for every colour-model and single-band
// setting, the 256³ lattice (channel step 257), 1 M seeded points on each two-channel
// tie plane with the tied pair offset by 0, ±1 and ±2, and 10 M seeded random triples.
// The live applyHSLAdjustments must match the frozen 1703835 copy exactly, alpha
// untouched. `npm test` runs a subset (ImageProcessor.hsl.test.mjs); CI runs this.
import { sweep, hslSettings } from '../negative2positive/src/pipeline/oracle/hslParity.mjs';

const started = Date.now();
const failures = sweep({
  settings: hslSettings(),
  latticeStep: 257,
  tiePoints: 1000000,
  randomCount: 10000000,
  log: (line) => console.log(line),
});
if (failures.length) {
  console.error('HSL parity failures:', JSON.stringify(failures, null, 2));
  process.exit(1);
}
console.log(`hsl-parity-sweep: all settings identical to 1703835 (${Math.round((Date.now() - started) / 1000)} s)`);
