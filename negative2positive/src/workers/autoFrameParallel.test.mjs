// The parallel foreground detector (#252 part 4) against the serial one:
// A (this thread) with two helpers on real message channels, running the
// real stage functions and OpenCV. Every branch must deep-equal the serial
// result: a contour window, a line window, a frame that needs review
// (incomplete, ambiguous), no window, the density fallback over several
// angles and the full-resolution fallback; also with a helper that never
// starts, one that fails a stage and one that goes silent.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

globalThis.cv = await createRequire(import.meta.url)('@techstark/opencv-js');
globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const { detectFrameAndRotation, sanitizeCropRegionForImage } = await import('../app/autoFrameAnalyzer.js');
const { applyRotationToImageData } = await import('../app/imageGeometry.js');
const { createAutoFrameHelperTask } = await import('./autoFrameHelperTask.js');
const { createHelperLink, detectFrameAndRotationParallel, helperAnalyzerOptions } = await import('./autoFrameParallel.js');

let seed = 7;
const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const make = (width, height, pixel) => {
  const data = new Uint8ClampedArray(width * height * 4), data16 = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = pixel(x, y), i = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) { data[i + c] = p[c]; data16[i + c] = p[c] * 257; }
    data[i + 3] = 255; data16[i + 3] = 65535;
  }
  const image = new ImageData(data, width, height);
  image.__image16 = { width, height, data: data16 };
  return image;
};
const base = [238, 160, 100], dark = [95, 55, 30];
const tilted = (width, height, degrees, grain = 0, fraction = 0.6) => {
  const rad = degrees * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad), w = width * fraction, h = w / 1.5;
  return make(width, height, (x, y) => {
    const dx = x - width / 2, dy = y - height / 2, u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
    const g = grain ? Math.floor((random() - 0.5) * grain) : 0;
    return (Math.abs(u) < w / 2 && Math.abs(v) < h / 2 ? dark : base).map(value => value + g);
  });
};
// A thin tilted outline (contour candidates at several angles) and a
// slightly darker frame inside one (density templates): both miss the window
// search and take the fallback over two or more angles.
const outline = (width, height, degrees, delta, fraction) => {
  const rad = degrees * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad), w = width * fraction, h = w / 1.5;
  return make(width, height, (x, y) => {
    const dx = x - width / 2, dy = y - height / 2, u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
    const edge = Math.min(w / 2 - Math.abs(u), h / 2 - Math.abs(v));
    if (Math.abs(edge) < 1.5) return [60, 40, 30];
    return edge > 0 ? base.map(value => value - delta) : base;
  });
};
const images = {
  outline: outline(700, 480, 2, 0, 0.55),
  sprocket: outline(700, 480, 2, 20, 0.8),
  tilted: tilted(900, 640, 3),
  straight: tilted(900, 640, 0),
  grainy: tilted(700, 480, -2.5, 140),
  wide: tilted(900, 640, 1, 0, 0.95),
  partial: make(640, 480, (x, y) => (x >= 160 && x <= 480 ? dark.map(c => c + ((x + y) % 25)) : base)),
  twoFrames: make(1000, 400, (x, y) => (y > 80 && y < 320 && (x > 90 && x < 450 || x > 550 && x < 910) ? dark : base)),
  blank: make(480, 320, () => base),
  soft: make(800, 540, (x, y) => {
    const edge = Math.min(x - 150, 650 - x, y - 100, 440 - y), t = Math.max(0, Math.min(1, (edge + 20) / 60));
    return base.map((b, c) => Math.round(b * (1 - t) + dark[c] * t + ((x * 7 + y * 3) % 9)));
  }),
  strip: make(800, 540, (x, y) => {
    if (y < 80 || y > 460) return [245, 245, 245];
    if ((y > 105 && y < 133 || y > 409 && y < 437) && x % 48 < 18) return [245, 245, 245];
    if (y >= 150 && y <= 390 && (x >= 215 && x <= 575 || x < 195 || x > 595)) return dark.map(c => c + ((x * 13 + y * 7) % 35));
    return base;
  })
};

