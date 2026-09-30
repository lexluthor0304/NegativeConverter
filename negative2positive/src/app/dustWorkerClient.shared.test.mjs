import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
globalThis.ImageData ||= class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
const { createDustWorkerClient } = await import('./dustWorkerClient.js');
const { markDerivedEightBit, configurePlaneGuard, planeGuardReport } = await import('./crossOriginIsolation.js');
const { createDustWorkerProcessor } = await import('../workers/dustWorkerProcessor.js');
const { detectDust, inpaintMasked } = await import('../silvercore/engine/DustRemoval.js');
const require = createRequire(import.meta.url);
globalThis.cv = await require('@techstark/opencv-js');

// #264 Part A phase 2: the dust worker gets a shared 16-bit plane whole,
// without slices, copies or transfers, and makes its 8-bit source from it
// when the frame's 8-bit plane is that plane >>> 8. Its detections and
// repairs are the ones the copied planes give.
configurePlaneGuard({ enabled: true });
const width = 96, height = 64;
const shared16 = new Uint16Array(new SharedArrayBuffer(width * height * 8));
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const p = (y * width + x) * 4;
  const v = ((x * 7 + y * 3) % 40 + 70) * 257 + (x % 3);
  shared16[p] = shared16[p + 1] = shared16[p + 2] = v; shared16[p + 3] = 65535;
}
for (const [cx, cy] of [[40, 30], [10, 10], [70, 50]]) {
  for (let y = cy; y < cy + 3; y++) for (let x = cx; x < cx + 3; x++) {
    const p = (y * width + x) * 4; shared16[p] = shared16[p + 1] = shared16[p + 2] = 64250;
  }
}
const image = new ImageData(Uint8ClampedArray.from(shared16, (v) => v >>> 8), width, height);
image.__image16 = { width, height, data: shared16 };
markDerivedEightBit(image);

// A worker that runs the real processor, posting through structuredClone
// with the client's transfer lists (a shared buffer there would throw).
const posted = [];
const client = createDustWorkerClient({ workerFactory: () => {
  const processor = createDustWorkerProcessor();
  return {
    postMessage(message, transfers) {
      posted.push({ message, transfers });
      const cloned = structuredClone(message, { transfer: transfers });
      processor(cloned).then(({ payload, transfers: back }) => this.onmessage({ data: structuredClone(payload, { transfer: back }) }),
        (error) => this.onmessage({ data: { id: message.id, error: String(error?.message || error) } }));
    },
    terminate() {}
  };
} });

const direct = detectDust(image, { strength: 5 });
const detected = await client.detect(image, { strength: 5 });
assert.deepEqual(detected.mask, direct.mask, 'the worker\'s detection on its derived 8-bit source');
{
  const { message, transfers } = posted[0];
  assert.equal(message.derive8, true);
  assert.equal(message.rgba, undefined, 'no 8-bit copy');
  assert.ok(message.image16.buffer instanceof SharedArrayBuffer && message.image16 === shared16, 'the shared plane itself');
  assert.deepEqual(transfers, []);
}
const repaired = await client.inpaint(image, direct.mask, 3);
const expected = inpaintMasked(image, direct.mask, 3);
assert.deepEqual([...repaired.__image16.data], [...expected.__image16.data], 'the repair of the shared source');
assert.deepEqual([...repaired.data], [...expected.data]);
assert.ok(!(repaired.__image16.data.buffer instanceof SharedArrayBuffer), 'the repair is a plane of its own');

// Pinned (brush strokes): the seed is one whole-plane message, no slices.
posted.length = 0;
const other = new ImageData(new Uint8ClampedArray(image.data), width, height);
other.__image16 = { width, height, data: shared16 };
markDerivedEightBit(other);
await client.pin(other);
assert.equal(posted.length, 1, 'one message seeds both planes');
assert.equal(posted[0].message.type, 'plane');
assert.equal(posted[0].message.kind, 'image16');
assert.equal(posted[0].message.derive8, true);
assert.equal(posted[0].message.chunk, shared16);
assert.deepEqual(posted[0].transfers, []);
client.unpin();
client.dispose();

const guard = planeGuardReport();
assert.equal(guard.violations.length, 0);
assert.ok(guard.checks >= 3);
configurePlaneGuard({ enabled: null });
console.log('dust worker client: shared planes go whole and derive the 8-bit source');
