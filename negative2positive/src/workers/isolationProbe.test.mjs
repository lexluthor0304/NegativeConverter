import assert from 'node:assert/strict';

// A dedicated worker's global scope, in Node: the probe installs itself only
// in one, answers the probe message and keeps it from the worker's handler.
class WorkerGlobalScope extends EventTarget {}
class DedicatedScope extends WorkerGlobalScope {
  constructor() {
    super();
    this.crossOriginIsolated = true;
    this.isSecureContext = true;
    this.SharedArrayBuffer = SharedArrayBuffer;
    this.posted = [];
  }
  postMessage(message) { this.posted.push(message); }
}
globalThis.WorkerGlobalScope = WorkerGlobalScope;
const scope = new DedicatedScope();
globalThis.self = scope;
const { ISOLATION_PROBE } = await import('../app/crossOriginIsolation.js');
await import('./isolationProbe.js');

// The entry's own handler, registered after the probe (as a worker body does).
const seen = [];
scope.addEventListener('message', (event) => seen.push(event.data));

const probe = new MessageEvent('message', { data: { type: ISOLATION_PROBE, id: 7 } });
scope.dispatchEvent(probe);
assert.equal(seen.length, 0, 'the worker\'s own handler never sees the probe');
assert.deepEqual(scope.posted, [{ type: ISOLATION_PROBE, id: 7, crossOriginIsolated: true, sharedArrayBuffer: true, secureContext: true }]);

scope.dispatchEvent(new MessageEvent('message', { data: { type: 'convert', id: 1 } }));
assert.deepEqual(seen, [{ type: 'convert', id: 1 }], 'other messages reach the handler');
assert.equal(scope.posted.length, 1);

scope.crossOriginIsolated = false;
scope.dispatchEvent(new MessageEvent('message', { data: { type: ISOLATION_PROBE, id: 8 } }));
assert.equal(scope.posted[1].crossOriginIsolated, false);

delete globalThis.self;
delete globalThis.WorkerGlobalScope;
console.log('isolationProbe tests passed');
