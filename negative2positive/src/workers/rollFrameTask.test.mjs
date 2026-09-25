// The roll-frame worker's steps (#252 part 2) against the sequence a roll
// lane ran before: the #232 post-decode worker's planes, the #251 import
// request on a copy of the 8-bit plane (retried with both planes when the
// detector needs the full-resolution rotation), and the roll sample built
// from the base. Same bytes in, same results and sample bytes out. Node has
// no OffscreenCanvas, so the detector uses its JS preview here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

globalThis.cv = await createRequire(import.meta.url)('@techstark/opencv-js');
globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    if (!(data instanceof Uint8ClampedArray)) throw new TypeError('ImageData needs a Uint8ClampedArray');
    this.data = data; this.width = width; this.height = height;
  }
};
const { createRollFrameTask, rollFrameFilmType } = await import('./rollFrameTask.js');
const { runImportRequest } = await import('./autoFrameImportTask.js');
const { createFilmEdgeReader } = await import('./filmEdgeRead.js');
const { createAutoFrameWorkerClient } = await import('../app/autoFrameWorkerClient.js');
const { detectFrameAndRotation } = await import('../app/autoFrameAnalyzer.js');
const { applyRotationToImageData } = await import('../app/imageGeometry.js');
const { runRawPostDecode, describeView, viewFromDescription } = await import('../app/rawPostDecode.js');
const { buildRollSample, restoreRollSample, rollSampleSettings } = await import('../app/rollSample.js');
const { imageFromRollPlanes } = await import('../app/rollFrameWorkerClient.js');

const sha = view => createHash('sha256').update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength)).digest('hex');
const readEdge = createFilmEdgeReader(async () => {});
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate); };

// A LibRaw-like 16-bit RGB result: a dark 3:2 frame on an orange base turned
// by `degrees`, with sensor noise and a few stuck photosites the defect pass
// repairs.
function libRawResult(width, height, degrees, seed = 1) {
  const rad = degrees * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const w = width * 0.6, h = w / 1.5;
  const data = new Uint16Array(width * height * 3);
  let state = seed >>> 0;
  const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const dx = x - width / 2, dy = y - height / 2;
    const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
    const inside = Math.abs(u) < w / 2 && Math.abs(v) < h / 2;
    const rgb = inside ? [95 + ((x + y) & 15), 55, 30] : [238, 160, 100];
    for (let c = 0; c < 3; c++) data[(y * width + x) * 3 + c] = Math.min(65535, rgb[c] * 257 + Math.floor(random() * 300));
  }
  for (let k = 0; k < 12; k++) data[(Math.floor(random() * width * height)) * 3 + (k % 3)] = k % 2 ? 65535 : 0;
  return { width, height, bits: 16, colors: 3, data };
}

const frameOptions = { settings: { highConfidence: 0.72, minConfidence: 0.55, marginRatio: 0.02, filmType: 'color', deterministicPreview: true }, maxSide: 400, rotatedOutput: 'none' };
const postOptions = { suppressSensorDefects: true, filmStats: { borderBufferPct: 10 } };

// The lane before #252: planes from the post-decode steps, then one import
// request on a copy of the 8-bit plane through the real client and request
// code (a worker stand-in that clones and transfers), then the sample.
async function headSequence(result, { detect = detectFrameAndRotation, recipe = null, choice = { automatic: true } } = {}) {
  const outcome = runRawPostDecode({ ...result, data: result.data.slice() }, postOptions);
  if (outcome.garbled) return { garbled: true };
  const image = imageFromRollPlanes({ width: outcome.width, height: outcome.height, rgba8: outcome.rgba8, rgba16: outcome.rgba16, filmStats: outcome.filmStats });
  const before = sha(image.data);
  const factory = () => {
    const worker = {
      terminate() {},
      postMessage(message, transfers = []) {
        const received = structuredClone(message, { transfer: transfers });
        setTimeout(async () => {
          const run = await runImportRequest(received, { loadCv: async () => {}, detect, rotate: applyRotationToImageData, readEdge });
          worker.onmessage({ data: structuredClone({ id: received.id, result: run.reply }, { transfer: run.transfers }) });
        }, 0);
      }
    };
    return worker;
  };
  const client = createAutoFrameWorkerClient({ workerFactory: factory, idleTimeoutMs: 5 });
  const frameFilmType = rollFrameFilmType(choice, outcome.filmStats);
  const analysed = await client.analyzeImport(image, { frame: { ...frameOptions, frameFilmType }, filmEdge: {}, owned: false });
  client.dispose();
  assert.equal(sha(image.data), before, 'the page\'s plane was only copied');
  const settings = recipe ? recipe(analysed.frame) : {};
  const sample = buildRollSample(image, settings, { tileMax: 288 });
  return { outcome, image, detection: analysed.frame, edge: analysed.filmEdge, frameFilmType, settings, sample };
}