// A helper on the other end of a real MessageChannel; `fault` may break it.
function helper({ fault = null } = {}) {
  const { port1, port2 } = new MessageChannel();
  const task = createAutoFrameHelperTask({
    loadCv: async () => {}, rotate: applyRotationToImageData, yieldTask: () => new Promise(setImmediate),
    makeImage: (data, width, height) => new ImageData(data, width, height)
  });
  const seen = [];
  port2.onmessage = ({ data }) => {
    seen.push(data.type);
    if (fault?.(data)) return;
    void task.handle(data, message => port2.postMessage(message));
  };
  const link = createHelperLink(port1, { timeoutMs: 400 });
  return { link, seen, close() { port1.close(); port2.close(); } };
}

const strip = result => {
  if (!result) return result;
  const { stageMs, rotatedImageData, ...rest } = result;
  return { ...rest, rotated: rotatedImageData ? [rotatedImageData.width, rotatedImageData.height, Array.from(rotatedImageData.data.subarray(0, 64))] : null };
};
const optionsFor = (variant, rotatedOutput, deferFullResolution) => ({
  settings: { highConfidence: 0.72, minConfidence: 0.55, marginRatio: 0.02, filmType: 'color', deterministicPreview: true, ...variant.settings },
  maxSide: 400, rotatedOutput, deferFullResolution, frameFilmType: variant.frameFilmType, rotateImageData: applyRotationToImageData
});

const b = helper(), c = helper();
const helpers = { b: b.link, c: c.link };
const branches = new Set();
let fallbackAngles = 0, remoteUnits = 0, remotePasses = 0, compared = 0;
async function compare(label, image, options) {
  const serial = detectFrameAndRotation(image, options);
  const parallel = await detectFrameAndRotationParallel(image, options, helpers);
  assert.deepEqual(strip(parallel), strip(serial), label);
  compared++;
  const method = serial?.needsFullResolution ? 'full-resolution fallback' : serial?.diagnostics?.method || 'none';
  branches.add(method);
  if (parallel?.stageMs?.angleCount >= 2) fallbackAngles++;
  if (parallel?.stageMs) {
    assert.equal(parallel.stageMs.helpers, true);
    remoteUnits += Object.values(parallel.stageMs.units).filter(unit => unit.where === 'b').length;
    remotePasses += parallel.stageMs.passes.filter(pass => pass.where !== 'a').length;
  }
}
for (const [name, image] of Object.entries(images)) {
  const outputs = ['tilted', 'outline'].includes(name) ? [['none', false], ['full', false], ['full', true]] : [['none', false]];
  for (const [rotatedOutput, defer] of outputs) {
    await compare(`${name} ${rotatedOutput}${defer ? ' deferred' : ''}`, image, optionsFor({}, rotatedOutput, defer));
  }
}
// The grey-plane line search of a B&W frame (#251 part 4b).
for (const name of ['tilted', 'strip']) {
  await compare(`bw line search ${name}`, images[name], optionsFor({ settings: { neutralLineSearch: true }, frameFilmType: 'bw' }, 'none', false));
}
// The full-resolution finish: a crop that passes on the preview but not once
// scaled reads the rotated frame's pixels (forced here by a sanitizer that
// refuses full-size crops; the helpers only ever see the preview).
{
  const refuseFullSize = (crop, image) => (image.width >= 600 ? null : sanitizeCropRegionForImage(crop, image));
  let fullReads = 0;
  for (const name of ['outline', 'sprocket']) {
    for (const [rotatedOutput, defer] of [['none', false], ['none', true]]) {
      const image = images[name];
      const options = { ...optionsFor({}, rotatedOutput, defer), sanitizeCropRegion: refuseFullSize,
        rotateImageData: (source, angle) => { if (source === image) fullReads++; return applyRotationToImageData(source, angle); } };
      await compare(`full-resolution finish ${name} ${rotatedOutput}${defer ? ' deferred' : ''}`, image, options);
    }
  }
  assert.ok(fullReads > 0, 'the full-resolution fallback read the frame');
  branches.add('full-resolution fallback');
}

