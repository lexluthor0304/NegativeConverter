// The editor's side of dynamic range compression (pipeline/dynamicRange.js,
// docs/dynamic-range-compression.md).
//
// The photo's sample: the map every conversion of the open photo applies is
// solved from one sample of its full-resolution frame, so the display
// preview, the zoomed detail and the exports show the same compression. The
// sampler reads the frame here, on the page, in slices of a few milliseconds
// (one pass over the 16-bit plane: about 150 ms at 60 MP in all) with the
// arithmetic of sampleDrcInput, so a full-resolution conversion that makes
// the sample itself gets the same numbers.
//
// The hint: after a photo's automatic conversion the adapter estimates how
// much of the frame the compression would bring back from near black or
// white (estimateDrcEffect). Above DRC_HINT_THRESHOLD the editor offers it
// once; nothing is switched on without the user.

import { createDrcSampleBuilder, drcEnabled, DRC_HINT_THRESHOLD } from '../pipeline/dynamicRange.js';

/** The 16-bit plane of a frame (an ImageData with __image16, an Image16, or an 8-bit ImageData read as 16-bit). */
export function drcPlaneOf(frame) {
  if (!frame) return null;
  const plane = frame.__image16;
  if (plane?.data instanceof Uint16Array && plane.width === frame.width && plane.height === frame.height) return plane;
  if (frame.data instanceof Uint16Array) return frame;
  if (frame.data && frame.data.length === frame.width * frame.height * 4) {
    // An 8-bit frame: the adapter promotes it by 257 (v << 8 | v), as here.
    return { width: frame.width, height: frame.height, data: frame.data, scale: 257 };
  }
  return null;
}

/**
 * @param {object} [deps]
 * @param {() => number} [deps.now]
 * @param {() => Promise<void>} [deps.yieldTask]
 * @param {number} [deps.sliceMs]
 * @param {(frame: object) => void} [deps.onReady] - a frame's sample became available
 */
export function createDrcSampler({
  now = () => performance.now(),
  yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)),
  sliceMs = 8,
  onReady = () => {}
} = {}) {
  const samples = new WeakMap();
  let job = null;
  let seq = 0;

  async function build(frame) {
    const mine = job = { frame };
    const plane = drcPlaneOf(frame);
    if (!plane) { job = null; return; }
    const builder = createDrcSampleBuilder(plane.data, plane.width, plane.height, { scale: plane.scale || 1 });
    // Rows of the grid per slice, from the first slice's measured cost.
    let rows = 1;
    while (!builder.done) {
      const start = now();
      builder.step(rows);
      const spent = Math.max(0.05, now() - start);
      if (builder.done) break;
      rows = Math.max(1, Math.min(64, Math.floor((rows * sliceMs) / spent)));
      await yieldTask();
      if (job !== mine) return;
    }
    if (job !== mine) return;
    job = null;
    const sample = builder.result();
    samples.set(frame, { key: `drc-${++seq}`, width: sample.width, height: sample.height, lum: sample.lum });
    onReady(frame);
  }

  return {
    /** The frame's sample, or null while it is being made (it is started then). */
    sampleFor(frame) {
      if (!frame) return null;
      const known = samples.get(frame);
      if (known) return known;
      if (!job || job.frame !== frame) void build(frame);
      return null;
    },
    /** Whether a frame's sample is ready. */
    has(frame) {
      return Boolean(frame && samples.has(frame));
    },
    cancel() {
      job = null;
    }
  };
}

/**
 * Whether the hint should be offered for a photo now: its estimate says the
 * compression would bring back enough, the photo does not use it yet, and the
 * hint was not dismissed (or the feature used) on it.
 */
export function drcHintWanted(settings, estimate) {
  if (!estimate || drcEnabled(settings) || settings?.drcHintDismissed) return false;
  return Number(estimate.reduction) >= DRC_HINT_THRESHOLD;
}

/** Auto: the six controls from a photo's estimate (estimateDrcEffect().suggested). */
export function drcAutoSettings(estimate) {
  return estimate?.suggested ? { ...estimate.suggested } : null;
}