function runTask(task, message) {
  return new Promise((resolve) => {
    const replies = [];
    task.handle(message, (reply, transfers) => {
      replies.push(structuredClone(reply, { transfer: transfers }));
      resolve(replies[0]);
    });
  });
}

function newTask(detect = detectFrameAndRotation) {
  return createRollFrameTask({ loadCv: async () => {}, detect, rotate: applyRotationToImageData, readEdge, yieldTask: () => new Promise(setImmediate) });
}

async function taskSequence(result, { detect, recipe = null, choice = { automatic: true }, task = newTask(detect) } = {}) {
  const input = result.data.slice();
  const described = describeView(input);
  const reply = await runTask(task, {
    type: 'process', id: 7, width: result.width, height: result.height, bits: result.bits, colors: result.colors,
    input: structuredClone(described, { transfer: [described.buffer] }),
    options: { ...postOptions, frame: frameOptions, filmTypeChoice: choice, filmEdge: true }
  });
  assert.equal(input.byteLength, 0, 'the decode buffer was transferred, not copied');
  if (reply.garbled) return { reply };
  assert.equal(task.held, 7, 'the worker keeps the frame');
  const settings = recipe ? recipe(reply.detection) : {};
  const sampleReply = await runTask(task, { type: 'sample', id: 7, settings: rollSampleSettings(settings), tileMax: 288 });
  assert.equal(task.held, null, 'and drops it after the sample');
  return { reply, settings, sample: restoreRollSample(sampleReply.sample) };
}

const strip = result => {
  if (!result) return result;
  const { stageMs, ...rest } = result;
  return rest;
};
const planeHashes = sample => [sample.width, sample.height, sha(sample.data), sample.__image16 && sha(sample.__image16.data),
  sample.__analysisReference && sha(sample.__analysisReference.data), sha(sample.__tileWorking.data),
  sample.__tileWorking.__image16 && sha(sample.__tileWorking.__image16.data), JSON.stringify(sample.__baseSize)];
const recipeFrom = detection => detection?.cropRegion ? {
  rotationAngle: detection.angle, mirrored: false, cropRegion: detection.cropRegion,
  autoFrameMeta: { imageArea: [{ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.2 }, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.8 }], lastDiagnostics: 'ignored' }
} : { mirrored: true };

// Same results and sample bytes, tilted and straight, found and not found.
for (const [width, height, degrees] of [[900, 640, 3], [900, 640, 0], [640, 900, -2], [300, 200, 0]]) {
  const result = libRawResult(width, height, degrees, width + degrees);
  const head = await headSequence(result, { recipe: recipeFrom });
  const task = await taskSequence(result, { recipe: recipeFrom });
  const { reply } = task;
  const label = `${width}x${height} at ${degrees} degrees`;
  assert.equal(reply.garbled, false, label);
  assert.deepEqual([reply.width, reply.height], [head.outcome.width, head.outcome.height]);
  assert.deepEqual(reply.defects, head.outcome.defects, `${label}: defect pass`);
  assert.deepEqual(reply.filmStats, head.outcome.filmStats, `${label}: film statistics`);
  assert.equal(reply.frameFilmType, head.frameFilmType);
  assert.deepEqual(strip(reply.detection), strip(head.detection), `${label}: detection`);
  assert.deepEqual(reply.edge, head.edge, `${label}: film edge`);
  assert.equal(reply.detectionError, null);
  assert.equal(reply.complete, true);
  assert.equal(reply.planes, undefined, 'the planes stay in the worker');
  assert.deepEqual(planeHashes(task.sample), planeHashes(head.sample), `${label}: sample bytes`);
  if (width === 900 && degrees === 3) assert.ok(head.detection?.cropRegion && head.detection.angle !== 0, 'a tilted window is found');
}

// A detection that needs the exact full-resolution rotation: the lane
// retried with both planes; the worker holds both and needs no retry.
{
  const result = libRawResult(900, 640, 3, 9);
  let deferred = 0;
  const forced = (image, config) => {
    if (config.deferFullResolution) { deferred++; return { needsFullResolution: true, stageMs: {} }; }
    return detectFrameAndRotation(image, config);
  };
  const head = await headSequence(result, { detect: forced, recipe: recipeFrom });
  assert.equal(deferred, 1, 'the lane had to retry');
  const seen = [];
  const task = await taskSequence(result, { detect: (image, config) => { seen.push(config.deferFullResolution); return forced(image, config); }, recipe: recipeFrom });
  assert.deepEqual(seen, [false], 'the worker detects once, on both planes');
  assert.deepEqual(strip(task.reply.detection), strip(head.detection));
  assert.deepEqual(planeHashes(task.sample), planeHashes(head.sample));
}

