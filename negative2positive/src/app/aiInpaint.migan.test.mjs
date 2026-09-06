import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runnerFor } from './aiInpaint.js';

// Catch model replacement, missing packaged assets and incompatible IO changes.
const bytes = readFileSync(new URL('../../public/models/migan_pipeline_v2.onnx', import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'),
  '6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b');

let disposed = 0;
class Tensor {
  constructor(type, data, dims) { Object.assign(this, { type, data, dims }); }
  dispose() { disposed++; }
}
let calls = 0;
const session = {
  inputNames: ['mask', 'image'], // Never depend on graph input ordering.
  outputNames: ['result'],
  async run(feeds) {
    calls++;
    assert.equal(feeds.image.type, 'uint8');
    assert.deepEqual(feeds.image.dims, [1, 3, 2, 2]);
    assert.deepEqual([...feeds.image.data], [0, 128, 255, 64, 0, 128, 255, 64, 0, 128, 255, 64]);
    assert.equal(feeds.mask.type, 'uint8');
    assert.deepEqual([...feeds.mask.data], [255, 0, 255, 0]);
    return { result: new Tensor('uint8', new Uint8Array(12).fill(1), [1, 3, 2, 2]) };
  }
};
const run = runnerFor({ Tensor }, session);
const image = new Float32Array([0, 0.5, 1, 0.25, 0, 0.5, 1, 0.25, 0, 0.5, 1, 0.25]);
const original = image.slice();
const output = await run(image, new Float32Array([0, 1, 0, 1]), 2);
assert.ok(Math.abs(output[0] - 1 / 255) < 1e-8, 'near-black uint8 output must not become white');
assert.equal(disposed, 3);
assert.deepEqual(image, original);
assert.deepEqual(await run(image, new Float32Array(4), 2), image);
assert.equal(calls, 1, 'empty mask skips inference');
await assert.rejects(run(image, new Float32Array(3), 2), RangeError);
assert.throws(() => runnerFor({ Tensor }, { inputNames: ['image', 'mask'], outputNames: ['output'] }), /MI-GAN/);

session.run = async () => { throw new Error('GPU failed'); };
await assert.rejects(run(image, new Float32Array([0, 1, 0, 1]), 2), /GPU failed/);
assert.equal(disposed, 5, 'release inputs even on inference failure');
session.run = async () => ({ result: new Tensor('float32', new Float32Array(12), [1, 3, 2, 2]) });
await assert.rejects(run(image, new Float32Array([0, 1, 0, 1]), 2), /Invalid MI-GAN output/);
assert.equal(disposed, 8);
console.log('MI-GAN asset and tensor contract tests passed');
