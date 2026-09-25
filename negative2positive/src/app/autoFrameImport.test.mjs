// One import request per frame (#251): the client's analyzeImport against
// the worker's real request code (workers/autoFrameImportTask.js) and the
// real analyzer, over a message channel that clones and transfers like
// postMessage. Covers the copies it makes, the owned hand-over and its
// rebuild, the full-resolution retry, the Auto Frame button's frames, and a
// failed worker that holds an owned frame.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

globalThis.cv = await createRequire(import.meta.url)('@techstark/opencv-js');
globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    if (!(data instanceof Uint8ClampedArray)) throw new TypeError('ImageData needs a Uint8ClampedArray');
    this.data = data; this.width = width; this.height = height;
  }
};
const { createAutoFrameWorkerClient } = await import('./autoFrameWorkerClient.js');
const { runImportAnalyses } = await import('./autoFrameExecution.js');
const { detectFrameAndRotation } = await import('./autoFrameAnalyzer.js');
const { applyRotationToImageData } = await import('./imageGeometry.js');
const { runImportRequest, detectFrameForRequest, packFrameResult } = await import('../workers/autoFrameImportTask.js');

function frame(width, height, degrees) {
  const rad = degrees * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const w = width * 0.6, h = w / 1.5;
  const data = new Uint8ClampedArray(width * height * 4);
  const data16 = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const dx = x - width / 2, dy = y - height / 2;
    const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
    const rgb = Math.abs(u) < w / 2 && Math.abs(v) < h / 2 ? [95 + ((x + y) & 15), 55, 30] : [238, 160, 100];
    const i = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) { data[i + c] = rgb[c]; data16[i + c] = rgb[c] * 257 + 3; }
    data[i + 3] = 255; data16[i + 3] = 65535;
  }
  const image = new ImageData(data, width, height);
  image.__image16 = { width, height, data: data16 };
  image.__decodeTag = 'expando';
  return image;
}
const options = rotatedOutput => ({
  settings: { highConfidence: 0.72, minConfidence: 0.55, marginRatio: 0.02, filmType: 'color', deterministicPreview: true },
  maxSide: 360, rotatedOutput
});
const readEdge = async image => ({ found: true, width: image.width, firstByte: image.data[0] });

// A worker stand-in: structured clone with transfer on the way in and out
// (a transferred buffer is detached on the sending side), the real request
// code in between. `detect` may be wrapped per test.
function channelWorker({ detect = detectFrameAndRotation, crash = null } = {}) {
  const log = [];
  const factory = () => {
    const worker = {
      terminate() { worker.terminated = true; },
      postMessage(message, transfers = []) {
        const received = structuredClone(message, { transfer: transfers });
        // Copies of what arrived (the worker may hand the buffers back).
        log.push({ type: received.type, message: { ...received, rgba: received.rgba?.slice(), image16: received.image16?.slice() } });
        setTimeout(async () => {
          if (crash?.(received)) { worker.onerror?.(new Error('crash')); return; }
          let reply;
          const out = [];
          if (received.type === 'analyze-import') {
            const run = await runImportRequest(received, { loadCv: async () => {}, detect, rotate: applyRotationToImageData, readEdge });
            reply = run.reply; out.push(...run.transfers);
          } else {
            const image = new ImageData(received.rgba, received.width, received.height);
            if (received.image16) image.__image16 = { width: image.width, height: image.height, data: received.image16 };
            reply = packFrameResult(detectFrameForRequest(image, received, received.options, { detect, rotate: applyRotationToImageData }), out);
          }
          worker.onmessage({ data: structuredClone({ id: received.id, result: reply }, { transfer: out }) });
        }, 0);
      }
    };
    return worker;
  };
  return { log, client: createAutoFrameWorkerClient({ workerFactory: factory, idleTimeoutMs: 5 }) };
}
// Byte equality without assert's element-by-element diff of large arrays.
const sameBytes = (a, b) => Boolean(a && b) && a.byteLength === b.byteLength
  && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
const summary = r => r && JSON.stringify([r.angle, r.cropRegion, r.confidence, r.confidenceLevel, r.detectedFormat, Boolean(r.requiresReview), r.diagnostics, r.rotatedWidth, r.rotatedHeight, r.rotatedIsSource]);

// The photo on screen: one copy of the 8-bit plane for both analyses; the
// 16-bit plane stays on this thread; the frame's size, never its pixels.
{
  const source = frame(720, 480, 2.5);
  const expected = detectFrameAndRotation(source, { ...options('none'), rotateImageData: applyRotationToImageData });
  assert.ok(expected?.cropRegion && expected.angle !== 0, 'the fixture is tilted and found');
  const { log, client } = channelWorker();
  const outcome = await client.analyzeImport(source, { frame: options('none'), filmEdge: {} });
  assert.equal(log.length, 1, 'one request for frame and film edge');
  assert.equal(log[0].type, 'analyze-import');
  assert.equal(log[0].message.image16, undefined, 'no 16-bit plane is posted');
  assert.equal(log[0].message.image16Omitted, true);
  assert.equal(log[0].message.returnPlanes, false);
  assert.equal(source.data.byteLength, 720 * 480 * 4, 'the source keeps its planes (a copy was sent)');
  assert.equal(outcome.image, source);
  assert.equal(summary(outcome.frame), summary(expected), 'the same detection as on this thread');
  assert.equal(outcome.frame.rotatedImageData, undefined, 'no rotated frame comes back');
  assert.deepEqual(outcome.filmEdge, { found: true, width: 720, firstByte: source.data[0] });
  assert.equal(outcome.frameError, null);
  assert.equal(outcome.imageLost, false);
}

