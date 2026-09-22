import assert from 'node:assert/strict';

const messages = [];
globalThis.self = {
  onmessage: null,
  postMessage(message) {
    assert.equal(typeof this.onmessage, 'function', 'worker installs its handler before announcing readiness');
    messages.push(message);
  }
};
await import('./aiInpaintWorker.js');
assert.deepEqual(messages, [{ ready: true }], 'module initialization announces readiness without loading a model');
await self.onmessage({ data: { type: 'run', id: 1 } });
assert.equal(messages[1].id, 1);
assert.match(messages[1].error, /session is not ready/);
assert.equal(messages[1].ready, undefined, 'execution failures stay ordinary response errors');
console.log('AI worker announces bootstrap readiness before model work and reports execution errors separately');
