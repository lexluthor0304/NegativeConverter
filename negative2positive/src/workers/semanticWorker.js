import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url';
ort.env.wasm.wasmPaths = { 'ort-wasm-simd-threaded.jsep.wasm': wasmUrl };
ort.env.wasm.numThreads = 1;
let session, bytes, provider;
async function create(preferGpu) {
  if (session) await session.release().catch(() => {});
  provider = preferGpu && navigator.gpu ? 'webgpu' : 'wasm';
  session = await ort.InferenceSession.create(bytes, { executionProviders: provider === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'], graphOptimizationLevel: 'all' });
  await session.run({ image: new ort.Tensor('float32', new Float32Array(3 * 512 * 512), [1, 3, 512, 512]) });
}
self.onmessage = async ({ data: { image, modelUrl } }) => {
  try {
    if (!bytes) { const response = await fetch(modelUrl); if (!response.ok) throw new Error('Semantic model unavailable'); bytes = await response.arrayBuffer(); }
    if (!session) { try { await create(true); } catch { await create(false); } }
    const scale = Math.min(512 / image.width, 512 / image.height);
    const w = Math.round(image.width * scale), h = Math.round(image.height * scale);
    const left = Math.floor((512 - w) / 2), top = Math.floor((512 - h) / 2);
    const input = new Float32Array(3 * 512 * 512);
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const xx = Math.min(image.width - 1, Math.floor((x + 0.5) / scale));
      const yy = Math.min(image.height - 1, Math.floor((y + 0.5) / scale));
      for (let c = 0; c < 3; c++) input[c * 512 * 512 + (y + top) * 512 + x + left] = (image.data[(yy * image.width + xx) * 4 + c] / 255 - mean[c]) / std[c];
    }
    const feeds = { image: new ort.Tensor('float32', input, [1, 3, 512, 512]) };
    let output;
    try { output = await session.run(feeds); }
    catch (error) { if (provider === 'wasm') throw error; await create(false); output = await session.run(feeds); }
    const logits = output.logits;
    if (logits.dims.join(',') !== '1,150,64,64') throw new Error('Semantic output contract mismatch');
    const labels = new Uint8Array(64 * 64); let confidence = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const xx = Math.min(63, Math.floor((left + (x + 0.5) * w / 64) / 8));
      const yy = Math.min(63, Math.floor((top + (y + 0.5) * h / 64) / 8));
      const pos = yy * 64 + xx;
      let best = 0, max = -Infinity;
      for (let c = 0; c < 150; c++) if (logits.data[c * 4096 + pos] > max) { best = c; max = logits.data[c * 4096 + pos]; }
      let sum = 0; for (let c = 0; c < 150; c++) sum += Math.exp(logits.data[c * 4096 + pos] - max);
      const probability = 1 / sum; labels[y * 64 + x] = probability >= 0.55 ? best : 255; confidence += probability;
    }
    self.postMessage({ width: 64, height: 64, labels: Array.from(labels), confidence: confidence / 4096, provider });
  } catch (error) { self.postMessage({ error: error.message }); }
};
