import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Run the worker body against a fake ONNX Runtime and count session runs:
// a WASM session makes exactly one (the real) run; WebGPU keeps its warm-up
// probe, and a failing WebGPU run still falls back to WASM.
const source = readFileSync(new URL('./semanticWorker.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '');

async function runWorker({ gpu, failGpuRun = false }) {
  const runs = [];
  const created = [];
  const ort = {
    env: { wasm: {} },
    Tensor: class { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } },
    InferenceSession: {
      async create(bytes, options) {
        const provider = options.executionProviders[0];
        created.push(provider);
        return {
          async release() {},
          async run(feeds) {
            runs.push({ provider, zero: feeds.image.data.every(value => value === 0) });
            if (failGpuRun && provider === 'webgpu' && runs.length > 1) throw new Error('kernel failed');
            return { logits: { dims: [1, 150, 64, 64], data: new Float32Array(150 * 64 * 64) } };
          }
        };
      }
    }
  };
  const replies = [];
  const self = { postMessage: message => replies.push(message) };
  const context = vm.createContext({
    self, console, Float32Array, Uint8Array, Math, Array,
    navigator: gpu ? { gpu: {} } : {},
    fetch: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }),
    loadInferenceRuntime: async () => ort,
    defaultInferencePreference: () => (gpu ? 'webgpu' : 'wasm'),
  });
  vm.runInContext(source, context);
  await self.onmessage({ data: { image: { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(128) }, modelUrl: '/m.onnx', preferGpu: gpu } });
  return { runs, created, replies };
}

{
  const { runs, created, replies } = await runWorker({ gpu: false });
  assert.deepEqual(created, ['wasm']);
  assert.equal(runs.length, 1, 'a WASM session runs the real inference once, with no warm-up');
  assert.equal(runs[0].zero, false);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].provider, 'wasm');
}
{
  const { runs, created, replies } = await runWorker({ gpu: true });
  assert.deepEqual(created, ['webgpu']);
  assert.deepEqual(runs.map(run => run.zero), [true, false], 'WebGPU keeps the zero-tensor probe before the real run');
  assert.equal(replies[0].provider, 'webgpu');
}
{
  const { runs, created, replies } = await runWorker({ gpu: true, failGpuRun: true });
  assert.deepEqual(created, ['webgpu', 'wasm'], 'a failing WebGPU run rebuilds the session on WASM');
  assert.deepEqual(runs.map(run => run.provider), ['webgpu', 'webgpu', 'wasm']);
  assert.equal(replies[0].provider, 'wasm');
}
console.log('semantic worker: one WASM run without warm-up, WebGPU probe and fallback kept');
