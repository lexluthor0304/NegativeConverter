import assert from 'node:assert/strict';
import {
  isCrossOriginIsolated, sharedMemoryAvailable, sharedPlanesAvailable, isSharedPlane, allocPlane16, hashPlane, hashPlaneSample,
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
assert.equal(sharedMemoryAvailable(isolated), true);
assert.equal(sharedMemoryAvailable({ crossOriginIsolated: true }), false, 'WKWebView: isolated without SharedArrayBuffer');
assert.equal(sharedMemoryAvailable(plain), false);
assert.equal(sharedPlanesAvailable({ crossOriginIsolated: true }), false);
assert.equal(allocPlane16(4, { shared: true, env: { crossOriginIsolated: true } }).buffer instanceof ArrayBuffer, true);
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

// ---- the guard's page sample: whole up to the budget, every stride-th 4 KB page above
{
  const plane = new Uint16Array(64 * 1024 / 2); // 64 KB = 16 pages
  for (let i = 0; i < plane.length; i++) plane[i] = (i * 40503) & 0xFFFF;
  assert.equal(hashPlaneSample(plane, 64 * 1024), hashPlane(plane), 'within the budget: the whole plane');
  assert.equal(hashPlaneSample(plane), hashPlane(plane), 'no budget: the whole plane');
  // A 16 KB budget reads 4 pages' worth: stride 4, pages 0, 4, 8, 12 and the last (15).
  const h = hashPlaneSample(plane, 16 * 1024);
  assert.notEqual(h, hashPlane(plane));
  assert.equal(hashPlaneSample(plane, 16 * 1024), h, 'the same pages every time');
  const word = (page, offset = 0) => page * 2048 + offset;
  plane[word(1, 5)] ^= 1;
  assert.equal(hashPlaneSample(plane, 16 * 1024), h, 'a write inside an unsampled page is not seen (documented)');
  plane[word(1, 5)] ^= 1;
  for (const page of [0, 4, 12, 15]) {
    plane[word(page, 7)] ^= 0x100;
    assert.notEqual(hashPlaneSample(plane, 16 * 1024), h, `a write in sampled page ${page} is seen`);
    plane[word(page, 7)] ^= 0x100;
  }
  // Any write spanning `stride` pages touches a sampled one.
  for (let first = 0; first + 4 <= 16; first++) {
    const saved = plane.slice(word(first), word(first + 4));
    plane.fill(7, word(first), word(first + 4));
    assert.notEqual(hashPlaneSample(plane, 16 * 1024), h, `a 4-page write from page ${first} is seen`);
    plane.set(saved, word(first));
  }
  assert.equal(hashPlaneSample(plane, 16 * 1024), h);
  // Unaligned views sample the same bytes as a copy of them.
  const bytes = new Uint8Array(40 * 1024 + 3);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 131) & 0xFF;
  const unaligned = new Uint8Array(bytes.buffer, 1, bytes.length - 1);
  assert.equal(hashPlaneSample(unaligned, 8 * 1024), hashPlaneSample(new Uint8Array(unaligned), 8 * 1024));
  assert.equal(hashPlaneSample(null, 16), '');
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

  // Above `fullBytes` a plane is sampled, not skipped: a band-sized write is seen.
  const large = allocPlane16(64 * 1024 / 2, { shared: true, env: isolated });
  configurePlaneGuard({ enabled: true, fullBytes: 16 * 1024 });
  const sampledBefore = planeGuardReport().sampled;
  const originalError2 = console.error;
  console.error = () => {};
  try {
    const band = guardSharedPlanes('band write', [large]);
    large.fill(3, 2048 * 5, 2048 * 9);
    assert.equal(band.verify(), false, 'a write spanning the stride is seen in a sampled plane');
  } finally {
    console.error = originalError2;
  }
  assert.equal(planeGuardReport().sampled, sampledBefore + 1);
  configurePlaneGuard({ enabled: null });
}

console.log('crossOriginIsolation tests passed');

// Lens resampling writes a private shared output fully before publishing it;
// subsequent full conversions post that same buffer without a 16-bit clone.
{
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const { createConversionWorkerClient } = await import('./conversionWorkerClient.js');
  const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
  const fn = name => { const match = new RegExp(`^    function ${name}\\(`, 'm').exec(source);
    assert.ok(match, name); return source.slice(match.index, source.indexOf('\n    }', match.index) + 6); };
  class TestImageData {
    constructor(data, width, height) { Object.assign(this, { data, width, height }); }
  }
  const beforeIsolation = globalThis.crossOriginIsolated, beforeLocation = globalThis.location, beforeImage = globalThis.ImageData;
  globalThis.crossOriginIsolated = true;
  globalThis.location = { search: '' };
  globalThis.ImageData = TestImageData;
  const context = vm.createContext({ ImageData: TestImageData, Uint16Array, Uint8ClampedArray, Math,
    allocPlane16, isSharedPlane, sharedPlanesAvailable, clampBetween: (value, min, max) => Math.max(min, Math.min(max, value)) });
  vm.runInContext(['bilerp', 'sampleImageChannelBilinear', 'sampleGridPair', 'sampleGridTriple', 'sampleGridTca', 'applyLensMapsToImage'].map(fn).join('\n'), context);
  const width = 9, height = 7, length = width * height * 4;
  const plane = allocPlane16(length, { shared: true });
  for (let i = 0; i < length; i++) plane[i] = i % 4 === 3 ? 65535 : (i * 7919) & 65535;
  const image = new TestImageData(Uint8ClampedArray.from(plane, value => value >>> 8), width, height);
  image.__image16 = { width, height, data: plane };
  const geometry = new Float32Array(width * height * 2);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) geometry.set([x + 0.2, y + 0.35], (y * width + x) * 2);
  const maps = { gridWidth: width, gridHeight: height, step: 1, geometry };
  let client;
  try {
    const corrected = context.applyLensMapsToImage(image, maps, {});
    assert.ok(isSharedPlane(corrected.__image16.data), 'lens output remains shared');
    const plainInput = { ...image, __image16: { width, height, data: new Uint16Array(plane) } };
    const copied = context.applyLensMapsToImage(plainInput, maps, {});
    assert.deepEqual(corrected.__image16.data, copied.__image16.data, 'allocation changes no lens pixels');
    let posted;
    const worker = { postMessage(message) { posted = message;
      queueMicrotask(() => worker.onmessage({ data: { type: 'result', id: message.id, width, height,
        rgba: corrected.data.slice().buffer, image16: corrected.__image16.data.buffer } })); }, terminate() {} };
    client = createConversionWorkerClient({ workerFactory: () => worker });
    await client({ imageData: corrected, settings: { filmType: 'color' }, options: { forceFullProcess: true } });
    assert.equal(posted.image16, corrected.__image16.data.buffer, 'fake worker receives the original shared lens buffer');
    globalThis.location.search = '?sharedPlanes=0';
    assert.ok(context.applyLensMapsToImage(image, maps, {}).__image16.data.buffer instanceof ArrayBuffer, 'lens also honors the page kill switch');
  } finally {
    client?.dispose(); globalThis.crossOriginIsolated = beforeIsolation;
    globalThis.location = beforeLocation; globalThis.ImageData = beforeImage;
  }
}
