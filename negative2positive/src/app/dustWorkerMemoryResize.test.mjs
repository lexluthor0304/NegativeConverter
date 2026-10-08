// R2-056: real client/processor serialization, paused before replacing a
// pinned 24x16 source with a queued 6x4 detect/inpaint request.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { createDustWorkerClient } from './dustWorkerClient.js';
import { createDustWorkerProcessor } from '../workers/dustWorkerProcessor.js';
import { ROLL_OPENCV_REALM_BYTES } from './batchExportScheduler.js';
import { isSharedPlane } from './crossOriginIsolation.js';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
};
globalThis.cv = await createRequire(import.meta.url)('@techstark/opencv-js');
const source = readFileSync(process.env.NC229_ROLL_SIZING_MAIN || new URL('./main.js', import.meta.url), 'utf8');
const start = source.indexOf('    function noteDustWorkerMemory(');
const note = source.slice(start, source.indexOf('\n    }\n', start) + 6);
const reg = source.indexOf("    workerResidents.set('dust', {");
const registration = source.slice(reg, source.indexOf('\n    });', reg) + 8);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(setImmediate);
function image(width, height, shared16) {
  const data = new Uint8ClampedArray(width * height * 4).fill(180);
  const plane = new Uint16Array(shared16 ? new SharedArrayBuffer(data.length * 2) : new ArrayBuffer(data.length * 2)).fill(46260);
  for (let i = 3; i < data.length; i += 4) { data[i] = 255; plane[i] = 65535; }
  return Object.assign(new ImageData(data, width, height), { __image16: { width, height, data: plane } });
}
for (const method of ['detect', 'inpaint']) for (const shared16 of [false, true]) {
  const entered = deferred(), resume = deferred();
  let blocked = false, terminations = 0;
  const process = createDustWorkerProcessor({ loadCv: async () => {
    if (blocked) { entered.resolve(); await resume.promise; }
  } });
  const client = createDustWorkerClient({ workerFactory: () => ({
    postMessage(message, transfers = []) {
      const received = structuredClone(message, { transfer: transfers });
      void process(received).then(({ payload, transfers: moved }) => {
        this.onmessage?.({ data: structuredClone(payload, { transfer: moved }) });
      }, error => { this.onmessage?.({ data: { id: received.id, error: String(error) } }); });
    }, terminate() { terminations++; }
  }) });
  const context = vm.createContext({ workerResidents: new Map(), dustWorkerPlaneBytes: 0, dustWorker: client,
    disposeDustWorker: client.dispose, ROLL_OPENCV_REALM_BYTES, isSharedPlane });
  vm.runInContext(note + '\n' + registration, context);
  const resident = () => context.workerResidents.get('dust').residentBytes();
  const idle = () => context.workerResidents.get('dust').idle();
  const large = image(24, 16, shared16), mask = new Uint8Array(24 * 16);
  context.noteDustWorkerMemory(large, mask);
  await client.pin(large, { mask, tag: 41, particleCount: 0 });
  const previous = resident();
  assert.equal(previous, ROLL_OPENCV_REALM_BYTES + large.data.byteLength + mask.byteLength
    + (shared16 ? 0 : large.__image16.data.byteLength), 'shared precision is counted by its page owner only');
  const small = image(6, 4, shared16), smallMask = new Uint8Array(6 * 4);
  blocked = true;
  context.noteDustWorkerMemory(small, method === 'inpaint' ? smallMask : null);
  const reply = method === 'detect' ? client.detect(small) : client.inpaint(small, smallMask, 3);
  await entered.promise;
  assert.equal(client.pinned, true);
  assert.ok(client.pendingCount > 0);
  assert.equal(idle(), false, 'pending pinned replacement cannot be evicted');
  console.log(`${method}/shared=${shared16}: before replacement=${resident()}, retained source=${previous}`);
  assert.ok(resident() >= previous, `${method}/shared=${shared16}: old source remains counted before resetSource`);
  client.unpin();
  assert.equal(idle(), false, 'unpin still protects the queued request');
  assert.ok(resident() >= previous, 'unpin is not a source-release acknowledgement');
  resume.resolve();
  await reply;
  for (let i = 0; i < 4; i++) await tick();
  assert.equal(client.maskTag, null, 'tagless replacement retains its worker');
  assert.equal(idle(), true);
  assert.equal(resident(), previous, 'the conservative maximum persists through the live worker lifetime');
  context.workerResidents.get('dust').release();
  assert.equal(resident(), 0, 'actual disposal clears residency');
  assert.equal(context.dustWorkerPlaneBytes, 0, 'idle release clears the estimate');
  assert.equal(terminations, 1);
  // A fresh smaller worker starts from its own estimate, not the old maximum.
  context.noteDustWorkerMemory(small, smallMask);
  await client.pin(small, { mask: smallMask, tag: 42, particleCount: 0 });
  assert.equal(resident(), ROLL_OPENCV_REALM_BYTES + small.data.byteLength + smallMask.byteLength
    + (shared16 ? 0 : small.__image16.data.byteLength));
  client.dispose();
  assert.equal(resident(), 0, 'client termination also ends the counted lifetime');
}
console.log('dustWorkerMemoryResize: queued unequal detect/inpaint, copied/shared precision, unpin and disposal');
