import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { deflate } from 'pako';
import { decodeScanInWorker } from './scanDecodeClient.js';
import { encodePng16Blob, encodeTiffBlob } from '../workers/imageEncoders.js';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
};
const workerUrl = new URL('../workers/scanDecodeWorker.js', import.meta.url).href;
let terminated = 0;
class RealWorker {
  constructor() {
    this.worker = new NodeWorker(`
      const { parentPort } = require('node:worker_threads');
      globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
      globalThis.self = { postMessage: (message, transfers) => parentPort.postMessage(message, transfers) };
      const ready = import(${JSON.stringify(workerUrl)});
      parentPort.on('message', async data => { await ready; self.onmessage({ data }); });
    `, { eval: true });
    this.worker.on('message', data => this.onmessage?.({ data }));
    this.worker.on('error', error => this.onerror?.(error));
  }
  postMessage(message, transfers) { this.worker.postMessage(message, transfers); }
  terminate() { terminated++; void this.worker.terminate(); }
}

const pixels = new Uint16Array([0x1234, 0x0001, 0xFEDC, 65535, 0xACBD, 0x8001, 0x0002, 65535]);
for (const format of ['png', 'tiff']) {
  const blob = format === 'png' ? encodePng16Blob(pixels, 2, 1, deflate) : encodeTiffBlob(pixels, 2, 1, 16);
  const buffer = await blob.arrayBuffer();
  const pending = decodeScanInWorker(buffer, format, { workerFactory: () => new RealWorker() });
  const result = await pending;
  assert.equal(buffer.byteLength, 0, 'input ownership transfers without a full scan clone');
  assert.deepEqual(result.__image16.data, pixels, `${format}: exact low-byte precision`);
  assert.deepEqual(result.data, new Uint8ClampedArray(Array.from(pixels, x => x >>> 8)));
}
assert.equal(terminated, 2, 'each decode must release its worker heap');
await assert.rejects(decodeScanInWorker(new ArrayBuffer(8), 'png', { workerFactory: () => new RealWorker() }));
assert.equal(terminated, 3, 'decoder errors release their heap');

const intact = new ArrayBuffer(8);
assert.equal(await decodeScanInWorker(intact, 'png', { workerFactory: null }), null);
assert.equal(await decodeScanInWorker(intact, 'png', { workerFactory: () => { throw Error('unavailable'); } }), null);
assert.equal(intact.byteLength, 8, 'fallback keeps the input container');
{
  let worker;
  const pending = decodeScanInWorker(intact, 'png', { workerFactory: () => (worker = { terminate() {} }) });
  worker.onerror();
  assert.equal(await pending, null, 'asynchronous startup failure uses the main decoder');
  assert.equal(intact.byteLength, 8, 'startup failure must retain input ownership');
}
let stopped = false;
await assert.rejects(decodeScanInWorker(new ArrayBuffer(8), 'png', {
  workerFactory: () => ({ postMessage() {}, terminate() { stopped = true; } }), timeoutMs: 1
}), /timed out/);
assert.ok(stopped, 'a timed out decoder is terminated');
console.log('scanDecodeClient tests passed: real worker PNG/TIFF precision, transfer and lifecycle');
