// The WebAssembly memories this realm creates (#258): a worker reports their
// size with each reply, so the page's memory ledger can count its WASM heap.
// ONNX Runtime's Emscripten module creates its memory with
// `new WebAssembly.Memory` (the threaded build) or exports it from
// `instantiate`; nothing else exposes it. Install before the runtime loads.

const memories = new Set();

function collect(result) {
  const instance = result?.instance || result;
  for (const value of Object.values(instance?.exports || {})) {
    if (value instanceof WebAssembly.Memory) memories.add(value);
  }
  return result;
}

export function trackWasmMemories(wasm = globalThis.WebAssembly) {
  if (!wasm || wasm.__ncTrackedMemories) return false;
  const NativeMemory = wasm.Memory;
  if (typeof NativeMemory === 'function') {
    // Returning the native object from a constructor keeps `instanceof` and
    // every method; only the registry is added.
    const Memory = function Memory(descriptor) {
      const memory = new NativeMemory(descriptor);
      memories.add(memory);
      return memory;
    };
    Memory.prototype = NativeMemory.prototype;
    wasm.Memory = Memory;
  }
  for (const name of ['instantiate', 'instantiateStreaming']) {
    const native = wasm[name];
    if (typeof native !== 'function') continue;
    wasm[name] = function (...args) { return native.apply(this, args).then(collect); };
  }
  Object.defineProperty(wasm, '__ncTrackedMemories', { value: true });
  return true;
}

/** Bytes of every tracked WebAssembly memory now (they only grow). */
export function wasmHeapBytes() {
  let bytes = 0;
  for (const memory of memories) {
    try { bytes += memory.buffer.byteLength; } catch { /* a detached memory counts as 0 */ }
  }
  return bytes;
}
