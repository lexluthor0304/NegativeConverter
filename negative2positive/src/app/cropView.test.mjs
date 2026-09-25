// Standalone Node test for the crop view (#245) - run with:
// node negative2positive/src/app/cropView.test.mjs
//
// Crop mode draws the base proxy on its own canvas and turns it with canvas
// transforms: base -> rotation -> mirror (the working frame), then the draft
// angle, scaled to the canvas. Hit-testing and Apply's rectangle mapping are
// right only if that drawing puts every base pixel where the pixel pipeline
// puts it: the geometry chain for the working frame, then
// applyRotationToImageData by the draft angle. The real drawCropView runs
// against a context that tracks its transform; a single bright base pixel is
// followed through the real geometry core and compared.

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const { applyRotationToImageData, applyGeometryChainToImageData, mirrorImageDataHorizontal, rotatedDimensions, normalizeAngleDegrees, sanitizeCropRect } = await import('./imageGeometry.js');
const { cropImageDataRegion } = await import('./imageDataOps.js');
const { displayPreviewSize } = await import('./displayPreview.js');

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `runtime function exists: ${name}`);
  const end = source.indexOf('\n    }', match.index);
  return source.slice(match.index, end + '\n    }'.length);
}

// A 2D context that keeps the current transform and records each draw.
function trackingContext() {
  let m = [1, 0, 0, 1, 0, 0];
  const multiply = (n) => {
    const [a, b, c, d, e, f] = m;
    m = [a * n[0] + c * n[1], b * n[0] + d * n[1], a * n[2] + c * n[3], b * n[2] + d * n[3], a * n[4] + c * n[5] + e, b * n[4] + d * n[5] + f];
  };
  const ctx = {
    draws: [], fills: [], imageSmoothingEnabled: false, fillStyle: '',
    setTransform: (...values) => { m = values; },
    scale: (x, y) => multiply([x, 0, 0, y, 0, 0]),
    translate: (x, y) => multiply([1, 0, 0, 1, x, y]),
    rotate: (r) => multiply([Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]),
    clearRect() {},
    fillRect: (x, y, w, h) => ctx.fills.push({ matrix: [...m], rect: [x, y, w, h] }),
    drawImage: (image, x, y, w, h) => ctx.draws.push({ matrix: [...m], image, rect: [x, y, w, h] })
  };
  return ctx;
}
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const invert = (m, x, y) => {
  const det = m[0] * m[3] - m[1] * m[2];
  const dx = x - m[4], dy = y - m[5];
  return [(m[3] * dx - m[2] * dy) / det, (-m[1] * dx + m[0] * dy) / det];
};

const context = vm.createContext({
  Math, state: null, cropCanvas: { width: 1, height: 1 }, cropCtx: null,
  cropViewStats: { draws: 0 }, normalizeAngleDegrees
});
vm.runInContext(['getCropDraftTotalAngle', 'drawCropView'].map(functionSource).join('\n'), context);

function makeBase(width, height, spots) {
  const data16 = new Uint16Array(width * height * 4);
  const data8 = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data16.length; i += 4) { data16[i + 3] = 65535; data8[i + 3] = 255; }
  // Each spot in a channel of its own, so no spot is mistaken for another.
  spots.forEach(([x, y], channel) => {
    const o = (y * width + x) * 4 + channel;
    data16[o] = 65535; data8[o] = 255;
  });
  const image = new ImageData(data8, width, height);
  image.__image16 = { width, height, data: data16 };
  return image;
}

// Centroid of the spot of `channel` within 4 px of `near` (pixel centres).
function spotCentroid(image, near, channel) {
  const plane = image.__image16?.data || image.data;
  const full = image.__image16 ? 65535 : 255;
  let sx = 0, sy = 0, sw = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    if (Math.hypot(x + 0.5 - near[0], y + 0.5 - near[1]) > 4) continue;
    const v = plane[(y * image.width + x) * 4 + channel] / full;
    if (v < 0.05) continue;
    sx += (x + 0.5) * v; sy += (y + 0.5) * v; sw += v;
  }
  assert.ok(sw > 0, 'spot found');
  return [sx / sw, sy / sw];
}

