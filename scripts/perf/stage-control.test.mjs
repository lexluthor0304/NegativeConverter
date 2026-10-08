import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let time = 0;
class Worker {
  constructor() { this.listeners = []; }
  addEventListener(type, fn) { this.listeners.push(fn); }
  postMessage(message) { this.last = message; return 'unchanged'; }
  reply(message) { for (const fn of this.listeners) fn({ data: message }); }
}
const env = { Worker, performance: { now: () => time } };
vm.runInNewContext(readFileSync(new URL('./stage-control.js', import.meta.url), 'utf8'), env);
const worker = new env.Worker('libraw.js');
const decode = { fn: 'imageData', args: [], id: 1 };
assert.equal(worker.postMessage(decode), 'unchanged');
assert.equal(worker.last, decode);
time = 40; worker.reply({ id: 1 });
time = 50; worker.postMessage({ type: 'analyze-import', id: 2 });
time = 100; worker.reply({ id: 2, result: { frame: null, filmEdge: { found: false }, frameMs: 30.2, filmEdgeMs: 12.5 } });
// A ref whose worker reports no film-edge time adds no film-edge stage.
time = 110; worker.postMessage({ type: 'analyze-frame', id: 3 });
time = 130; worker.reply({ id: 3, result: { cropRegion: null } });
assert.deepEqual(JSON.parse(JSON.stringify(env.__ncPerfControl.stages(0))), [
  { key: 'librawDecodeMs', t: 0, ms: 40 }, { key: 'autoFrameMs', t: 50, ms: 50 }, { key: 'filmEdgeMs', t: 50, ms: 12.5 },
  { key: 'autoFrameMs', t: 110, ms: 20 }
]);
assert.equal(env.__ncPerfControl.stages(45).length, 3);
console.log('stage-control: probe-free LibRaw and auto-frame round trips and the worker-reported film-edge time passed');
