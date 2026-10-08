import assert from 'node:assert/strict';
globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const { createAutoFrameWorkerClient } = await import('./autoFrameWorkerClient.js');
const { markDerivedEightBit, configurePlaneGuard, planeGuardReport } = await import('./crossOriginIsolation.js');
const { runImportRequest, requestRgba } = await import('../workers/autoFrameImportTask.js');

// #264 Part A phase 2: a frame whose 16-bit plane is shared goes to the
// auto-frame worker without a copy of it, and without any 8-bit bytes when
// its 8-bit plane is that plane >>> 8 (a fresh decode): the worker derives
// them. Nothing is transferred, so the caller keeps its frame.
configurePlaneGuard({ enabled: true });
function frame({ shared = true, derived = true } = {}) {
  const width = 3, height = 2;
  const data16 = shared ? new Uint16Array(new SharedArrayBuffer(width * height * 8)) : new Uint16Array(width * height * 4);
  for (let i = 0; i < data16.length; i++) data16[i] = (i % 4 === 3) ? 65535 : 1000 + i * 2551;
  const image = new ImageData(Uint8ClampedArray.from(data16, (v) => v >>> 8), width, height);
  image.__image16 = { width, height, data: data16 };
  if (derived) markDerivedEightBit(image);
  return image;
}

function client(reply) {
  const posted = [];
  const analyze = createAutoFrameWorkerClient({ workerFactory: () => ({
    terminate() {},
    postMessage(message, transfers) {
      posted.push({ message, transfers });
      queueMicrotask(() => this.onmessage({ data: { id: message.id, result: reply(message) } }));
    }
  }) });
  return { analyze, posted };
}

{
  // analyze-import of an editor frame: the shared plane, derive8, no transfer.
  const image = frame();
  const { analyze, posted } = client((message) => ({ frame: { angle: 0, rotatedIsSource: true }, filmEdge: { found: false }, rgba: message.rgba, image16: message.image16 }));
  const outcome = await analyze.analyzeImport(image, { frame: {}, filmEdge: {}, owned: true });
  const [{ message, transfers }] = posted;
  assert.equal(message.derive8, true);
  assert.equal(message.rgba, undefined, 'no 8-bit bytes are sent');
  assert.equal(message.image16, image.__image16.data, 'the shared view itself');
  assert.equal(message.returnPlanes, false, 'nothing moved, nothing to hand back');
  assert.deepEqual(transfers, []);
  assert.equal(message.image16Omitted, false, 'the worker has the exact 16-bit plane at once');
  assert.equal(outcome.image, image, 'the caller keeps its own frame');
  assert.equal(outcome.imageLost, false);
  assert.equal(image.data.byteLength, 24, 'nothing was detached');
}
{
  // A shared plane without a derived 8-bit plane: the 8-bit plane is still
  // copied (or moved, when owned) and comes back; the 16-bit one never moves.
  const image = frame({ derived: false });
  const { analyze, posted } = client((message) => ({ frame: null, filmEdge: null, rgba: message.rgba, image16: undefined }));
  const outcome = await analyze.analyzeImport(image, { frame: {}, filmEdge: {}, owned: false });
  const [{ message, transfers }] = posted;
  assert.equal(message.derive8, false);
  assert.notEqual(message.rgba.buffer, image.data.buffer, 'a copy of the 8-bit plane');
  assert.equal(message.image16, image.__image16.data);
  assert.deepEqual(transfers, [message.rgba.buffer]);
  assert.equal(outcome.image, image);
}
{
  // read-film-edge and analyze-frame on a shared, derived frame.
  const image = frame();
  const { analyze, posted } = client(() => ({ found: false }));
  await analyze(image, {}, 'read-film-edge');
  await analyze(image, {}, 'analyze-frame');
  for (const { message, transfers } of posted) {
    assert.equal(message.derive8, true, message.type);
    assert.equal(message.rgba, undefined);
    assert.equal(message.image16, image.__image16.data);
    assert.deepEqual(transfers, []);
  }
}
{
  // Plain planes: as before (copies of both, transferred).
  const image = frame({ shared: false });
  const { analyze, posted } = client(() => ({ angle: 0 }));
  await analyze(image, {}, 'analyze-frame');
  const [{ message, transfers }] = posted;
  assert.equal(message.derive8, false);
  assert.notEqual(message.rgba.buffer, image.data.buffer);
  assert.notEqual(message.image16.buffer, image.__image16.data.buffer);
  assert.equal(transfers.length, 2);
}
assert.equal(planeGuardReport().violations.length, 0);
assert.ok(planeGuardReport().checks >= 4, 'every request with a shared plane was checked');

// ---- the worker side
{
  const image = frame();
  const derived = requestRgba({ derive8: true, image16: image.__image16.data });
  assert.deepEqual([...derived], [...image.data], 'the derived bytes are the page\'s 8-bit plane');
  assert.equal(requestRgba({ rgba: image.data }), image.data);
  const seen = [];
  const { reply, transfers } = await runImportRequest({
    type: 'analyze-import', width: image.width, height: image.height, image16: image.__image16.data, derive8: true,
    frame: {}, filmEdge: {}, returnPlanes: true
  }, {
    loadCv: async () => {},
    detect: (input) => { seen.push([...input.data]); return { angle: 0 }; },
    rotate: () => null,
    readEdge: async (input) => { seen.push([...input.data]); return { found: false }; }
  });
  assert.deepEqual(seen, [[...image.data], [...image.data]], 'both analyses read the derived 8-bit plane');
  assert.equal(reply.image16, undefined, 'a shared plane is never sent back');
  assert.ok(!transfers.includes(image.__image16.data.buffer));
}
configurePlaneGuard({ enabled: null });
console.log('auto-frame client: shared planes go without copies');
