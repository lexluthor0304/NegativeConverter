// Multi-shot merge worker (#260): aligns, warps and merges the selected shots
// and encodes the merged 16-bit PNG, off the page's main thread and OpenCV
// heap. The page runs one worker per merge and terminates it afterwards,
// which releases the WASM heap and every plane. Plain module code, so Node
// tests can run it, and the page falls back to it on the main thread when a
// module worker cannot start.
//
// Protocol (page -> worker):
//   { type: 'start', mode, fault? }   begin loading OpenCV
//   { type: 'frame', index, width, height, gray, referenceGray?, image16 | rgba }
//     gray = sampleAlignmentGray() of this frame; the first frame becomes the
//     reference. referenceGray replaces the reference's sample when this
//     pair is sampled at another side (frames under 1200 px).
//   { type: 'merge' }
// Worker -> page: { type: 'progress', stage, index?, aligned?, done?, total? }
// with stage align | warp | exposure | frame | merge | encode, then
// { type: 'result', blob | null, width, height, used, skipped } or
// { type: 'error', code: 'memory' | 'failed' | 'opencv', message }.
import * as pako from 'pako';
import { matchAlignment, warpImageData, warpPlane16 } from '../app/imageAlignment.js';
import { coverageRect, estimateExposureRatio, mergeRows, mergeScale, toImage16 } from '../app/multiShot.js';
import { describeMultiShotError } from '../app/multiShotErrors.js';
import { encodePng16Blob } from './imageEncoders.js';

// About 0.6 MP per band at 9536 px wide: a progress message every ~0.1 s.
export const MERGE_BAND_ROWS = 64;

// Test hook: a genuine OpenCV allocation failure (a StsNoMem exception
// pointer), sized over the 1 GiB heap cap so the heap is refused at once
// instead of growing first.
function forceAllocationFailure(cv) {
  const mat = new cv.Mat(20000, 10000, cv.CV_16UC4);
  mat.delete();
  throw new Error('The forced allocation failure did not fail');
}

export function createMultiShotWorkerProcessor({
  loadCv = async () => {}, post, bandRows = MERGE_BAND_ROWS, pause = null, signal = null
} = {}) {
  let mode = 'average';
  let fault = null;
  let referenceGray = null;
  let frames = [];
  let skipped = 0;
  let failed = false;
  let queue = Promise.resolve();

  function release() {
    frames = [];
    referenceGray = null;
  }

  async function ensureCv() {
    try {
      await loadCv();
    } catch (error) {
      const failure = new Error(String(error?.message || error));
      failure.code = 'opencv';
      throw failure;
    }
  }

  async function yieldTurn() {
    if (pause) await pause();
    if (signal?.aborted) throw signal.reason;
  }

  function addFrame(message) {
    const { index, width, height } = message;
    const image16 = message.image16 ? { width, height, data: message.image16 } : null;
    const rgba = message.rgba ? { width, height, data: message.rgba } : null;
    // Only the locals above keep the planes alive from here on.
    message.image16 = message.rgba = null;
    if (!frames.length) {
      referenceGray = message.gray;
      frames.push({ image16: image16 || toImage16(rgba), ratio: 1 });
      post({ type: 'progress', stage: 'frame', index, aligned: true });
      return;
    }
    let alignment = null;
    try {
      alignment = matchAlignment(message.referenceGray || referenceGray, message.gray);
    } catch (error) {
      console.warn('Multi-shot alignment failed for frame', index, describeMultiShotError(error).message);
    }
    post({ type: 'progress', stage: 'align', index, aligned: !!alignment });
    if (!alignment) {
      skipped++;
      post({ type: 'progress', stage: 'frame', index, aligned: false });
      return;
    }
    if (fault === 'warp-memory') forceAllocationFailure(globalThis.cv);
    const target = frames[0].image16;
    // A decoded 16-bit plane is warped alone; 8-bit sources keep the 8-bit
    // warp and are widened afterwards, exactly as before.
    const warped = image16
      ? warpPlane16(image16, alignment.homography, target.width, target.height, { consume: true })
      : toImage16(warpImageData(rgba, alignment.homography, target.width, target.height));
    post({ type: 'progress', stage: 'warp', index });
    const ratio = estimateExposureRatio(target, warped);
    frames.push({ image16: warped, ratio });
    post({ type: 'progress', stage: 'exposure', index });
    post({ type: 'progress', stage: 'frame', index, aligned: true });
  }

  async function merge() {
    const used = frames.length;
    const size = frames[0]?.image16;
    if (used < 2 || frames.some((f) => f.image16.width !== size.width || f.image16.height !== size.height)) {
      release();
      post({ type: 'result', blob: null, width: 0, height: 0, used, skipped });
      return;
    }
    const rect = coverageRect(frames);
    const scale = mergeScale(frames);
    const out = new Uint16Array(rect.width * rect.height * 4);
    for (let y0 = 0; y0 < rect.height; y0 += bandRows) {
      const y1 = Math.min(rect.height, y0 + bandRows);
      mergeRows(frames, rect, y0, y1, out, { mode, scale, opaque: true });
      post({ type: 'progress', stage: 'merge', done: y1, total: rect.height });
      await yieldTurn();
    }
    release();
    post({ type: 'progress', stage: 'encode' });
    await yieldTurn();
    // The export worker's 16-bit PNG call; the page adds the iCCP chunk.
    const blob = encodePng16Blob(out, rect.width, rect.height, pako);
    post({ type: 'result', blob, width: rect.width, height: rect.height, used, skipped });
  }

  async function handle(message) {
    if (failed) return;
    if (signal?.aborted) throw signal.reason;
    switch (message?.type) {
      case 'start':
        mode = message.mode || 'average';
        fault = message.fault || null;
        release();
        skipped = 0;
        await ensureCv();
        return;
      case 'frame':
        await ensureCv();
        addFrame(message);
        return;
      case 'merge':
        await merge();
        return;
      default:
        throw new Error(`Unknown multi-shot worker request: ${message?.type}`);
    }
  }

  // Messages run strictly in order, also while OpenCV is still loading.
  return (message) => {
    const task = queue.then(() => handle(message)).catch((error) => {
      if (failed) return;
      failed = true;
      release();
      const described = error?.code === 'opencv'
        ? { code: 'opencv', message: error.message }
        : describeMultiShotError(error);
      if (described.code !== 'opencv') console.warn('Multi-shot merge failed:', described.message);
      post({ type: 'error', ...described });
    });
    queue = task;
    return task;
  };
}