// A lane's own decode: transferred without a copy, handed back, rebuilt over
// the same bytes with the same 16-bit plane and properties.
{
  const source = frame(720, 480, 2.5);
  const bytes = source.data.slice();
  const plane16 = source.__image16;
  const { log, client } = channelWorker();
  const outcome = await client.analyzeImport(source, { frame: options('none'), filmEdge: {}, owned: true });
  assert.equal(log.length, 1);
  assert.equal(log[0].message.returnPlanes, true);
  assert.equal(log[0].message.image16, undefined);
  assert.equal(source.data.byteLength, 0, 'the 8-bit buffer was transferred, not copied');
  assert.notEqual(outcome.image, source);
  assert.ok(outcome.image instanceof ImageData);
  assert.ok(sameBytes(outcome.image.data, bytes), 'the same bytes came back');
  assert.equal(outcome.image.__image16, plane16, 'the untouched 16-bit plane is re-attached');
  assert.equal(outcome.image.__decodeTag, 'expando', 'the decode\'s own properties carry over');
  assert.ok(outcome.frame.cropRegion);
}

// A detection that needs the exact full-resolution rotation after all is
// retried once with both planes and returns what the analyzer returns with
// both planes at hand; the first reply's film edge stands.
for (const owned of [false, true]) {
  const source = frame(720, 480, 2.5);
  const plane16 = source.__image16.data.slice();
  const forced = (image, config) => (config.deferFullResolution ? { needsFullResolution: true, stageMs: {} } : detectFrameAndRotation(image, config));
  const expected = detectFrameAndRotation(frame(720, 480, 2.5), { ...options('none'), rotateImageData: applyRotationToImageData });
  const { log, client } = channelWorker({ detect: forced });
  const outcome = await client.analyzeImport(source, { frame: options('none'), filmEdge: {}, owned });
  assert.equal(log.length, 2, 'one retry');
  assert.equal(log[1].message.image16Omitted, false);
  assert.ok(sameBytes(log[1].message.image16, plane16), 'the retry carries the 16-bit plane');
  assert.equal(log[1].message.filmEdge, null, 'the film edge is not read twice');
  assert.equal(summary(outcome.frame), summary(expected));
  assert.equal(outcome.filmEdge.found, true);
  if (owned) {
    assert.ok(sameBytes(outcome.image.__image16.data, plane16), 'the 16-bit plane came back with the frame');
    assert.equal(outcome.image.__decodeTag, 'expando');
  } else {
    assert.equal(outcome.image, source);
    assert.equal(source.__image16.data.byteLength, plane16.byteLength, 'the 16-bit plane was copied, not moved');
  }
}

// The Auto Frame button ('full', both planes): the rotated planes come back
// at a non-zero angle; at angle 0 nothing comes back and the result's frame
// is the source itself.
for (const degrees of [2.5, 0]) {
  const source = frame(720, 480, degrees);
  const { log, client } = channelWorker();
  const result = await client(source, options('full'));
  assert.equal(log[0].type, 'analyze-frame');
  assert.ok(log[0].message.image16, 'the button sends both planes');
  if (result.angle) {
    assert.ok(result.rotatedImageData.__image16, 'the rotated 16-bit plane comes back');
    assert.deepEqual([result.rotatedImageData.width, result.rotatedImageData.height], [result.rotatedWidth, result.rotatedHeight]);
  } else {
    assert.equal(result.rotatedImageData, source, 'angle 0: the base itself, no second plane');
    assert.equal(result.rotatedIsSource, true);
  }
}

// A worker that dies holding an owned frame: the planes are lost, so the
// frame is decoded again before the main-thread fallback reads anything.
{
  const source = frame(720, 480, 2.5);
  const { client } = channelWorker({ crash: message => message.type === 'analyze-import' });
  const analysed = [];
  const reloaded = frame(720, 480, 2.5);
  const outcome = await runImportAnalyses(source, { frame: options('none'), filmEdge: true, owned: true }, {
    frameWorkerSupported: true, edgeWorkerSupported: true,
    analyzeImport: (image, config) => client.analyzeImport(image, config),
    ensureOpenCvReady: async () => true,
    analyzeOnMainThread: async (image, config) => {
      analysed.push(image);
      assert.ok(image.data.byteLength > 0, 'never a detached buffer');
      return detectFrameAndRotation(image, { ...config, rotateImageData: applyRotationToImageData });
    },
    readOnMainThread: image => readEdge(image),
    reload: async () => reloaded
  });
  assert.equal(source.data.byteLength, 0, 'the crashed worker kept the transferred plane');
  assert.deepEqual(analysed, [reloaded]);
  assert.equal(outcome.image, reloaded);
  assert.ok(outcome.detection.result.cropRegion);
  assert.equal(outcome.read.result.found, true);
}

console.log('autoFrameImport: one copy on screen, owned hand-over and rebuild, full-resolution retry, button frames, lost frames decoded again');
