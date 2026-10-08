import assert from 'node:assert/strict';
import { yieldForJob, yieldTask, yieldTaskForJob, yieldToPaint, isDocumentHidden } from './yieldToPaint.js';

function fakeDocument(visibilityState = 'visible') {
  const listeners = new Set();
  return {
    visibilityState,
    addEventListener(type, fn) { if (type === 'visibilitychange') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'visibilitychange') listeners.delete(fn); },
    hide() { this.visibilityState = 'hidden'; for (const fn of [...listeners]) fn(); },
    get listenerCount() { return listeners.size; }
  };
}

const realTimeout = globalThis.setTimeout;
let timerCalls = 0;
globalThis.setTimeout = (fn, ms, ...args) => { timerCalls += 1; return realTimeout(fn, ms, ...args); };
const frames = [];
globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };

assert.equal(yieldForJob, yieldToPaint, 'one helper under both names');

// Hidden: no frame, no DOM timer; a MessageChannel task resolves it.
{
  const doc = fakeDocument('hidden');
  assert.equal(isDocumentHidden(doc), true);
  frames.length = 0; timerCalls = 0;
  await yieldToPaint(doc);
  assert.equal(frames.length, 0, 'a hidden page never waits for a frame');
  assert.equal(timerCalls, 0, 'a hidden page never waits on a DOM timer');
  await yieldTaskForJob(doc);
  assert.equal(timerCalls, 0, 'the job-loop yield uses the MessageChannel branch while hidden');
}

// Visible: waits for the frame, then one setTimeout(0).
{
  const doc = fakeDocument('visible');
  frames.length = 0; timerCalls = 0;
  let done = false;
  const pending = yieldToPaint(doc).then(() => { done = true; });
  await yieldTask();
  assert.equal(done, false, 'visible: still waiting for the frame');
  assert.equal(frames.length, 1);
  frames.shift()();
  await pending;
  assert.equal(done, true);
  assert.equal(timerCalls, 1, 'rAF then setTimeout(0) while visible');
  assert.equal(doc.listenerCount, 0, 'the visibility listener is removed');
  timerCalls = 0;
  await yieldTaskForJob(doc);
  assert.equal(timerCalls, 1, 'the job-loop yield keeps setTimeout(0) while visible');
}

// A page that hides while the frame is pending continues without it.
{
  const doc = fakeDocument('visible');
  frames.length = 0;
  let done = false;
  const pending = yieldToPaint(doc).then(() => { done = true; });
  await yieldTask();
  assert.equal(done, false);
  doc.hide();
  await pending;
  assert.equal(done, true, 'hiding mid-wait resolves through the hidden branch');
  assert.equal(doc.listenerCount, 0);
  // The frame that eventually fires is harmless.
  frames.shift()();
  await yieldTask();
}

// No document (workers, Node): a plain task boundary.
{
  frames.length = 0;
  await yieldToPaint(null);
  await yieldTaskForJob(null);
  assert.equal(frames.length, 0);
}

globalThis.setTimeout = realTimeout;
delete globalThis.requestAnimationFrame;
console.log('yieldToPaint tests passed');
