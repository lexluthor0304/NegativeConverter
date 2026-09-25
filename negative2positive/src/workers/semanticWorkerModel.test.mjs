import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Run the worker body against a fake ONNX Runtime: the model bytes the page
// posts (a Blob or an ArrayBuffer) reach the session without a fetch, and the
// worker fetches modelUrl only when the page had no copy (#262).
const source = readFileSync(new URL('./semanticWorker.js', import.meta.url), 'utf8').replace(/^import .*$/gm, '');

async function runWorker(message) {
  const sessions = [];
  const fetches = [];
  const ort = {
    env: { wasm: {} },
    Tensor: class { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } },
    InferenceSession: {
      async create(bytes) {
        sessions.push(bytes);
        return {
          async release() {},
          async run() { return { logits: { dims: [1, 150, 64, 64], data: new Float32Array(150 * 64 * 64) } }; },
        };
      },
    },
  };
  const replies = [];
  const self = { postMessage: reply => replies.push(reply) };
  const context = vm.createContext({
    self, console, Float32Array, Uint8Array, Math, Array, navigator: {},
    fetch: async url => { fetches.push(url); return { ok: true, arrayBuffer: async () => Uint8Array.from([9, 9]).buffer }; },
    loadInferenceRuntime: async () => ort,
    defaultInferencePreference: () => 'wasm',
  });
  vm.runInContext(source, context);
  await self.onmessage({ data: { image: { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(128) }, modelUrl: '/m.onnx', preferGpu: false, ...message } });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].error, undefined, replies[0].error);
  assert.equal(sessions.length, 1);
  return { bytes: new Uint8Array(sessions[0]), fetches };
}

{
  const { bytes, fetches } = await runWorker({ model: new Blob([Uint8Array.from([1, 2, 3])]) });
  assert.deepEqual([...bytes], [1, 2, 3], 'the posted Blob is the session model');
  assert.deepEqual(fetches, [], 'no network request for the model');
}
{
  const { bytes, fetches } = await runWorker({ model: Uint8Array.from([4, 5]).buffer });
  assert.deepEqual([...bytes], [4, 5], 'a structured-clone ArrayBuffer also works');
  assert.deepEqual(fetches, []);
}
{
  const { bytes, fetches } = await runWorker({ model: null });
  assert.deepEqual(fetches, ['/m.onnx'], 'without a page copy the worker fetches the model itself');
  assert.deepEqual([...bytes], [9, 9]);
}
console.log('semanticWorker: posted model bytes replace the per-worker fetch');
