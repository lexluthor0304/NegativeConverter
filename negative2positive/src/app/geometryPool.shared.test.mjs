// Geometry pool with a shared base (#264 Part A phase 2): the bands read the
// base's rows through views of its shared 16-bit plane and write their 16-bit
// rows into the shared output in place, so neither 16-bit plane is copied on
// the main thread; index plans derive their 8-bit source rows in the worker
// when the base's 8-bit plane is its 16-bit one >>> 8. The output equals the
// synchronous core byte for byte and is marked derived; the base is only read.
import assert from 'node:assert/strict';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const { planGeometry, renderGeometry } = await import('./imageGeometry.js');
const { createGeometryPool, runGeometryBand } = await import('./geometryPool.js');
const { isSharedPlane, markDerivedEightBit, hasDerivedEightBit, hashPlane, configurePlaneGuard, planeGuardReport } = await import('./crossOriginIsolation.js');

configurePlaneGuard({ enabled: true });
const isolated = Object.getOwnPropertyDescriptor(globalThis, 'crossOriginIsolated');
Object.defineProperty(globalThis, 'crossOriginIsolated', { value: true, configurable: true, writable: true });

function makeSource(width, height, { shared = true, derived = true } = {}) {
  let s = 7;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s; };
  const data16 = shared ? new Uint16Array(new SharedArrayBuffer(width * height * 8)) : new Uint16Array(width * height * 4);
  for (let i = 0; i < data16.length; i++) data16[i] = (i & 3) === 3 ? 65535 : rnd() % 65536;
  const image = new ImageData(Uint8ClampedArray.from(data16, (v) => v >>> 8), width, height);
  image.__image16 = { width, height, data: data16 };
  if (derived) markDerivedEightBit(image);
  return image;
}
const bytes = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

const posted = [];
function workerFactory() {
  const worker = {
    postMessage(message, transfers) {
      // A shared buffer in a transfer list would throw here, as in a browser.
      const copy = structuredClone(message, { transfer: transfers });
      posted.push({ src: copy.src, out16: Boolean(copy.out16), transfers: transfers.length });
      setTimeout(() => {
        const { payload, transfers: back } = runGeometryBand(copy);
        worker.onmessage?.({ data: structuredClone(payload, { transfer: back }) });
      }, 1);
    },
    terminate() {}
  };
  return worker;
}

const W = 311, H = 197;
const geometries = {
  crop: { cropRegion: { left: 20, top: 11, width: 240, height: 150 } },
  'rotate 90 + mirror': { rotationAngle: 90, mirrored: true },
  'fine rotation + crop': { rotationAngle: 2.7, cropRegion: { left: 30, top: 20, width: 200, height: 120 } }
};
for (const derived of [true, false]) {
  for (const [name, geometry] of Object.entries(geometries)) {
    const base = makeSource(W, H, { derived });
    const baseHash = hashPlane(base.__image16.data);
    const plan = planGeometry(base, geometry);
    const expected = renderGeometry(makeSource(W, H, { shared: false, derived }), plan);
    posted.length = 0;
    const pool = createGeometryPool({ workerFactory, workersSupported: true, size: 3 });
    const output = await pool.render(base, plan, { bands: 4, shared: true });
    const label = `${name}${derived ? '' : ' (8-bit not derived)'}`;
    assert.ok(isSharedPlane(output.__image16.data), `${label}: shared output`);
    assert.ok(bytes(output.__image16.data).equals(bytes(expected.__image16.data)), `${label}: 16-bit`);
    assert.ok(bytes(output.data).equals(bytes(expected.data)), `${label}: 8-bit`);
    assert.equal(hasDerivedEightBit(output), derived, `${label}: derived mark`);
    assert.equal(hashPlane(base.__image16.data), baseHash, `${label}: the base was only read`);
    assert.ok(posted.length >= 2);
    for (const band of posted) {
      assert.ok(band.src.shared16 && !band.src.data16, `${label}: the band read a view of the base`);
      assert.ok(band.out16, `${label}: the band wrote into the shared output`);
      if (plan.kind === 'index') assert.equal(Boolean(band.src.data8), !derived, `${label}: 8-bit rows ${derived ? 'derived' : 'copied'}`);
      assert.equal(band.transfers, band.src.data8 ? 1 : 0);
    }
    pool.dispose();
  }
}

// A plain base in a pool asked for a shared output: bands are sliced as
// before; the output plane is shared and the bytes are the same.
{
  const base = makeSource(W, H, { shared: false });
  const plan = planGeometry(base, geometries.crop);
  posted.length = 0;
  const pool = createGeometryPool({ workerFactory, workersSupported: true, size: 2 });
  const output = await pool.render(base, plan, { bands: 3, shared: true });
  assert.ok(isSharedPlane(output.__image16.data));
  assert.ok(bytes(output.__image16.data).equals(bytes(renderGeometry(base, plan).__image16.data)));
  assert.ok(posted.every((band) => band.src.data16 && !band.out16), 'a plain base is sliced');
  pool.dispose();
}

// The display level of a shared frame (#248 levels, #264): shared too, from
// the pool's bands and from the level builder, with the same samples as a
// plain one; a plain frame keeps a plain level.
{
  const { buildDisplayLevel } = await import('./displayPreview.js');
  const big = { crop: { cropRegion: { left: 10, top: 6, width: 2600, height: 1500 } } };
  const base = makeSource(2800, 1700);
  const plan = planGeometry(base, big.crop);
  const pool = createGeometryPool({ workerFactory, workersSupported: true, size: 2 });
  const output = await pool.render(base, plan, { bands: 2, level: 2, shared: true });
  const level = output.__displayLevel;
  assert.ok(level && isSharedPlane(level.__image16.data), 'the pool builds a shared level for a shared frame');
  const plainLevel = buildDisplayLevel(renderGeometry(makeSource(2800, 1700, { shared: false }), plan), 2);
  assert.ok(!isSharedPlane(plainLevel.__image16.data), 'a plain frame gets a plain level');
  assert.ok(bytes(level.__image16.data).equals(bytes(plainLevel.__image16.data)), 'the same level samples');
  const built = buildDisplayLevel(output, 2);
  assert.ok(isSharedPlane(built.__image16.data), 'the level builder shares the level of a shared frame');
  assert.ok(bytes(built.__image16.data).equals(bytes(plainLevel.__image16.data)));
  pool.dispose();
}

assert.equal(planeGuardReport().violations.length, 0);
if (isolated) Object.defineProperty(globalThis, 'crossOriginIsolated', isolated);
else delete globalThis.crossOriginIsolated;
configurePlaneGuard({ enabled: null });
console.log('geometry pool: a shared base is read through views and the shared output written in place');
