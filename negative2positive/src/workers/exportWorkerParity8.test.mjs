// Standalone Node test: the export worker's 8-bit `applyAdjustments` equals
// the main-thread Step-3 pass it replaces, byte for byte (#242). Run with:
// node negative2positive/src/workers/exportWorkerParity8.test.mjs
//
// #242 removes updateFullCpu, which ran Step 3 over the processed frame on
// the main thread at quality 'full' and handed an 8-bit export that buffer.
// Exports now always take the export worker, and the settled CPU display
// takes it above 1 MP. The real exportWorker.js handler runs in-process
// behind the real bridge; every message crosses a structured clone both ways.
// The reference is a frozen copy of HEAD 1703835's main-thread stage:
// applyAdjustmentsToBuffer(source, state, buffer, 'full') with the display's
// shared LUT scratch.
import assert from 'node:assert/strict';

import { applyAdjustmentsToPixels, computeAdjustmentParams } from './pixelAdjustments.js';
import { downconvertPlane16 } from './pixelAdjustments16.js';
import { analyzeExpiredFilm, EXPIRED_RESCUE_DEFAULTS, EXPIRED_SPATIAL_VERSION } from '../pipeline/expiredRescue.js';

globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    if (!(data instanceof Uint8ClampedArray)) throw new TypeError('ImageData needs a Uint8ClampedArray');
    if (data.length !== 4 * width * height) throw new DOMException('bad length', 'IndexSizeError');
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

let activeWorker = null;
globalThis.self = {
  onmessage: null,
  postMessage(message, transfers = []) {
    const cloned = structuredClone(message, { transfer: transfers });
    const target = activeWorker;
    queueMicrotask(() => target && target.onmessage && target.onmessage({ data: cloned }));
  }
};
await import('./exportWorker.js');

class InProcessWorker {
  constructor() {
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    activeWorker = this;
  }

  postMessage(message, transfers = []) {
    const received = structuredClone(message, { transfer: transfers });
    queueMicrotask(() => self.onmessage({ data: received }));
  }

  terminate() {
    if (activeWorker === this) activeWorker = null;
  }
}

const { createExportWorkerBridge } = await import('./workerBridge.js');
const { applyPreparedAdjustmentsToBuffer, createAdjustmentLutScratch } = await import('../app/adjustmentPipeline.js');
const bridge = createExportWorkerBridge({ workerFactory: () => new InProcessWorker() });

// ------------------------------------------ frozen reference (HEAD 1703835)

// updateFullCpu -> applyAdjustmentsToBuffer(source, state, fullAdjustedBuffer, 'full')
// -> applyPreparedAdjustmentsToBuffer(source, prepared, output, { quality, lutScratch }).
function frozenMainThreadStage(imageData, prepared, output, lutScratch) {
  const params = computeAdjustmentParams(prepared, { width: imageData.width, height: imageData.height });
  applyAdjustmentsToPixels(imageData.data, output.data, imageData.width * imageData.height, params, 'full', null, 500000, lutScratch);
}

// ------------------------------------------------------------- the frames

function makeFrame(width, height, seed = 12345) {
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const plane = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = (y * width + x) * 4;
    // A warm diagonal ramp with a fog-like lift on the left and some grain.
    const t = (x / Math.max(1, width - 1)) * 0.7 + (y / Math.max(1, height - 1)) * 0.3;
    const lift = 0.12 * (1 - x / Math.max(1, width - 1));
    const grain = ((next() >>> 20) - 2048) * 2;
    const v = (lift + (1 - lift) * t) * 65535;
    plane[o] = Math.max(0, Math.min(65535, Math.round(v + grain)));
    plane[o + 1] = Math.max(0, Math.min(65535, Math.round(v * 0.86 + grain)));
    plane[o + 2] = Math.max(0, Math.min(65535, Math.round(v * 0.7 + grain)));
    plane[o + 3] = 65535;
  }
  const image = new ImageData(downconvertPlane16(plane, new Uint8ClampedArray(plane.length)), width, height);
  image.__image16 = { width, height, data: plane };
  return image;
}

