// Optional baseline checkout: node scripts/performance-io-benchmark.mjs /path/to/baseline
// Synthetic fixtures isolate scheduling, I/O and codecs; they are not camera
// RAW timings or claims about every real photograph.
import { Worker as NodeWorker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflate } from 'pako';
import { loadPngFile } from '../negative2positive/src/app/pngFileLoader.js';
import { decodeTiffBuffer } from '../negative2positive/src/app/tiffFileLoader.js';
import { decodeScanInWorker } from '../negative2positive/src/app/scanDecodeClient.js';

globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
const current = new URL('../', import.meta.url);
const revisions = process.argv[2]
  ? [['before', pathToFileURL(resolve(process.argv[2]) + '/')], ['after', current]]
  : [['after', current]];
const report = value => console.log(JSON.stringify(value));
const workerUrl = new URL('../negative2positive/src/workers/scanDecodeWorker.js', import.meta.url).href;
class BrowserWorker {
  constructor() {
    this.worker = new NodeWorker(`
      const { parentPort } = require('node:worker_threads');
      globalThis.ImageData = class { constructor(data,width,height) { Object.assign(this,{data,width,height}); } };
      globalThis.self = { postMessage: (message, transfers) => parentPort.postMessage(message, transfers) };
      const ready = import(${JSON.stringify(workerUrl)});
      parentPort.on('message', async data => { await ready; self.onmessage({ data }); });
    `, { eval: true });
    this.worker.on('message', data => this.onmessage?.({ data }));
    this.worker.on('error', error => this.onerror?.(error));
  }
  postMessage(message, transfers) { this.worker.postMessage(message, transfers); }
  terminate() { void this.worker.terminate(); }
}

for (const [revision, root] of revisions) {
  const { runBatchPipeline } = await import(new URL('negative2positive/src/app/batchExportScheduler.js', root));
  let release; const first = new Promise(resolve => { release = resolve; });
  let started = 0, produced = 0, written = 0;
  const run = runBatchPipeline(Array.from({ length: 100 }, (_, i) => i), {
    maxParallel: 2,
    process: async i => { started++; if (i === 0) await first; produced++; return new Uint8Array(1024 * 1024); },
    sink: async () => { written++; }
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  report({ kind: 'scheduler', revision, started, queuedMiB: produced - written });
  release(); await run;

  const { ZipStoreWriter } = await import(new URL('negative2positive/src/app/zipStoreWriter.js', root));
  let reads = 0, bytes = 0, ticks = 0;
  class MeasuredBlob extends Blob {
    stream() {
      reads++;
      const reader = super.stream().getReader();
      return new ReadableStream({ async pull(controller) {
        const next = await reader.read();
        if (next.done) controller.close(); else { bytes += next.value.byteLength; controller.enqueue(next.value); }
      } });
    }
  }
  const blob = new MeasuredBlob([new Uint8Array(64 * 1024 * 1024)]);
  const writer = new ZipStoreWriter({ async write() {} });
  const timer = setInterval(() => ticks++, 0), start = performance.now();
  await writer.addBlob('64MiB.tif', blob); clearInterval(timer);
  report({ kind: 'zip', revision, reads, readMiB: bytes / 1024 / 1024, timerTicks: ticks, ms: Math.round(performance.now() - start) });

  const encoders = await import(new URL('negative2positive/src/workers/imageEncoders.js', root));
  for (const fixture of ['ramp', 'grain']) {
    const width = 2400, height = 1600, pixels = new Uint16Array(width * height * 4);
    let seed = 12345;
    for (let i = 0; i < pixels.length; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels[i] = i % 4 === 3 ? 65535 : fixture === 'ramp' ? (i * 37) & 65535 : seed >>> 16;
    }
    let start = performance.now();
    const png = encoders.encodePng16Blob(pixels, width, height, deflate);
    const pngMs = Math.round(performance.now() - start);
    start = performance.now();
    const tiff = encoders.encodeTiffBlob(pixels, width, height, 16);
    report({ kind: 'encode', revision, fixture, pixels: width * height, pngBytes: png.size, pngMs, tiffBytes: tiff.size, tiffMs: Math.round(performance.now() - start) });
  }
}

// Both decode paths use the identical baseline-encoded 12 MP container.
const encoders = await import(new URL('negative2positive/src/workers/imageEncoders.js', revisions[0][1]));
const width = 4000, height = 3000;
const pixels = Uint16Array.from({ length: width * height * 4 }, (_, i) => (i * 37) & 65535);
for (const format of ['png', 'tiff']) {
  const blob = format === 'png' ? encoders.encodePng16Blob(pixels, width, height, deflate) : encoders.encodeTiffBlob(pixels, width, height, 16);
  for (const revision of ['before', 'after']) {
    const buffer = await blob.arrayBuffer();
    let ticks = 0, maxGap = 0;
    const start = performance.now(); let last = start;
    const timer = setInterval(() => { const now = performance.now(); ticks++; maxGap = Math.max(maxGap, now - last); last = now; }, 8);
    let result, dispatchMs;
    if (revision === 'before') {
      result = format === 'png' ? loadPngFile(buffer) : decodeTiffBuffer(buffer);
      dispatchMs = performance.now() - start;
    } else {
      const pending = decodeScanInWorker(buffer, format, { workerFactory: () => new BrowserWorker() });
      dispatchMs = performance.now() - start; result = await pending;
    }
    const totalMs = performance.now() - start;
    await new Promise(resolve => setTimeout(resolve, 0)); clearInterval(timer);
    report({ kind: 'decode', format, revision, pixels: width * height, dispatchMs: Math.round(dispatchMs), totalMs: Math.round(totalMs), timerTicks: ticks, maxTimerGapMs: Math.round(maxGap), sample: result.__image16.data[4] });
  }
}