// The film-type choice is the one createDefaultSettings would pass.
{
  const stats = { filmType: { filmType: 'bw', confidence: 'low' } };
  assert.equal(rollFrameFilmType({ automatic: true }, stats), 'bw');
  assert.equal(rollFrameFilmType({ automatic: false, filmType: 'positive' }, stats), 'positive');
  const result = libRawResult(300, 200, 0, 4);
  const head = await headSequence(result, { choice: { automatic: false, filmType: 'positive' } });
  const task = await taskSequence(result, { choice: { automatic: false, filmType: 'positive' } });
  assert.equal(task.reply.frameFilmType, 'positive');
  assert.deepEqual(strip(task.reply.detection), strip(head.detection));
}

// The foreground adopts the frame: the planes come back between steps, as the
// post-decode steps left them, and nothing else runs.
{
  const result = libRawResult(300, 200, 0, 5);
  let detections = 0;
  const task = newTask((image, config) => { detections++; return detectFrameAndRotation(image, config); });
  const described = describeView(result.data.slice());
  const replies = [];
  const done = new Promise((resolve) => {
    task.handle({
      type: 'process', id: 3, width: 300, height: 200, bits: 16, colors: 3, input: described,
      options: { ...postOptions, frame: frameOptions, filmTypeChoice: { automatic: true }, filmEdge: true }
    }, (reply, transfers) => { replies.push(structuredClone(reply, { transfer: transfers })); resolve(); });
  });
  void task.handle({ type: 'return-planes', id: 3 }, () => {});
  await done;
  const reply = replies[0];
  assert.equal(reply.interrupted, true);
  assert.equal(reply.complete, false);
  assert.equal(detections, 0, 'no detection for a frame the foreground took');
  const expected = runRawPostDecode({ ...result, data: result.data.slice() }, postOptions);
  assert.equal(sha(viewFromDescription(reply.planes.rgba16)), sha(expected.rgba16));
  assert.equal(sha(viewFromDescription(reply.planes.rgba8)), sha(expected.rgba8));
  assert.equal(task.held, null);
}

// `returnPlanes` (a prefetch, or room in the photo sessions): the analysis and
// the planes; release hands a held frame back; a sample of a frame no longer
// held is an error.
{
  const result = libRawResult(300, 200, 0, 6);
  const task = newTask();
  const described = describeView(result.data.slice());
  const reply = await runTask(task, {
    type: 'process', id: 4, width: 300, height: 200, bits: 16, colors: 3, input: described,
    options: { ...postOptions, frame: frameOptions, filmTypeChoice: { automatic: true }, filmEdge: true, returnPlanes: true }
  });
  assert.equal(reply.complete, true);
  assert.ok(reply.planes && task.held === null);
  const missing = await runTask(task, { type: 'sample', id: 4, settings: {}, tileMax: 288 });
  assert.equal(missing.type, 'error');

  const again = describeView(result.data.slice());
  await runTask(task, { type: 'process', id: 5, width: 300, height: 200, bits: 16, colors: 3, input: again, options: { ...postOptions } });
  const released = await runTask(task, { type: 'release', id: 5, returnPlanes: true });
  assert.equal(sha(viewFromDescription(released.planes.rgba8)), sha(viewFromDescription(reply.planes.rgba8)));
  assert.equal(task.held, null);
}

// A garbled decode stops before any analysis; a failed post-decode hands the
// input back untouched, so the page finishes it with the same functions.
{
  const task = newTask(() => assert.fail('no detection of a garbled frame'));
  const snow = { width: 64, height: 64, bits: 16, colors: 3, data: new Uint16Array(64 * 64 * 3) };
  for (let i = 0; i < snow.data.length; i++) snow.data[i] = (i * 7919) % 3 === 0 ? 65535 : 0;
  const garbled = runRawPostDecode({ ...snow, data: snow.data.slice() }, postOptions).garbled;
  const reply = await runTask(task, { type: 'process', id: 6, ...snow, data: undefined, input: describeView(snow.data.slice()), options: { ...postOptions, frame: frameOptions } });
  assert.equal(reply.garbled, garbled);
  const broken = await runTask(task, { type: 'process', id: 8, width: 10, height: 10, bits: 16, colors: 3, input: { kind: 'Float64Array', buffer: new ArrayBuffer(8) }, options: postOptions });
  assert.equal(broken.type, 'error');
  assert.equal(broken.stage, 'input');
  await flush();
}
console.log('rollFrameTask: post-decode, detection, film edge and sample equal the lane sequence');
