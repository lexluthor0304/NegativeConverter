// Standalone Node test for sensorDefectsClient.js - run with:
// node negative2positive/src/app/sensorDefectsClient.test.mjs
//
// Covers two recovery paths that are invisible in normal use but decide
// whether a good 16-bit RAW decode survives:
//  - a ping timeout must not permanently pin repair to the main thread;
//  - a worker error that hands the pixel buffer back must not lose the decode.

import assert from 'node:assert/strict';

const posted = [];
let pingBehaviour = 'answer';
let suppressBehaviour = 'result';

class FakeWorker {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
  }

  postMessage(message) {
    posted.push(message.type);
    if (message.type === 'ping') {
      if (pingBehaviour === 'ignore') return;
      queueMicrotask(() => this.onmessage({ data: { type: 'pong', id: message.id } }));
      return;
    }
    if (message.type === 'suppress') {
      // Real postMessage transfers the buffer away from the caller.
      const moved = message.buffer.transfer();
      if (suppressBehaviour === 'error') {
        queueMicrotask(() => this.onmessage({
          data: { type: 'error', id: message.id, message: 'worker blew up', buffer: moved }
        }));
        return;
      }
      queueMicrotask(() => this.onmessage({
        data: {
          type: 'result',
          id: message.id,
          buffer: moved,
          stats: { repaired: 42, dead: 1, hot: 41, perChannel: [1, 2, 3] }
        }
      }));
    }
  }

  terminate() {
    this.terminated = true;
  }
}

globalThis.Worker = FakeWorker;

const { suppressSensorDefectsInWorker } = await import('./sensorDefectsClient.js');

function makeImage16(width, height) {
  const data = new Uint16Array(width * height * 4);
  data.fill(1000);
  for (let i = 3; i < data.length; i += 4) data[i] = 65535;
  return { width, height, data };
}

// --- a cold-start ping timeout must be retried, not cached forever ----------
{
  pingBehaviour = 'ignore';
  const realSetTimeout = globalThis.setTimeout;
  // Make the ping timeout fire immediately instead of waiting 5 s.
  globalThis.setTimeout = (fn) => { fn(); return 0; };
  const first = await suppressSensorDefectsInWorker(makeImage16(8, 8));
  globalThis.setTimeout = realSetTimeout;

  assert.equal(first.repaired, 0, 'main-thread fallback ran on a clean image');
  assert.deepEqual(posted, ['ping'], 'no pixels were handed to a worker that never answered');

  // The worker is warm now: the next load must try it again.
  pingBehaviour = 'answer';
  const image = makeImage16(8, 8);
  const second = await suppressSensorDefectsInWorker(image);
  assert.equal(second.repaired, 42, 'a later load must re-ping and use the worker');
  assert.deepEqual(posted, ['ping', 'ping', 'suppress']);
  assert.equal(image.data.length, 8 * 8 * 4, 'pixels came back from the worker');
}

// --- a worker error that returns the buffer must not lose the decode --------
{
  posted.length = 0;
  suppressBehaviour = 'error';
  const image = makeImage16(8, 8);
  const originalBuffer = image.data.buffer;

  const stats = await suppressSensorDefectsInWorker(image);

  assert.equal(originalBuffer.byteLength, 0, 'the original buffer really was transferred away');
  assert.equal(image.data.length, 8 * 8 * 4, 'pixels were restored from the error message');
  assert.equal(image.data[0], 1000, 'restored pixels are the ones we sent');
  assert.equal(typeof stats.repaired, 'number');
}

console.log('sensorDefectsClient.test.mjs passed');
