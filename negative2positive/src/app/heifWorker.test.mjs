// The served HEIF worker (public/codecs/heif-worker.js) with the real
// libheif.js/libheif.wasm, run as a classic worker in a vm: importScripts and
// the synchronous XHR libheif reads its WASM with are the only stand-ins. It
// must announce `ready` once the runtime starts (libheif-js returns its
// module, not a promise), decode the fixture after that, and report a failed
// start as an error message instead of throwing at the top level.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const workerUrl = new URL('../../public/codecs/heif-worker.js', import.meta.url);
const fixture = readFileSync(new URL('../../test-fixtures/negative-sample.heic', import.meta.url));

function startWorker({ missing = null } = {}) {
  const messages = [];
  const listeners = [];
  const context = {
    location: { href: workerUrl.href }, crossOriginIsolated: true, isSecureContext: true,
    URL, TextDecoder, TextEncoder, console, setTimeout, clearTimeout, performance, crypto,
    postMessage: data => messages.push(data),
    addEventListener: (type, listener) => { if (type === 'message') listeners.push(listener); },
    XMLHttpRequest: class {
      open(_method, url, async) { assert.equal(async, false, 'libheif reads its WASM synchronously in a worker'); this.url = url; }
      send() {
        if (missing && this.url.endsWith(missing)) throw new Error(`failed to load ${missing}`);
        const bytes = readFileSync(fileURLToPath(this.url));
        if (this.responseType === 'arraybuffer') this.response = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        else this.responseText = bytes.toString('utf8');
        this.status = 200;
      }
    }
  };
  context.self = context;
  vm.createContext(context);
  context.importScripts = (...urls) => {
    for (const url of urls) {
      const path = fileURLToPath(new URL(url, workerUrl));
      vm.runInContext(readFileSync(path, 'utf8'), context, { filename: path });
    }
  };
  // A top-level throw here is what made the page's worker fire `error`.
  vm.runInContext(readFileSync(workerUrl, 'utf8'), context, { filename: fileURLToPath(workerUrl) });
  return { context, messages, listeners };
}

const until = async (condition, what) => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(condition(), what);
};

{
  const { context, messages } = startWorker();
  await until(() => messages.length > 0, 'the worker announces itself');
  // Messages come from the worker's realm: compare their content.
  assert.deepEqual(JSON.parse(JSON.stringify(messages)), [{ ready: true }], 'one ready message, before any decode');
  const buffer = fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength);
  await context.onmessage({ data: { buffer } });
  assert.equal(messages.length, 2);
  const image = messages[1];
  assert.equal(image.error, undefined, image.error);
  assert.ok(image.width > 100 && image.height > 100, `decoded ${image.width}x${image.height}`);
  assert.equal(image.data.length, image.width * image.height * 4);
  let sum = 0;
  for (let i = 0; i < image.data.length; i += 4) sum += image.data[i] + image.data[i + 1] + image.data[i + 2];
  const mean = sum / (image.data.length / 4) / 3;
  assert.ok(mean > 10 && mean < 245, `the decoded fixture has content (mean ${mean.toFixed(1)})`);
  console.log(`HEIF worker: ready, then decodes the fixture (${image.width}x${image.height}, mean ${mean.toFixed(1)})`);
}

{
  const { messages } = startWorker({ missing: 'libheif.wasm' });
  await until(() => messages.length > 0, 'a failed start is reported');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ready, undefined, 'a failed start never announces ready');
  assert.match(messages[0].error, /libheif\.wasm|abort/i);
  console.log('HEIF worker: a runtime that cannot start reports an error instead of throwing');
}
