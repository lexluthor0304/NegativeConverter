// Standalone Node test for planeRelease.js (#250): which planes an export may
// hand to a worker without a copy, and which it may free when it ends.
import assert from 'node:assert/strict';

const {
  configurePlaneRelease,
  detectReleaseEngine,
  isLiveMutableBuffer,
  isOwnedBuffer,
  markLiveMutableBuffer,
  markOwnedPlanes,
  mayTransferBuffer,
  planeBuffersOf,
  releaseOwnedPlanes,
  setLiveReferenceProbe,
  sharesPlaneBuffers
} = await import('./planeRelease.js');

function frame(width = 4, height = 3, { plane16 = true } = {}) {
  const image = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  if (plane16) image.__image16 = { width, height, data: new Uint16Array(width * height * 4) };
  return image;
}

// A throwaway worker that behaves like a real one: the transfer list detaches
// the caller's buffers, and it answers once it has them.
const sinks = [];
class FakeSink {
  constructor() {
    this.onmessage = null;
    this.terminated = false;
    this.received = null;
    sinks.push(this);
  }
  postMessage(message, transfers = []) {
    this.received = structuredClone({ message, transfers }, { transfer: transfers }).transfers;
    queueMicrotask(() => this.onmessage && this.onmessage({ data: 0 }));
  }
  terminate() { this.terminated = true; }
}

// ------------------------------------------------------------- the stamps
{
  const image = frame();
  const [data, plane] = planeBuffersOf(image);
  assert.equal(data, image.data.buffer);
  assert.equal(plane, image.__image16.data.buffer);
  assert.equal(isOwnedBuffer(data), false, 'nothing is owned until a producer says so');
  assert.equal(markOwnedPlanes(image), image);
  assert.ok(isOwnedBuffer(data) && isOwnedBuffer(plane));
  assert.deepEqual(planeBuffersOf(image.data), [image.data.buffer], 'a typed array names its buffer');
  // A plane-only result (`{ width, height, __image16 }`) has no 8-bit buffer.
  assert.deepEqual(planeBuffersOf({ width: 1, height: 1, __image16: image.__image16 }), [plane]);
  const shared = { width: 4, height: 3, data: image.data, __image16: image.__image16 };
  assert.equal(planeBuffersOf(shared).length, 2);
  assert.equal(sharesPlaneBuffers(shared, image), true);
  assert.equal(sharesPlaneBuffers({ width: 4, height: 3, __image16: image.__image16 }, image), true, 'one shared buffer is enough');
  assert.equal(sharesPlaneBuffers(frame(), image), false);
  assert.equal(sharesPlaneBuffers({ width: 4, height: 3 }, image), false, 'a size stub shares nothing');
  assert.equal(sharesPlaneBuffers(null, image), false);
}

{
  // Transfer needs a stamp and no live reference.
  setLiveReferenceProbe(null);
  const owned = markOwnedPlanes(frame());
  const unowned = frame();
  assert.equal(mayTransferBuffer(owned.data.buffer), true);
  assert.equal(mayTransferBuffer(unowned.data.buffer), false, 'unstamped planes are copied');
  const live = new Set([owned.__image16.data.buffer]);
  setLiveReferenceProbe(() => live);
  assert.equal(mayTransferBuffer(owned.__image16.data.buffer), false, 'a stamped plane the editor references is copied');
  assert.equal(mayTransferBuffer(owned.data.buffer), true);
  setLiveReferenceProbe(() => { throw new Error('probe failed'); });
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(mayTransferBuffer(owned.data.buffer), false, 'a failing probe transfers nothing');
  } finally {
    console.warn = warn;
  }
  setLiveReferenceProbe(null);
  owned.data.buffer.transfer(0);
  assert.equal(mayTransferBuffer(owned.data.buffer), false, 'a detached buffer cannot move again');
}

{
  const display = frame(2, 2, { plane16: false });
  markLiveMutableBuffer(display);
  assert.ok(isLiveMutableBuffer(display.data.buffer));
  // The export wrapper #240 builds around the display buffer shares it.
  const wrapper = { width: 2, height: 2, data: display.data };
  assert.ok(isLiveMutableBuffer(wrapper.data.buffer));
  assert.equal(isLiveMutableBuffer(frame().data.buffer), false);
}

