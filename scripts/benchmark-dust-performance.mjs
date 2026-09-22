// Reproducible OpenCV dust benchmark. Node workers exercise the same processor
// as the browser worker; browser smoke separately verifies its Vite entry.
// Usage: node scripts/benchmark-dust-performance.mjs [width] [height]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { detectDust } from '../negative2positive/src/silvercore/engine/DustRemoval.js';
const require = createRequire(import.meta.url);
globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
globalThis.cv = await require('@techstark/opencv-js');
const width = Number(process.argv[2]) || 2048, height = Number(process.argv[3]) || 1536;
const source = new ImageData(new Uint8ClampedArray(width * height * 4).fill(100), width, height);
for (let y = Math.floor(height / 2); y < Math.floor(height / 2) + 3; y++) {
  for (let x = Math.floor(width / 2); x < Math.floor(width / 2) + 3; x++) {
    const p = (y * width + x) * 4; source.data[p] = source.data[p + 1] = source.data[p + 2] = 250;
  }
}
async function measure(run) {
  let last = performance.now(), maxHeartbeatGapMs = 0;
  const timer = setInterval(() => {
    const now = performance.now(); maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, now - last); last = now;
  }, 5);
  await new Promise(resolve => setTimeout(resolve, 10));
  const start = performance.now();
  const result = await run();
  const elapsedMs = performance.now() - start;
  await new Promise(resolve => setTimeout(resolve, 10));
  clearInterval(timer);
  return { result, elapsedMs: Math.round(elapsedMs), maxHeartbeatGapMs: Math.round(maxHeartbeatGapMs) };
}
const direct = await measure(() => detectDust(source, { strength: 3 }));
const worker = new Worker(`
  const { parentPort, workerData } = require('node:worker_threads');
  (async () => {
    globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
    globalThis.cv = await require(workerData.opencvPath);
    const { createDustWorkerProcessor } = await import(workerData.processorUrl);
    const process = createDustWorkerProcessor();
    parentPort.on('message', async (message) => {
      const { payload, transfers } = await process(message);
      parentPort.postMessage(payload, transfers);
    });
    parentPort.postMessage({ ready: true });
  })().catch(error => { throw error; });
`, { eval: true, workerData: {
  opencvPath: require.resolve('@techstark/opencv-js'),
  processorUrl: new URL('../negative2positive/src/workers/dustWorkerProcessor.js', import.meta.url).href
} });
try {
  await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  const offThread = await measure(() => new Promise((resolve, reject) => {
    worker.once('message', resolve); worker.once('error', reject);
    const rgba = source.data.slice();
    worker.postMessage({ id: 1, type: 'detect', width, height, rgba, strength: 3 }, [rgba.buffer]);
  }));
  assert.deepEqual(offThread.result.mask, direct.result.mask);
  assert.equal(offThread.result.particleCount, direct.result.particleCount);
  const summarize = ({ elapsedMs, maxHeartbeatGapMs }) => ({ elapsedMs, maxHeartbeatGapMs });
  console.log(JSON.stringify({ width, height, direct: summarize(direct), worker: summarize(offThread),
    particles: direct.result.particleCount,
    identicalMaskSha256: createHash('sha256').update(direct.result.mask).digest('hex'),
    integralBytesBefore: (width + 1) * (height + 1) * 8,
    integralBytesAfter: (width + 1) * (height + 1) * 4 }, null, 2));
} finally { await worker.terminate(); }
