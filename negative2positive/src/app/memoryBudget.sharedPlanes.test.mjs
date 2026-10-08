import assert from 'node:assert/strict';
import { createRetainedLedger } from './memoryBudget.js';
import { backingBuffers } from './photoSessionCache.js';

// #264: a 16-bit plane in shared memory is one allocation however many
// holders see it. The ledger (#258) counts its SharedArrayBuffer once, first
// for the editor, like an ArrayBuffer; the workers that read it hold views,
// not copies, and report no bytes for it.
const plane = new Uint16Array(new SharedArrayBuffer(1000 * 4 * 2));
const frame = { width: 1000, height: 1, data: new Uint8ClampedArray(4000), __image16: { width: 1000, height: 1, data: plane } };
const crop = { width: 500, height: 1, data: new Uint8ClampedArray(2000), __image16: { width: 500, height: 1, data: plane.subarray(0, 2000) } };
assert.ok(backingBuffers(frame).has(plane.buffer), 'a shared plane is a backing buffer');
const ledger = createRetainedLedger([
  { name: 'editor', roots: () => [frame] },
  { name: 'sessions', roots: () => [{ base: frame, crop }] },
  { name: 'history', roots: () => [crop] },
  { name: 'workers', bytes: () => 0 }
]);
const { total, breakdown } = ledger.measure();
assert.equal(breakdown.editor, 8000 + 4000, 'the editor holds the shared plane and its 8-bit plane');
assert.equal(breakdown.sessions, 2000, 'the session adds only the crop\'s own 8-bit plane');
assert.equal(breakdown.history, 0);
assert.equal(total, 14000, 'the shared plane is counted once');
console.log('memory ledger: a shared plane is counted once');
