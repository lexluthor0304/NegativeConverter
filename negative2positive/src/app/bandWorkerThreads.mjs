// Test helper (#256): the real conversion band worker in Node worker_threads,
// behind the Worker interface createConversionBandPool expects. Enhanced
// profiles load through fetch(file: URL), which the shim serves from disk.
import { Worker as NodeWorker } from 'node:worker_threads';

const workerUrl = new URL('../workers/conversionBandWorker.js', import.meta.url).href;
const shim = `
  const { parentPort } = require('node:worker_threads');
  const { readFile } = require('node:fs/promises');
  globalThis.ImageData = class ImageData { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
  const nodeFetch = globalThis.fetch;
  globalThis.fetch = async (url, ...rest) => {
    const href = String(url);
    if (!href.startsWith('file:')) return nodeFetch(url, ...rest);
    const buf = await readFile(new URL(href));
    return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
  globalThis.self = { postMessage: (message, transfers) => parentPort.postMessage(message, transfers) };
  const early = [];
  let loaded = false;
  parentPort.on('message', data => loaded ? self.onmessage?.({ data }) : early.push(data));
  import(${JSON.stringify(workerUrl)}).then(() => { loaded = true; for (const data of early) self.onmessage?.({ data }); });
`;

/**
 * A factory of band workers. `crashOn(message)` makes a worker fail instead
 * of receiving that message. `threads` collects them for terminate().
 */
export function bandThreadFactory({ crashOn = null, threads = [] } = {}) {
  return () => {
    const thread = new NodeWorker(shim, { eval: true });
    threads.push(thread);
    const worker = {
      postMessage: (message, transfers) => {
        if (crashOn && crashOn(message)) {
          setImmediate(() => worker.onerror?.(new Error('band worker crashed')));
          return;
        }
        thread.postMessage(message, transfers);
      },
      terminate: () => thread.terminate()
    };
    thread.on('message', (data) => worker.onmessage?.({ data }));
    thread.on('error', (error) => worker.onerror?.(error));
    return worker;
  };
}
