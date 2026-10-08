// #238 (2) + (5): a forceFullProcess conversion allocates at most one 8 B/px work plane
// plus the 8-bit output — no pristine copy, no second clone, no grey plane. Counts
// typed-array allocations of plane size through counting subclasses installed before
// any module loads (so every array the adapter creates goes through them).
import assert from 'node:assert/strict';

const W = 300, H = 240, PLANE = W * H * 4;
let planes16 = 0, planes8 = 0, greyPlanes = 0;
const fresh = (args) => !(args[0] instanceof ArrayBuffer || args[0] instanceof SharedArrayBuffer);
globalThis.Uint16Array = class extends Uint16Array {
  constructor(...args) {
    super(...args);
    if (fresh(args) && this.length === PLANE) planes16++;
    if (fresh(args) && this.length === W * H) greyPlanes++;
  }
};
globalThis.Uint8ClampedArray = class extends Uint8ClampedArray {
  constructor(...args) {
    super(...args);
    if (fresh(args) && this.length === PLANE) planes8++;
  }
};
globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };

const live = await import('./silverAdapter.js');
const oracle = await import('./oracle/silverAdapter.oracle.js');
const { sanitizeFlatFieldMap } = await import('../app/flatField.js');

function source() {
  const data = new Uint16Array(PLANE);
  for (let p = 0; p < W * H; p++) data.set([40000 - (p % 977) * 20, 30000 - (p % 613) * 25, 20000 - (p % 401) * 30, 65535], p * 4);
  return { width: W, height: H, data };
}
const flatField = {
  flatField: sanitizeFlatFieldMap({ id: 'pad', width: 2, height: 2, gains: [1, 1.1, 1.2, 1.05, 1, 1.1, 1.2, 1.3, 1, 1, 1.1, 1.2] }),
  flatFieldGeometry: { baseWidth: W, baseHeight: H, rotatedWidth: W, rotatedHeight: H, rotationAngle: 0, mirrored: false, cropRegion: null },
};
const CONVERT = { color: 'convertColorWithSilverCore', bw: 'convertBwWithSilverCore', positive: 'convertPositiveWithSilverCore' };

async function count(adapter, mode, image, settings) {
  planes16 = planes8 = greyPlanes = 0;
  await adapter[CONVERT[mode]](image, settings, { forceFullProcess: true });
  return { planes16, planes8, greyPlanes };
}

const src = source();
const src8 = new ImageData(Uint8ClampedArray.from(src.data, (v) => v >>> 8), W, H);
planes8 = 0;
const filmBase = { filmBase: { r: 210, g: 140, b: 90 }, colorModel: 'standard' };
for (const [mode, image, settings, label] of [
  ['color', src, filmBase, 'colour + film base: the clone is the only plane'],
  ['color', src, { ...filmBase, ...flatField }, 'colour + flat field'],
  ['color', src8, filmBase, '8-bit source: the promotion is the work plane'],
  ['positive', src, { positiveMode: 'correct' }, 'positive'],
  ['bw', src, {}, 'B&W: output written directly, no clone, no grey plane'],
  ['bw', src, flatField, 'B&W + flat field: the clone takes the output in place'],
  ['bw', src8, {}, 'B&W 8-bit: the promotion takes the output in place'],
]) {
  live.invalidateSilverCoreCache();
  await live[CONVERT[mode]](image, settings, { preview: true }); // a warm slot must not matter
  assert.deepEqual(await count(live, mode, image, settings), { planes16: 1, planes8: 1, greyPlanes: 0 }, label);
}
// The oracle (1703835) paid a pristine copy and a clone for film-base conversions.
oracle.invalidateSilverCoreCache();
assert.deepEqual(await count(oracle, 'color', src, filmBase), { planes16: 2, planes8: 1, greyPlanes: 0 }, 'counter sanity check');
live.invalidateSilverCoreCache();
oracle.invalidateSilverCoreCache();
console.log('silverAdapter.memory: forced conversions allocate one 16-bit work plane and the 8-bit output');
