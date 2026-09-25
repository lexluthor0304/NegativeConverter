import { trackWasmMemories, wasmHeapBytes } from './wasmHeap.js';
import { createInpaintWorkerProcessor } from './aiInpaintWorkerProcessor.js';
// ORT loads lazily, after this: its WASM heap is reported with each reply (#258).
trackWasmMemories();
const process = createInpaintWorkerProcessor({ heapBytes: wasmHeapBytes });
self.onmessage = async ({ data }) => {
  try {
    const { payload, transfers } = await process(data);
    self.postMessage(payload, transfers);
  } catch (error) { self.postMessage({ id: data.id, error: String(error?.message || error) }); }
};
// Bootstrap failures before this handshake can safely use main-thread inference.
// Model creation and inference start only after the client receives readiness.
self.postMessage({ ready: true });
