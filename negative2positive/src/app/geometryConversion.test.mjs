// processNegative and pending geometry (#244): it converts the planes of the
// current geometry only, never those of a build that an undo or a newer edit
// superseded, and `automatic: false` leaves the automatic measurements alone.
import assert from 'node:assert/strict';
import { createHarness, makeBase, samePixels, exportChain, settle } from './geometryTestHarness.mjs';

const recipe = { rotationAngle: 2.2, mirrored: false, cropRegion: { left: 5, top: 4, width: 44, height: 30 } };

// Waits for the build, then converts the new planes (and measures).
{
  const base = makeBase(64, 48, 31);
  const h = createHarness(base, { realProcessNegative: true }), c = h.context;
  c.restoreSettings(recipe);
  assert.equal(h.state.geometryPending, true);
  await c.processNegative();
  assert.equal(h.conversions.length, 1);
  samePixels(h.conversions[0].source, exportChain(base, recipe), 'the conversion reads the new planes');
  assert.equal(h.target.autoMeasurements, 1);
  await c.processNegative({ automatic: false });
  assert.equal(h.conversions.length, 2);
  assert.equal(h.target.autoMeasurements, 1, 'a rebuild of restored pixels does not re-measure');
}

// A build superseded while processNegative waited is not converted.
{
  const base = makeBase(64, 48, 32);
  const h = createHarness(base, { realProcessNegative: true }), c = h.context;
  const pending = c.processNegative;
  c.restoreSettings(recipe);
  const waiting = pending();
  c.cancelGeometryJob();
  await waiting;
  await settle();
  assert.equal(h.conversions.length, 0, 'the undo (or newer edit) owns the conversion');
  assert.equal(h.state.croppedImageData, null, 'the superseded result never lands');
}

console.log('geometry conversion tests passed');