// ------------------------------------------------------------ release rules
{
  configurePlaneRelease({ engine: 'webkit' });
  const state = { displayImageData: markOwnedPlanes(frame()), processedImageData: markOwnedPlanes(frame()) };
  const session = markOwnedPlanes(frame());
  const history = markOwnedPlanes(frame());
  setLiveReferenceProbe(() => {
    const buffers = new Set();
    for (const item of [state.displayImageData, state.processedImageData, session, history]) {
      for (const buffer of planeBuffersOf(item)) buffers.add(buffer);
    }
    return buffers;
  });
  const exported = markOwnedPlanes(frame());
  // The export wrapper shares the display buffer, and an identity recipe
  // shares the processed plane: both must be refused, compared by buffer.
  const wrapper = { width: 4, height: 3, data: state.displayImageData.data };
  const identity = { width: 4, height: 3, data: exported.data, __image16: state.processedImageData.__image16 };
  const unstamped = frame();
  const summary = releaseOwnedPlanes(exported, exported, wrapper, identity, session, history, unstamped, null, undefined);
  assert.equal(summary.method, 'transfer');
  assert.equal(summary.released, 2, 'exactly the export-owned data and plane of `exported`');
  assert.equal(summary.bytes, 4 * 3 * 4 + 4 * 3 * 8);
  assert.equal(exported.data.byteLength, 0, 'WebKit frees with transfer(0)');
  assert.equal(exported.__image16.data.byteLength, 0);
  assert.equal(state.displayImageData.data.length, 4 * 3 * 4, 'the display buffer survives its wrapper');
  assert.equal(state.processedImageData.__image16.data.length, 4 * 3 * 4, 'the editor plane survives the identity alias');
  assert.equal(session.data.length, 48);
  assert.equal(history.__image16.data.length, 48);
  assert.equal(unstamped.data.length, 48, 'unstamped planes are never released');
  assert.equal(summary.refused, 2 + 2 + 2 + 2);
  // Released buffers are detached now: a second call skips them.
  const again = releaseOwnedPlanes(exported);
  assert.equal(again.released, 0);
  assert.equal(again.skipped, 2);
  setLiveReferenceProbe(null);
}

{
  // WebKit without ArrayBuffer.prototype.transfer (Safari < 17.4): drop only.
  configurePlaneRelease({ engine: 'webkit' });
  const image = markOwnedPlanes(frame());
  const proto = ArrayBuffer.prototype;
  const transfer = Object.getOwnPropertyDescriptor(proto, 'transfer');
  delete proto.transfer;
  try {
    const summary = releaseOwnedPlanes(image);
    assert.equal(summary.method, 'drop');
    assert.equal(summary.released, 2);
    assert.equal(image.data.length, 48, 'nothing is copied or detached');
  } finally {
    Object.defineProperty(proto, 'transfer', transfer);
  }
}

{
  // Chromium: one throwaway worker gets every buffer in one transfer list.
  sinks.length = 0;
  configurePlaneRelease({ engine: 'chromium', workerFactory: () => new FakeSink() });
  const a = markOwnedPlanes(frame());
  const b = markOwnedPlanes(frame());
  const summary = releaseOwnedPlanes(a, b, a);
  assert.equal(summary.method, 'worker');
  assert.equal(sinks.length, 1, 'one worker per call, never one per buffer');
  assert.equal(sinks[0].received.length, 4);
  assert.equal(a.data.byteLength, 0);
  assert.equal(b.__image16.data.byteLength, 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(sinks[0].terminated, 'the worker is terminated once it holds the buffers');

  // A worker that cannot start leaves the references to be dropped.
  configurePlaneRelease({ engine: 'chromium', workerFactory: () => { throw new Error('CSP'); } });
  const c = markOwnedPlanes(frame());
  assert.equal(releaseOwnedPlanes(c).method, 'drop');
  assert.equal(c.data.length, 48);
  // Nothing to release starts no worker.
  sinks.length = 0;
  configurePlaneRelease({ engine: 'chromium', workerFactory: () => new FakeSink() });
  assert.equal(releaseOwnedPlanes(frame(), null).released, 0);
  assert.equal(sinks.length, 0);
}

{
  // Main-thread cost: well under 10 ms per call for a 60 MP frame's planes
  // (the buffers themselves are small here; the work is per buffer, not per byte).
  configurePlaneRelease({ engine: 'chromium', workerFactory: () => new FakeSink() });
  const items = Array.from({ length: 6 }, () => markOwnedPlanes(frame(1024, 1024)));
  const liveSet = new Set(Array.from({ length: 40 }, () => new ArrayBuffer(8)));
  setLiveReferenceProbe(() => liveSet);
  const started = performance.now();
  const summary = releaseOwnedPlanes(...items);
  const elapsed = performance.now() - started;
  assert.equal(summary.released, 12);
  assert.ok(elapsed < 10, `release took ${elapsed.toFixed(2)} ms`);
  setLiveReferenceProbe(null);
  configurePlaneRelease({ engine: 'webkit' });
  const webkitItems = Array.from({ length: 6 }, () => markOwnedPlanes(frame(1024, 1024)));
  const t0 = performance.now();
  releaseOwnedPlanes(...webkitItems);
  const webkitElapsed = performance.now() - t0;
  assert.ok(webkitElapsed < 10, `transfer(0) release took ${webkitElapsed.toFixed(2)} ms`);
}

// ------------------------------------------------------ engine detection
{
  const nav = (userAgent, brands) => ({ navigator: { userAgent, ...(brands ? { userAgentData: { brands } } : {}) } });
  assert.equal(detectReleaseEngine(nav('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15')), 'webkit');
  assert.equal(detectReleaseEngine(nav('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko)')), 'webkit', 'WKWebView has no Safari token');
  assert.equal(detectReleaseEngine(nav('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15')), 'webkit', 'WebKitGTK');
  assert.equal(detectReleaseEngine(nav('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36')), 'chromium');
  assert.equal(detectReleaseEngine(nav('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0'), [{ brand: 'Microsoft Edge' }]), 'chromium', 'WebView2');
  assert.equal(detectReleaseEngine(nav('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0')), 'none');
  assert.equal(detectReleaseEngine({}), 'none');
}

configurePlaneRelease();
console.log('planeRelease.test.mjs passed');