const linearCurve = () => Uint8Array.from({ length: 256 }, (_, v) => v);
const sCurve = () => Uint8Array.from({ length: 256 }, (_, v) => Math.round(255 * (0.5 - 0.5 * Math.cos(Math.PI * v / 255))));
const base = {
  curves: { r: linearCurve(), g: linearCurve(), b: linearCurve() },
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, temperature: 0, tint: 0,
  saturation: 0, vibrance: 0, cyan: 0, magenta: 0, yellow: 0, wbR: 1, wbG: 1, wbB: 1,
  look: null,
  ...EXPIRED_RESCUE_DEFAULTS,
  expiredAnalysis: null,
  cropRegion: { left: 2, top: 1, width: 40, height: 28 },
  rotationAngle: 0.4,
  mirrored: false,
  filmType: 'color',
  frameMetadata: { frame: '12A', notes: 'parity' }
};
const measured = analyzeExpiredFilm(makeFrame(45, 31), { borderBuffer: 0 });
assert.ok(measured, 'the synthetic frame yields an expired-film measurement');
const spatial = {
  version: EXPIRED_SPATIAL_VERSION,
  fraction: { left: 0.05, top: 0.1, width: 0.9, height: 0.8 },
  gridWidth: 4,
  gridHeight: 3,
  fog: {
    coefficients: [
      [0.18, -0.12, 0.02, 0.03, -0.01, 0.01],
      [0.16, -0.1, 0.01, 0.02, 0, 0.02],
      [0.2, -0.14, 0.03, 0.04, -0.02, 0]
    ],
    offset: [0.02, 0.03, 0.01],
    amplitude: [0.12, 0.1, 0.14]
  },
  mean: [0.31, 0.42, 0.5, 0.58, 0.35, 0.44, 0.52, 0.61, 0.38, 0.47, 0.55, 0.66]
};
const recipes = {
  identity: { ...base },
  'LUT only (curves, WB, CMY)': {
    ...base,
    curves: { r: sCurve(), g: linearCurve(), b: sCurve() },
    exposure: 0.3, contrast: 12, temperature: 10, tint: -5, wbR: 1.08, wbG: 1, wbB: 0.94, cyan: 4, magenta: -3, yellow: 2
  },
  'vibrance / saturation': { ...base, saturation: 10, vibrance: 25, highlights: -20, shadows: 15 },
  look: {
    ...base,
    look: {
      matrix: [1.05, 0.02, -0.04, -0.03, 1, 0.05, 0, -0.02, 1.12],
      offset: [-6, 4, 9],
      curves: { r: sCurve(), g: linearCurve(), b: linearCurve() }
    }
  },
  'expired rescue + fog surface': {
    ...base,
    expiredEnabled: true, expiredLevels: 80, expiredNeutralize: 100, expiredCrossover: 60,
    expiredBrightness: 10, expiredContrast: 20, expiredUnevenFog: 100, expiredLocalContrast: 40,
    expiredAnalysis: { ...measured, spatial }
  }
};
{
  const params = computeAdjustmentParams(recipes['expired rescue + fog surface'], { width: 45, height: 31 });
  assert.ok(params.doRescue && params.doRescueSpatial, 'the rescue recipe exercises the spatial fog stage');
  assert.ok(computeAdjustmentParams(recipes['vibrance / saturation']).doHsl, 'the HSL step (where quality matters) runs');
  assert.ok(computeAdjustmentParams(recipes.look).doLookMatrix);
}

function sameBytes(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) assert.fail(`${label}: byte ${i} is ${actual[i]}, expected ${expected[i]}`);
  }
}

// A small odd frame, and one over the 500,000-pixel chunk the pass works in,
// so a chunk boundary falls inside it.
const sizes = [[45, 31], [1001, 503]];
// The display's LUT scratch is shared by every main-thread pass; a stale
// table left in it must not change a result.
const sharedScratch = createAdjustmentLutScratch();
for (const [width, height] of sizes) {
  for (const [name, settings] of Object.entries(recipes)) {
    if (width > 45 && name === 'identity') continue;
    const label = `${name} ${width}x${height}`;
    const frame = makeFrame(width, height, width * 31 + height);
    const inputBefore = frame.data.slice();

    const reference = new ImageData(new Uint8ClampedArray(frame.data.length), width, height);
    frozenMainThreadStage(frame, settings, reference, sharedScratch);

    // The export worker, through the structured clone.
    const adjusted = await bridge.workerApplyAdjustments(frame, settings, 'full');
    assert.ok(adjusted, `${label}: the worker's result is used`);
    assert.deepEqual([adjusted.width, adjusted.height], [width, height]);
    sameBytes(adjusted.data, reference.data, `${label}: worker == main-thread stage`);
    sameBytes(frame.data, inputBefore, `${label}: the input is copied, never written`);
    // The 16-bit plane rides along only when the stage is an identity, as
    // syncImage16 does on the main thread.
    assert.equal(Boolean(adjusted.__image16), name === 'identity', `${label}: __image16 only for identity`);

    // The live main-thread function (the export's no-worker fallback and the
    // settled display below 1 MP) gives the same bytes.
    const live = new ImageData(new Uint8ClampedArray(frame.data.length), width, height);
    applyPreparedAdjustmentsToBuffer(frame, settings, live, { quality: 'full', lutScratch: sharedScratch });
    sameBytes(live.data, reference.data, `${label}: applyPreparedAdjustmentsToBuffer == frozen stage`);

    // #254: a rectangle adjusted on its own, at its place in the frame (the
    // live dodge rectangles on a CPU display), equals that rectangle of the frame.
    for (const rect of [{ x: 0, y: 0, w: 7, h: 5 }, { x: Math.floor(width / 3), y: Math.floor(height / 2), w: Math.floor(width / 4), h: 3 }, { x: width - 5, y: height - 4, w: 5, h: 4 }]) {
      const part = new ImageData(new Uint8ClampedArray(rect.w * rect.h * 4), rect.w, rect.h);
      for (let row = 0; row < rect.h; row++) {
        part.data.set(frame.data.subarray(((rect.y + row) * width + rect.x) * 4, ((rect.y + row) * width + rect.x + rect.w) * 4), row * rect.w * 4);
      }
      const out = new ImageData(new Uint8ClampedArray(part.data.length), rect.w, rect.h);
      applyPreparedAdjustmentsToBuffer(part, settings, out, { quality: 'full', lutScratch: sharedScratch,
        region: { x: rect.x, y: rect.y, frameWidth: width, frameHeight: height } });
      for (let row = 0; row < rect.h; row++) {
        sameBytes(out.data.subarray(row * rect.w * 4, (row + 1) * rect.w * 4),
          reference.data.subarray(((rect.y + row) * width + rect.x) * 4, ((rect.y + row) * width + rect.x + rect.w) * 4), `${label}: rectangle ${JSON.stringify(rect)} row ${row}`);
      }
    }
  }
}

bridge.terminateWorker();
console.log('exportWorkerParity8: worker applyAdjustments == main-thread Step 3 (identity, LUT, look, vibrance/saturation, rescue + fog), rectangles at their place passed');