const W = 64, H = 42;
const spots = [[12, 9], [50, 31], [31, 20]];
const base = makeBase(W, H, spots);
const chainSteps = {
  rotate: applyRotationToImageData, mirror: mirrorImageDataHorizontal,
  crop: (image, crop, bounds = image) => { const rect = sanitizeCropRect(crop, bounds); if (!image) return rect; return rect ? cropImageDataRegion(image, rect) : image; }
};
let checked = 0;
for (const rotationAngle of [0, 90, -90, 180, 7.3, -12.5]) {
  for (const mirrored of [false, true]) {
    for (const draftAngle of [0, 3.1, -20, 90]) {
      // The pixel pipeline: the working frame, then Apply's draft rotation.
      const frame = applyGeometryChainToImageData(base, { rotationAngle, mirrored }, chainSteps);
      const turnedImage = applyRotationToImageData(frame, draftAngle);
      const turned = rotatedDimensions(frame.width, frame.height, draftAngle);
      assert.deepEqual([turnedImage.width, turnedImage.height], [turned.width, turned.height]);
      // The crop view: canvas at a display size of its own.
      const size = displayPreviewSize(turned.width, turned.height, { viewportWidth: 50, viewportHeight: 40, dpr: 2 });
      const ctx = trackingContext();
      context.cropCtx = ctx;
      context.cropCanvas = { width: 1, height: 1 };
      context.state = {
        cropping: true,
        cropDraft: {
          view: { space: 'base', surface: 'proxy', width: W, height: H, rotationAngle, mirrored },
          rotatedSize: size, frameSize: { width: frame.width, height: frame.height }, draftFrame: turned,
          rotationBase: 0, straightenAngle: draftAngle
        }
      };
      context.drawCropView();
      assert.deepEqual([context.cropCanvas.width, context.cropCanvas.height], [size.width, size.height], 'canvas at the draft size');
      assert.equal(ctx.draws.length, 1, 'one drawImage');
      assert.deepEqual(ctx.draws[0].rect, [0, 0, W, H], 'the proxy is drawn at the base size');
      assert.equal(ctx.fills.length, rotationAngle % 90 !== 0 ? 1 : 0, 'black corners only for a tilted frame');
      const kx = size.width / turned.width, ky = size.height / turned.height;
      for (const [channel, [bx, by]] of spots.entries()) {
        const [cx, cy] = apply(ctx.draws[0].matrix, bx + 0.5, by + 0.5);
        const expected = spotCentroid(turnedImage, [cx / kx, cy / ky], channel);
        assert.ok(Math.abs(cx / kx - expected[0]) < 0.6 && Math.abs(cy / ky - expected[1]) < 0.6,
          `rot ${rotationAngle} mirror ${mirrored} draft ${draftAngle}: base (${bx}, ${by}) drawn at ${[cx / kx, cy / ky].map(v => v.toFixed(2))}, pipeline ${expected.map(v => v.toFixed(2))}`);
        checked++;
      }

      // The stand-in (a sample of the working frame, drawn as the frame) puts
      // the frame's spots where the pipeline puts them too.
      const standIn = trackingContext();
      context.cropCtx = standIn;
      context.state.cropDraft.view = { space: 'frame', surface: 'sample', width: frame.width, height: frame.height, rotationAngle: 0, mirrored: false };
      context.drawCropView();
      assert.equal(standIn.fills.length, 0);
      assert.deepEqual(standIn.draws[0].rect, [0, 0, frame.width, frame.height]);
      for (const [channel, [bx, by]] of spots.entries()) {
        // Where the base spot is in the frame, by the proxy's own mapping
        // (already checked above), then back through the stand-in's.
        const [cx, cy] = apply(ctx.draws[0].matrix, bx + 0.5, by + 0.5);
        const inFrame = spotCentroid(frame, invert(standIn.draws[0].matrix, cx, cy), channel);
        const [sx, sy] = apply(standIn.draws[0].matrix, inFrame[0], inFrame[1]);
        assert.ok(Math.abs(sx - cx) < 0.6 * kx + 1e-9 && Math.abs(sy - cy) < 0.6 * ky + 1e-9, `stand-in rot ${rotationAngle} mirror ${mirrored} draft ${draftAngle}`);
      }
    }
  }
}
assert.equal(checked, 6 * 2 * 4 * spots.length);

// Nothing is drawn outside crop mode or without a view.
context.state = { cropping: false, cropDraft: null };
const idle = trackingContext();
context.cropCtx = idle;
context.drawCropView();
assert.equal(idle.draws.length, 0);

console.log(`cropView tests passed (${checked} spots)`);
