// Standalone Node test for adjustmentPipeline.js.
//
// The Step-3 adjustment stage is 8-bit only (Uint8ClampedArray in/out, 256-entry
// LUTs). These tests pin the rule the export path depends on: the engine's
// 16-bit plane may ride along ONLY while the adjustments are a no-op.
import assert from 'node:assert/strict';

import {
  applyPreparedAdjustmentsToBuffer,
  areAdjustmentsIdentity,
  createAdjustmentLutScratch
} from './adjustmentPipeline.js';
import { isIdentityCurve } from '../workers/pixelAdjustments.js';

function linearCurve() {
  const curve = new Uint8Array(256);
  for (let i = 0; i < 256; i++) curve[i] = i;
  return curve;
}

function identityCurves() {
  return { r: linearCurve(), g: linearCurve(), b: linearCurve() };
}

assert.ok(isIdentityCurve(linearCurve()));
{
  const bent = linearCurve();
  bent[128] = 129;
  assert.ok(!isIdentityCurve(bent));
}
assert.ok(!isIdentityCurve(new Uint8Array(10)));
assert.ok(!isIdentityCurve(null));

// -------------------------------------------------------- identity detection

assert.ok(areAdjustmentsIdentity({ curves: identityCurves() }));
assert.ok(areAdjustmentsIdentity({
  curves: identityCurves(),
  exposure: 0, contrast: 0, highlights: 0, shadows: 0,
  temperature: 0, tint: 0, saturation: 0, vibrance: 0,
  cyan: 0, magenta: 0, yellow: 0, wbR: 1, wbG: 1, wbB: 1
}));

assert.ok(!areAdjustmentsIdentity(null));
assert.ok(!areAdjustmentsIdentity({}), 'no curves -> cannot claim identity');

for (const [key, value] of [
  ['exposure', 0.25],
  ['contrast', 5],
  ['highlights', -10],
  ['shadows', 10],
  ['temperature', 4],
  ['tint', -4],
  ['saturation', 20],
  ['vibrance', 20],
  ['cyan', 3],
  ['magenta', 3],
  ['yellow', 3],
  ['wbR', 1.02],
  ['wbG', 0.98],
  ['wbB', 1.5]
]) {
  assert.ok(
    !areAdjustmentsIdentity({ curves: identityCurves(), [key]: value }),
    `${key}=${value} must count as a real adjustment`
  );
}

{
  const curves = identityCurves();
  curves.g[200] = 210;
  assert.ok(!areAdjustmentsIdentity({ curves }), 'a bent curve must count as a real adjustment');
}

// ------------------------------------------- 16-bit plane carry / invalidate

function makeImageData(width, height, fill = 0) {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(fill);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width, height, data };
}

const scratch = createAdjustmentLutScratch();
const source = makeImageData(2, 1, 64);
const plane = { width: 2, height: 1, data: new Uint16Array([0x1234, 1, 2, 65535, 0xABCD, 4, 5, 65535]) };
source.__image16 = plane;

const output = makeImageData(2, 1);

applyPreparedAdjustmentsToBuffer(source, { curves: identityCurves() }, output, { lutScratch: scratch });
assert.deepEqual(Array.from(output.data), Array.from(source.data), 'identity must copy pixels through');
assert.equal(output.__image16, plane, 'identity adjustments keep the 16-bit plane');

// The output buffer is reused across renders — a later real adjustment must
// clear the plane rather than let a stale one be exported as "16-bit".
applyPreparedAdjustmentsToBuffer(source, { curves: identityCurves(), exposure: 1 }, output, { lutScratch: scratch });
assert.equal(output.__image16, null, 'a real adjustment must invalidate the 16-bit plane');
assert.equal(output.data[0], 128, 'exposure +1 stop doubles the sample');

// A plane whose dimensions do not match the output is never carried.
const mismatched = makeImageData(2, 1, 64);
mismatched.__image16 = { width: 4, height: 4, data: new Uint16Array(64) };
applyPreparedAdjustmentsToBuffer(mismatched, { curves: identityCurves() }, output, { lutScratch: scratch });
assert.equal(output.__image16, null);

// A source with no plane must not leave a previous one attached.
applyPreparedAdjustmentsToBuffer(source, { curves: identityCurves() }, output, { lutScratch: scratch });
assert.equal(output.__image16, plane);
applyPreparedAdjustmentsToBuffer(makeImageData(2, 1, 64), { curves: identityCurves() }, output, { lutScratch: scratch });
assert.equal(output.__image16, null);

console.log('adjustmentPipeline tests passed');
