// Standalone Node test for displayCanvas.js and getSprocketFrameLayout (#242):
// node negative2positive/src/app/displayCanvas.test.mjs
import assert from 'node:assert/strict';
import {
  SETTLED_DISPLAY_WORKER_MIN_PIXELS, settledDisplayRoute, step3FrameReference, upscaleReference, photoRectPercent
} from './displayCanvas.js';
import { composeSprocketFrame, getSprocketFrameLayout, getSprocketFrameMetrics } from './sprocketFrame.js';

if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) { Object.assign(this, { data, width, height }); }
  };
}

// The settled display frame goes to the worker above 1 MP when there is one.
assert.equal(SETTLED_DISPLAY_WORKER_MIN_PIXELS, 1_000_000);
assert.equal(settledDisplayRoute(1_000_000, true), 'sync');
assert.equal(settledDisplayRoute(1_000_001, true), 'worker');
assert.equal(settledDisplayRoute(4_000_000, false), 'sync', 'without a worker the display-size pass runs here');
assert.equal(settledDisplayRoute(640 * 480, true), 'sync');

// The reference is the exact plane, else the source a preview stands in for.
{
  const processed = { width: 1809, height: 1202 };
  const source = { width: 9536, height: 6336 };
  assert.equal(step3FrameReference({ processedImageData: processed, processedImageDataIsPreview: false, conversionSourceImageData: source }), processed);
  assert.equal(step3FrameReference({ processedImageData: processed, processedImageDataIsPreview: true, conversionSourceImageData: source }), source);
  assert.equal(step3FrameReference({ processedImageData: processed, processedImageDataIsPreview: true, conversionSourceImageData: null }), processed);
  assert.equal(step3FrameReference({ processedImageData: null, processedImageDataIsPreview: false, conversionSourceImageData: null }), null);
}

// Never shown past 100 % of the image the buffer represents.
assert.deepEqual(upscaleReference({ width: 9536, height: 6336 }, 1809, 1202), { width: 9536, height: 6336 });
assert.equal(upscaleReference({ width: 1809, height: 1202 }, 1809, 1202), null, 'the same size fits its own size');
assert.equal(upscaleReference({ width: 2000, height: 1202 }, 1809, 1202), null, 'not larger in both directions');
assert.equal(upscaleReference(null, 10, 10), null);
assert.equal(upscaleReference({ width: 0, height: 20 }, 10, 10), null);

assert.deepEqual(photoRectPercent({ frameWidth: 200, frameHeight: 100, x: 10, y: 25, width: 180, height: 50 }),
  { left: '5%', top: '25%', width: '90%', height: '50%' });

// The layout is where composeSprocketFrame puts the photo, landscape and
// portrait, with and without edge markings.
function sourceImage(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = (i * 7) & 255; data[i * 4 + 1] = (i * 13) & 255; data[i * 4 + 2] = (i * 29) & 255; data[i * 4 + 3] = 255;
  }
  return new ImageData(data, width, height);
}
for (const [width, height] of [[120, 80], [80, 120], [301, 199], [199, 301], [64, 64]]) {
  for (const edgeMarkings of [{}, { textEnabled: false, frameNumberEnabled: false, dxEnabled: false }]) {
    const options = { edgeMarkings };
    const source = sourceImage(width, height);
    const framed = composeSprocketFrame(source, options);
    const layout = getSprocketFrameLayout(width, height, options);
    const label = `${width}x${height} ${JSON.stringify(edgeMarkings)}`;
    assert.deepEqual([layout.frameWidth, layout.frameHeight], [framed.width, framed.height], `${label}: frame size`);
    assert.deepEqual([layout.width, layout.height], [width, height], `${label}: photo size`);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const s = (y * width + x) * 4;
        const f = ((layout.y + y) * framed.width + layout.x + x) * 4;
        for (let c = 0; c < 4; c++) {
          if (framed.data[f + c] !== source.data[s + c]) assert.fail(`${label}: photo pixel ${x},${y} is not at the layout's rectangle`);
        }
      }
    }
    if (width >= height) {
      const metrics = getSprocketFrameMetrics(width, height, options);
      assert.deepEqual([layout.x, layout.y, layout.frameWidth, layout.frameHeight],
        [metrics.sideMargin, metrics.bandHeight, metrics.outputWidth, metrics.outputHeight], `${label}: landscape is the metrics`);
    }
  }
}

console.log('displayCanvas: settle route, frame reference, no upscale past 100 %, photo rectangle and film-border layout passed');
