import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createSemanticAnalyzer, SEMANTIC_MODEL_URL } from './semanticModel.js';
const bytes = readFileSync(new URL('../assets/models/efficientvit-b1-ade20k.onnx', import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'), '904544216395cf81b583771c9ca107994b388dc379fc3beabeaf57cd1e76d3f9');
assert.match(readFileSync(new URL('../../public/models/EfficientViT-LICENSE.txt', import.meta.url), 'utf8'), /Apache License/);
assert.ok(bytes.includes(Buffer.from('image')) && bytes.includes(Buffer.from('logits')));
// Under Node the literal new URL() resolves to the file Vite fingerprints into /assets.
assert.equal(SEMANTIC_MODEL_URL, new URL('../assets/models/efficientvit-b1-ade20k.onnx', import.meta.url).href);
console.log('semantic model hash, licence and named contract passed');
const image = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
// Lets queued tasks (and a model load) run up to their worker creation.
const flush = () => new Promise(resolve => setImmediate(resolve));
const model = { kind: 'session model copy' };
const workers = [];
const analyze = createSemanticAnalyzer({ modelUrl: () => '/model.onnx', loadModel: async () => model, workerFactory: () => {
  const worker = { postMessage(message) { this.message = message; }, terminate() { this.terminated = true; } };
  workers.push(worker); return worker;
} });
const first = analyze(image);
let current = true;
const stale = analyze(image, { isCurrent: () => current });
const latest = analyze(image);
await flush();
assert.equal(workers.length, 1, 'only one ONNX heap can be active');
current = false;
workers[0].onmessage({ data: { labels: [1] } });
assert.deepEqual(await first, { labels: [1] });
assert.equal(await stale, null);
await flush();
assert.equal(workers.length, 2, 'stale queued preview never creates or downloads a model');
assert.equal(workers[0].terminated, true);
workers[1].onmessage({ data: { labels: [2] } });
assert.deepEqual(await latest, { labels: [2] });
const timed = analyze(image, { timeoutMs: 5 });
assert.equal(await timed, null);
assert.equal(workers[2].terminated, true);
const invalid = analyze(image);
await flush();
workers[3].onmessageerror();
assert.equal(await invalid, null);
assert.equal(workers[3].terminated, true);
let failedWorker;
const broken = createSemanticAnalyzer({ modelUrl: () => '/model.onnx', loadModel: async () => model, workerFactory: () => failedWorker = {
  postMessage() { throw new Error('post failed'); }, terminate() { this.terminated = true; }
} });
assert.equal(await broken(image), null);
assert.equal(failedWorker.terminated, true);
let stillCurrent = true;
const leftMidRun = analyze(image, { isCurrent: () => stillCurrent, pollMs: 5 });
await Promise.resolve();
const running = workers.at(-1);
assert.ok(running.message, 'the inference was started');
stillCurrent = false;
assert.equal(await leftMidRun, null, 'leaving the photo mid-inference resolves without an answer');
assert.equal(running.terminated, true, 'and terminates the model worker without waiting for the run');
running.onmessage?.({ data: { labels: [9] } });
console.log('Semantic queue skips stale photos and releases workers on all failure paths');

// The model is loaded once per page session and posted to every short-lived
// worker; each worker still ends with its photo.
assert.equal(analyze.modelLoads(), 1, 'five photos, one model load');
assert.ok(workers.every(worker => worker.message.model === model), 'every worker gets the page copy, not a fetch');
assert.ok(workers.every(worker => worker.message.modelUrl === '/model.onnx'), 'the URL stays as the worker fallback');
assert.ok(workers.every(worker => worker.terminated), 'no persistent semantic session');
{
  // A failed load is not memoised: that photo's worker falls back to fetching,
  // and the next photo tries the page copy again.
  let attempts = 0;
  const posted = [];
  const retrying = createSemanticAnalyzer({ modelUrl: () => '/model.onnx', loadModel: async () => {
    if (++attempts === 1) throw new Error('offline');
    return model;
  }, workerFactory: () => {
    const worker = { postMessage(message) { posted.push(message); this.onmessage({ data: { labels: [attempts] } }); }, terminate() {} };
    return worker;
  } });
  assert.deepEqual(await retrying(image), { labels: [1] });
  assert.equal(posted[0].model, null, 'no page copy: the worker fetches modelUrl itself');
  assert.deepEqual(await retrying(image), { labels: [2] });
  assert.equal(posted[1].model, model);
  await retrying(image);
  assert.equal(attempts, 2, 'a loaded model is reused');
  assert.equal(retrying.modelLoads(), 2);
}
{
  // Leaving the photo during the first (slow) model download starts no worker;
  // the model is still kept for the next photo.
  let release;
  let created = 0;
  let stillCurrent = true;
  const slow = createSemanticAnalyzer({ modelUrl: () => '/model.onnx', loadModel: () => new Promise(resolve => { release = resolve; }),
    workerFactory: () => { created++; return { postMessage() { this.onmessage({ data: { labels: [3] } }); }, terminate() {} }; } });
  const left = slow(image, { isCurrent: () => stillCurrent });
  await flush();
  stillCurrent = false;
  release(model);
  assert.equal(await left, null);
  assert.equal(created, 0, 'a photo left during the model download creates no worker');
  assert.deepEqual(await slow(image), { labels: [3] });
  assert.equal(slow.modelLoads(), 1);
}
console.log('Semantic model loads once per page session and reaches each worker by postMessage');