// Without contours: the line search's channel units.
const findContours = cv.findContours;
try {
  cv.findContours = () => {};
  for (const name of ['strip', 'tilted']) await compare(`no contours ${name}`, images[name], optionsFor({}, 'none', false));
} finally { cv.findContours = findContours; }
for (const branch of ['opencv-image-window', 'opencv-line-window', 'opencv-incomplete-window', 'opencv-ambiguous-window', 'none', 'full-resolution fallback']) {
  assert.ok(branches.has(branch), `covers ${branch} (${[...branches]})`);
}
assert.ok([...branches].some(branch => branch.startsWith('density')), 'covers the density fallback');
assert.ok(fallbackAngles > 0, 'a fallback over two or more angles');
assert.ok(remoteUnits > 0, 'helper B searched channel units');
assert.ok(remotePasses > 0, 'the helpers ran angle passes');
assert.ok(b.seen.includes('units') && c.seen.includes('fallback') && b.seen.includes('passes'));
assert.ok(c.seen.includes('cancel'), 'a settled window cancels the speculative fallback');

// A helper that never started, one that fails its stages, one that goes
// silent: the missing stages run on A, with the same results. (The outline
// takes the fallback, so every helper stage is asked for.)
{
  const image = images.outline, options = optionsFor({}, 'none', false);
  const serial = strip(detectFrameAndRotation(image, options));
  assert.equal(serial.diagnostics.method, 'contour');
  assert.deepEqual(strip(await detectFrameAndRotationParallel(image, options, null)), serial, 'no helpers');
  assert.deepEqual(strip(await detectFrameAndRotationParallel(image, options, { b: null, c: c.link })), serial, 'only C');
  assert.deepEqual(strip(await detectFrameAndRotationParallel(image, options, { b: b.link, c: null })), serial, 'only B');
  const erroring = createAutoFrameHelperTask({ loadCv: async () => { throw new Error('OpenCV failed to load'); }, rotate: applyRotationToImageData });
  const { port1, port2 } = new MessageChannel();
  port2.onmessage = ({ data }) => { void erroring.handle(data, message => port2.postMessage(message)); };
  const failing = createHelperLink(port1, { timeoutMs: 400 });
  assert.deepEqual(strip(await detectFrameAndRotationParallel(image, options, { b: failing, c: failing })), serial, 'helpers whose stages fail');
  const silent = helper({ fault: () => true });
  assert.deepEqual(strip(await detectFrameAndRotationParallel(image, options, { b: silent.link, c: silent.link })), serial, 'silent helpers time out');
  assert.equal(silent.link.broken, true, 'a silent helper is given up');
  assert.deepEqual(strip(await detectFrameAndRotationParallel(image, options, { b: silent.link, c: silent.link })), serial, 'and not asked again');
  silent.close(); port1.close(); port2.close();
  try {
    cv.findContours = () => {};
    const lines = strip(detectFrameAndRotation(images.strip, options));
    const silentUnits = helper({ fault: data => data.type === 'units' });
    assert.deepEqual(strip(await detectFrameAndRotationParallel(images.strip, options, { b: silentUnits.link, c: c.link })), lines, 'units computed on A when B is silent');
    silentUnits.close();
  } finally { cv.findContours = findContours; }
}
assert.deepEqual(Object.keys(helperAnalyzerOptions({ rotateImageData() {}, sanitizeCropRegion() {}, deferFullResolution: true, settings: {}, maxSide: 3 })).sort(), ['maxSide', 'settings']);
b.close(); c.close();
console.log(`autoFrameParallel: ${compared} detections equal the serial detector (${[...branches].join(', ')}); helpers ran ${remoteUnits} units and ${remotePasses} passes`);
