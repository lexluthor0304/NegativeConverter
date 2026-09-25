// Standalone Node test for wasmHeap.js (#258).
import assert from 'node:assert/strict';
import { trackWasmMemories, wasmHeapBytes } from './wasmHeap.js';

assert.equal(wasmHeapBytes(), 0);
assert.equal(trackWasmMemories(), true);
assert.equal(trackWasmMemories(), false, 'installed once');

// A memory the runtime creates itself is counted, and stays a real Memory.
const created = new WebAssembly.Memory({ initial: 2, maximum: 8 });
assert.ok(created instanceof WebAssembly.Memory);
assert.equal(wasmHeapBytes(), 2 * 65536);
created.grow(1);
assert.equal(wasmHeapBytes(), 3 * 65536, 'growth is seen');

// An exported memory is counted once instantiate resolves.
// (module (memory (export "mem") 1))
const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 0, 1, 7, 7, 1, 3, 109, 101, 109, 2, 0]);
const { instance } = await WebAssembly.instantiate(bytes);
assert.ok(instance.exports.mem instanceof WebAssembly.Memory);
assert.equal(wasmHeapBytes(), 4 * 65536);
// instantiate(module) resolves with the instance itself.
const module = await WebAssembly.compile(bytes);
await WebAssembly.instantiate(module);
assert.equal(wasmHeapBytes(), 5 * 65536);

console.log('wasmHeap tests passed');
