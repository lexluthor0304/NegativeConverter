import assert from 'node:assert/strict';
import {
  isCrossOriginIsolated, sharedPlanesAvailable, isSharedPlane, allocPlane16, hashPlane,
  guardSharedPlanes, configurePlaneGuard, planeGuardReport, describeRealmIsolation, ISOLATION_PROBE
} from './crossOriginIsolation.js';

const isolated = { crossOriginIsolated: true, SharedArrayBuffer, location: { search: '' } };
const plain = { crossOriginIsolated: false, SharedArrayBuffer, location: { search: '' } };

// ---- state
assert.equal(isCrossOriginIsolated(isolated), true);
assert.equal(isCrossOriginIsolated(plain), false);
assert.equal(isCrossOriginIsolated({}), false, 'undefined is not isolated');
assert.equal(isCrossOriginIsolated(null), false);
assert.equal(isCrossOriginIsolated(), false, 'Node is not isolated');
assert.equal(sharedPlanesAvailable(isolated), true);
assert.equal(sharedPlanesAvailable(plain), false);
assert.equal(sharedPlanesAvailable({ crossOriginIsolated: true, location: { search: '' } }), false, 'no SharedArrayBuffer constructor');
assert.equal(sharedPlanesAvailable({ ...isolated, location: { search: '?lang=en&sharedPlanes=0' } }), false, 'the page kill switch');
assert.equal(sharedPlanesAvailable({ ...isolated, location: { search: '?sharedPlanes=1' } }), true);
assert.deepEqual(describeRealmIsolation({ crossOriginIsolated: true, SharedArrayBuffer, isSecureContext: true }),
  { crossOriginIsolated: true, sharedArrayBuffer: true, secureContext: true });
assert.deepEqual(describeRealmIsolation({}), { crossOriginIsolated: false, sharedArrayBuffer: false, secureContext: false });
assert.equal(typeof ISOLATION_PROBE, 'string');

// ---- allocation
{
  const shared = allocPlane16(12, { shared: true, env: isolated });
  assert.ok(shared instanceof Uint16Array);
  assert.equal(shared.length, 12);
  assert.ok(shared.buffer instanceof SharedArrayBuffer);
  assert.equal(isSharedPlane(shared), true);
  assert.ok(shared.every((v) => v === 0));

  const own = allocPlane16(12, { shared: true, env: plain });
  assert.ok(own.buffer instanceof ArrayBuffer, 'not isolated: a plain plane even when shared is asked for');
  assert.equal(isSharedPlane(own), false);
  assert.ok(allocPlane16(8).buffer instanceof ArrayBuffer, 'default: plain');
  assert.ok(allocPlane16(8, { shared: false, env: isolated }).buffer instanceof ArrayBuffer);
  assert.equal(allocPlane16(0, { shared: true, env: isolated }).length, 0);
  assert.equal(isSharedPlane(null), false);
  assert.equal(isSharedPlane(new SharedArrayBuffer(4)), false, 'a buffer is not a view');
}

// ---- hashing: every byte counts, views and offsets included
{
  const a = new Uint16Array(1001);
  for (let i = 0; i < a.length; i++) a[i] = (i * 2654435761) & 0xFFFF;
  const h = hashPlane(a);
  assert.equal(hashPlane(a), h, 'stable');
  a[1000] ^= 1;
  assert.notEqual(hashPlane(a), h, 'the last (odd, tail) sample changes the hash');
  a[1000] ^= 1;
  a[3] ^= 0x100;
  assert.notEqual(hashPlane(a), h, 'a high byte changes the hash');
  a[3] ^= 0x100;
  assert.equal(hashPlane(a), h);
  const view = new Uint16Array(a.buffer, 2, 10);
  assert.notEqual(hashPlane(view), hashPlane(new Uint16Array(a.buffer, 0, 10)), 'offset views differ');
  assert.equal(hashPlane(view), hashPlane(new Uint16Array(view)), 'an unaligned view hashes its bytes like a copy');
  assert.equal(hashPlane(null), '');
}

// ---- the guard
{
  configurePlaneGuard({ enabled: false });
  const shared = allocPlane16(64, { shared: true, env: isolated });
  const off = guardSharedPlanes('off', [shared]);
  shared[0] = 5;
  assert.equal(off.verify(), true, 'disabled: nothing is checked');
  assert.equal(planeGuardReport().checks, 0);

  configurePlaneGuard({ enabled: true });
  const before = planeGuardReport().violations.length;
  const quiet = guardSharedPlanes('read-only job', [shared, shared, null]);
  assert.equal(quiet.verify(), true);
  assert.equal(planeGuardReport().checks, 1, 'one plane, listed twice, checked once');

  const plainPlane = new Uint16Array(64);
  const ignored = guardSharedPlanes('plain', [plainPlane]);
  plainPlane[1] = 9;
  assert.equal(ignored.verify(), true, 'a plain plane is the worker\'s own copy');

  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    const guard = guardSharedPlanes('writing job', [shared]);
    shared[10] = 77;
    assert.equal(guard.verify(), false, 'a changed shared plane fires the check');
    assert.equal(guard.verify(), true, 'verify reports once');
  } finally {
    console.error = originalError;
  }
  const report = planeGuardReport();
  assert.equal(report.violations.length, before + 1);
  assert.equal(report.violations.at(-1).label, 'writing job');
  assert.equal(report.violations.at(-1).bytes, 128);
  assert.equal(logged.length, 1);

  configurePlaneGuard({ enabled: true, maxBytes: 64 });
  const skippedBefore = planeGuardReport().skipped;
  const big = guardSharedPlanes('big', [shared]);
  shared[11] = 1;
  assert.equal(big.verify(), true, 'above the size cap the plane is skipped');
  assert.equal(planeGuardReport().skipped, skippedBefore + 1);
  configurePlaneGuard({ enabled: null });
}

console.log('crossOriginIsolation tests passed');
