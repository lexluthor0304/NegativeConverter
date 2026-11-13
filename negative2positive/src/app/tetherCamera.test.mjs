import assert from 'node:assert/strict';
import { TETHER_PREFIX, isTetherDevice, tetherErrorKey, createTetherFeed, exposureVerdict, SHUTTER_AUTO, shutterLabel, shutterChoices, compensationLabel } from './tetherCamera.js';

assert.equal(isTetherDevice(TETHER_PREFIX + 'abc'), true);
for (const other of [null, undefined, '', 'abc', 42]) assert.equal(isTetherDevice(other), false);

assert.equal(tetherErrorKey('unsupported-camera'), 'loupeTetherUnsupported');
assert.equal(tetherErrorKey(new Error('no-folder')), 'loupeTetherFolder');
assert.equal(tetherErrorKey('camera-busy'), 'loupeTetherBusy');
assert.equal(tetherErrorKey('live view: the camera answered 0x2002'), 'loupeTetherFailed');
assert.equal(tetherErrorKey(undefined), 'loupeTetherFailed');

function fakeCanvas() {
  const drawn = [];
  return { width: 0, height: 0, drawn, getContext: () => ({ drawImage: (bitmap, x, y) => drawn.push([bitmap.id, x, y]) }) };
}

// Frames are drawn in order, the canvas takes the frame's size, "not-ready"
// is waited out, and every bitmap is closed.
{
  const canvas = fakeCanvas();
  const answers = ['a', new Error('not-ready'), 'b', 'c'];
  const closed = [];
  const waits = [];
  let feed;
  const invoke = async (command) => {
    assert.equal(command, 'tether_frame');
    // After the last frame the test stops the feed from inside its next request.
    if (!answers.length) { void feed.stop(); throw new Error('not-ready'); }
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  feed = createTetherFeed({
    invoke, canvas,
    decode: async (bytes) => ({ id: bytes, width: 1536, height: 1024, close() { closed.push(bytes); } }),
    wait: async (ms) => { waits.push(ms); },
    onError: () => assert.fail('a camera between frames is not an error')
  });
  await feed.done;
  assert.deepEqual(canvas.drawn, [['a', 0, 0], ['b', 0, 0], ['c', 0, 0]]);
  assert.deepEqual([canvas.width, canvas.height], [1536, 1024]);
  assert.deepEqual(waits, [60]);
  assert.deepEqual(closed, ['a', 'b', 'c']);
  assert.equal(feed.frames, 3);
}

// A camera that keeps failing ends the feed once, with its error.
{
  const errors = [];
  let calls = 0;
  const feed = createTetherFeed({
    invoke: async () => { calls++; throw new Error('the camera did not answer'); },
    canvas: fakeCanvas(), decode: async () => assert.fail('nothing to decode'), wait: async () => {},
    onError: (error) => errors.push(error.message), maxFailures: 3
  });
  await feed.done;
  assert.deepEqual(errors, ['the camera did not answer']);
  assert.equal(calls, 3);
}

// So does one that never becomes ready; a frame in between resets the count.
{
  const errors = [];
  const script = ['not-ready', 'not-ready', 'frame', 'not-ready', 'not-ready', 'not-ready'];
  const feed = createTetherFeed({
    invoke: async () => { const next = script.shift() ?? 'not-ready'; if (next === 'frame') return next; throw next; },
    canvas: fakeCanvas(), decode: async (bytes) => ({ id: bytes, width: 4, height: 4 }), wait: async () => {},
    onError: (error) => errors.push(String(error)), maxNotReady: 3
  });
  await feed.done;
  assert.deepEqual(errors, ['not-ready']);
  assert.equal(feed.frames, 1);
  assert.deepEqual(script, []);
}

// Stopped while a frame is on its way: it is not drawn, and nothing is reported.
{
  const canvas = fakeCanvas();
  let release;
  const feed = createTetherFeed({
    invoke: () => new Promise((resolve) => { release = resolve; }),
    canvas, decode: async () => assert.fail('a stopped feed decodes nothing'), wait: async () => {},
    onError: () => assert.fail('stopping is not an error')
  });
  await Promise.resolve();
  const stopped = feed.stop();
  release('late');
  await stopped;
  assert.deepEqual(canvas.drawn, []);
}

// Exposure of the frame on the copy stand.
{
  const frame = (count, pixel) => { const data = new Uint8ClampedArray(count * 4); for (let i = 0; i < count; i++) data.set(pixel(i), i * 4); return data; };
  // A negative on a light table: bright orange base, darker picture. Exposed well.
  assert.equal(exposureVerdict(frame(4000, (i) => (i % 4 === 0 ? [215, 150, 95, 255] : [120, 70, 40, 255])), 1), 'ok');
  // Dim: even the base is below 60 %.
  assert.equal(exposureVerdict(frame(4000, (i) => (i % 4 === 0 ? [120, 85, 50, 255] : [60, 35, 20, 255])), 1), 'under');
  // The base clips in the red channel.
  assert.equal(exposureVerdict(frame(4000, (i) => (i % 4 === 0 ? [255, 180, 110, 255] : [120, 70, 40, 255])), 1), 'over');
  // A few specular pixels (0.5 %) are not overexposure.
  assert.equal(exposureVerdict(frame(4000, (i) => (i % 200 === 0 ? [255, 255, 255, 255] : [200, 140, 90, 255])), 1), 'ok');
  // Sampling every 8th pixel gives the same verdicts; an empty frame is not a warning.
  assert.equal(exposureVerdict(frame(40000, () => [120, 85, 50, 255])), 'under');
  assert.equal(exposureVerdict(new Uint8ClampedArray(0)), 'ok');
}

// Exposure settings in the camera's own units.
assert.equal(shutterLabel(SHUTTER_AUTO), null);
assert.deepEqual([1536, 2048, 0, -256, -768, 3072, 1664, 256, 128, -128].map(shutterLabel), ['1/60', '1/250', '1s', '2s', '8s', '1/4000', '1/90', '1/2', '0.7s', '1.5s']);
const speeds = shutterChoices();
assert.deepEqual([speeds[0], speeds.at(-1), speeds.length], [-768, 3072, 31]);
assert.ok(speeds.includes(1536) && speeds.every((value, index) => index === 0 || value - speeds[index - 1] === 128));
assert.equal(new Set(speeds.map(shutterLabel)).size, speeds.length, 'every offered speed has its own label');
assert.deepEqual([0, 1000, -333, 667, -3000, 333].map(compensationLabel), ['0', '+1', '\u22120.3', '+0.7', '\u22123', '+0.3']);

console.log('tetherCamera: frames are drawn in order at their own size, a camera between frames is waited out, a camera that keeps failing or never becomes ready ends the feed once, a stopped feed draws nothing, and the exposure verdict tells a clipped base and a dim frame from a good one');
