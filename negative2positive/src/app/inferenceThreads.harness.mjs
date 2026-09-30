// Browser harness (smoke only, never imported by the app): ONNX Runtime's
// output at a given WASM thread count (#264 Part A phase 1). ORT fixes its
// thread count per realm, so the smoke runs this once per count, each in a
// worker of its own, and compares what they return:
// - MI-GAN: one 512 px tile of a deterministic scene with a hole, through the
//   app's own session (runnerFor), as uint8 samples;
// - EfficientViT-B1: the semantic model's logits for a deterministic input.
import { loadInferenceRuntime } from './inferenceRuntime.js';
import { createInpaintSession, fetchModelBytes, DEFAULT_MODEL_URL, TILE } from './aiInpaint.js';
import { SEMANTIC_MODEL_URL } from './semanticModel.js';

function scene(width, height, seed) {
  const image = new Float32Array(3 * width * height);
  let s = seed >>> 0;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const base = 0.25 + 0.5 * (x / width) * (1 - 0.3 * Math.sin(y / 17));
      image[i] = Math.min(1, base + 0.05 * rnd());
      image[width * height + i] = Math.min(1, 0.4 + 0.3 * Math.cos(x / 23) * (y / height) + 0.05 * rnd());
      image[2 * width * height + i] = Math.min(1, 0.2 + 0.6 * (y / height) + 0.05 * rnd());
    }
  }
  return image;
}

/**
 * @param {{ threads: number, runs?: number }} options
 * @returns {Promise<{ threads: number, migan: { output: Uint8Array, ms: number[] }, semantic: { logits: Float32Array, ms: number[] } }>}
 */
export async function runInferenceThreadProbe({ threads, runs = 2 } = {}) {
  const ort = await loadInferenceRuntime({ numThreads: threads, preference: 'wasm' });
  const size = TILE;
  const modelBytes = await fetchModelBytes(DEFAULT_MODEL_URL);
  const session = await createInpaintSession(modelBytes, { prefer: 'wasm', warmUp: true, memoBytes: 0 },
    { loadRuntime: async () => ort, backends: () => ({ webgpu: false, wasm: true }) });
  const image = scene(size, size, 11);
  const mask = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - size * 0.55, dy = y - size * 0.45;
      if (dx * dx + dy * dy < (size * 0.12) ** 2 || (Math.abs(y - x) < 3 && x > 60 && x < 300)) mask[y * size + x] = 1;
    }
  }
  const miganMs = [];
  let output = null;
  for (let run = 0; run < runs; run++) {
    const started = performance.now();
    const result = await session.run(image, mask, size, { insert: false });
    miganMs.push(Math.round(performance.now() - started));
    output = Uint8Array.from(result, (value) => Math.round(value * 255));
  }
  await session.release();

  const semanticBytes = await (await fetch(SEMANTIC_MODEL_URL)).arrayBuffer();
  const semantic = await ort.InferenceSession.create(semanticBytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  const input = scene(512, 512, 23).map((value) => (value - 0.45) / 0.226);
  const semanticMs = [];
  let logits = null;
  for (let run = 0; run < runs; run++) {
    const started = performance.now();
    const result = await semantic.run({ image: new ort.Tensor('float32', input, [1, 3, 512, 512]) });
    semanticMs.push(Math.round(performance.now() - started));
    logits = new Float32Array(result.logits.data);
  }
  await semantic.release();
  return { threads: ort.env.wasm.numThreads, migan: { output, ms: miganMs }, semantic: { logits, ms: semanticMs } };
}

/** Differences between two probes' outputs. */
export function compareInferenceProbes(a, b) {
  let miganSamples = 0, miganMax = 0;
  for (let i = 0; i < a.migan.output.length; i++) {
    const d = Math.abs(a.migan.output[i] - b.migan.output[i]);
    if (d) { miganSamples++; miganMax = Math.max(miganMax, d); }
  }
  let logitValues = 0, logitMax = 0;
  for (let i = 0; i < a.semantic.logits.length; i++) {
    const d = Math.abs(a.semantic.logits[i] - b.semantic.logits[i]);
    if (d) { logitValues++; logitMax = Math.max(logitMax, d); }
  }
  // The label maps the worker derives (argmax over 150 classes per cell).
  let labelCells = 0;
  const cells = a.semantic.logits.length / 150;
  for (let pos = 0; pos < cells; pos++) {
    let bestA = 0, bestB = 0;
    for (let c = 1; c < 150; c++) {
      if (a.semantic.logits[c * cells + pos] > a.semantic.logits[bestA * cells + pos]) bestA = c;
      if (b.semantic.logits[c * cells + pos] > b.semantic.logits[bestB * cells + pos]) bestB = c;
    }
    if (bestA !== bestB) labelCells++;
  }
  return {
    migan: { samples: a.migan.output.length, differing: miganSamples, maxDifference: miganMax },
    semantic: { values: a.semantic.logits.length, differing: logitValues, maxDifference: logitMax, labelCellsDiffering: labelCells }
  };
}
