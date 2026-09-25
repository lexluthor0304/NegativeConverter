// Auto-frame detection evaluator. Runs detectFrameAndRotation on the real
// negatives at the repo root and scores IoU against hand-labelled crops.
//
//   node scripts/eval-autoframe.mjs [--prescale] [--only=DSC_8800]
//
// Requires macOS `sips` for NEF -> TIFF decode (same recipe as the engine
// verification harness). The decode is full resolution and goes through the
// app's own preview resizer and preview rotation (autoFramePreview.js, #251:
// the same bytes as in the browser with `deterministicPreview`), so the
// detector sees the pixels the app gives it. `--prescale` keeps the old,
// quicker `sips -Z 1600` input (the resizer is then a no-op). A 24 MP decode
// takes about 100 MB here, the TIFF on disk about as much.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = process.env.AUTOFRAME_EVAL_TMP || '/tmp/nc_autoframe_eval';
mkdirSync(TMP, { recursive: true });

// Ground truth: normalized crop boxes (fractions of image width/height).
// DSC_4127 is a rotated strip — IoU vs an axis-aligned label is only
// indicative there, so it carries looser expectations.
const CASES = [
  { file: 'DSC_8800.NEF', label: 'Kodak GC400 strip on lightbox (middle frame)', gt: { x0: 0.24, x1: 0.70, y0: 0.30, y1: 0.76 }, strict: true, filmType: 'color' },
  { file: '_DSC3111.NEF', label: 'single C41 frame, orange mask', gt: { x0: 0.07, x1: 0.93, y0: 0.10, y1: 0.90 }, strict: true, filmType: 'color' },
  { file: 'DSC_4127.NEF', label: 'B&W strip, rotated', gt: { x0: 0.27, x1: 0.73, y0: 0.06, y1: 0.94 }, strict: false, filmType: 'bw' },
];
const PRESCALE = process.argv.includes('--prescale');
const ONLY = process.argv.find(arg => arg.startsWith('--only='))?.slice(7);

// ---- shims for browser globals the analyzer expects ----
globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    if (typeof data === 'number') { height = width; width = data; data = new Uint8ClampedArray(width * height * 4); }
    this.data = data; this.width = width; this.height = height;
  }
};
globalThis.window = globalThis;

function sanitizeCropRegion(cropRegion, imageData) {
  if (!cropRegion || !imageData) return null;
  const left = Math.max(0, Math.floor(cropRegion.left));
  const top = Math.max(0, Math.floor(cropRegion.top));
  const width = Math.min(imageData.width - left, Math.floor(cropRegion.width));
  const height = Math.min(imageData.height - top, Math.floor(cropRegion.height));
  if (width < 1 || height < 1) return null;
  return { left, top, width, height };
}

function decodeTiff(path) {
  const UTIF = require('utif');
  const buf = readFileSync(path);
  const ifds = UTIF.decode(buf);
  UTIF.decodeImage(buf, ifds[0]);
  const rgba = UTIF.toRGBA8(ifds[0]);
  return new ImageData(new Uint8ClampedArray(rgba), ifds[0].width, ifds[0].height);
}

function iou(a, b) {
  const ix0 = Math.max(a.x0, b.x0), iy0 = Math.max(a.y0, b.y0);
  const ix1 = Math.min(a.x1, b.x1), iy1 = Math.min(a.y1, b.y1);
  const iw = Math.max(0, ix1 - ix0), ih = Math.max(0, iy1 - iy0);
  const inter = iw * ih;
  const union = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
  return union > 0 ? inter / union : 0;
}

console.log('loading OpenCV.js (wasm)...');
// @techstark/opencv-js 5.x exports a thenable that resolves to the module.
const cvModule = require(join(ROOT, 'node_modules/@techstark/opencv-js/dist/opencv.js'));
globalThis.window.cv = typeof cvModule.then === 'function' ? await cvModule : cvModule;
console.log('OpenCV ready:', Boolean(window.cv.Mat));

const { detectFrameAndRotation } = await import(join(ROOT, 'negative2positive/src/app/autoFrameAnalyzer.js'));
const { rotatePreviewImageData } = await import(join(ROOT, 'negative2positive/src/app/autoFramePreview.js'));
// Node has no 2D canvas: the preview rotations are the app's JS rotation
// (deterministicPreview), and so is the rare full-frame fallback rotation of
// this 8-bit decode.
const rotateImageData = rotatePreviewImageData;

const settings = {
  enabled: true,
  filmFormat: 'auto',
  allowed120Formats: { '6x4.5': true, '6x6': true, '6x7': true, '6x9': true },
  marginRatio: 0.02,
  minConfidence: 0.55,
  highConfidence: 0.72,
  filmType: 'color',
  // As in the app (state.autoFrame): the line-search gate on, and the
  // deterministic preview whose sign-off this harness serves.
  neutralLineSearch: true,
  deterministicPreview: true,
};

let pass = 0, total = 0;
for (const testCase of CASES) {
  if (ONLY && !testCase.file.includes(ONLY)) continue;
  const nef = join(ROOT, testCase.file);
  if (!existsSync(nef)) { console.log(`SKIP ${testCase.file} (missing)`); continue; }
  const tiff = join(TMP, testCase.file.replace(/\.\w+$/, PRESCALE ? '_1600.tiff' : '_full.tiff'));
  if (!existsSync(tiff)) {
    execFileSync('sips', ['-s', 'format', 'tiff', ...(PRESCALE ? ['-Z', '1600'] : []), nef, '--out', tiff], { stdio: 'ignore' });
  }
  const imageData = decodeTiff(tiff);
  total += 1;

  const t0 = Date.now();
  let result = null;
  let error = null;
  try {
    result = detectFrameAndRotation(imageData, {
      settings,
      maxSide: 1600,
      rotatedOutput: 'none',
      frameFilmType: testCase.filmType,
      rotateImageData,
      sanitizeCropRegion,
    });
  } catch (err) {
    error = err;
  }
  const ms = Date.now() - t0;

  console.log(`\n=== ${testCase.file} — ${testCase.label} (${imageData.width}x${imageData.height}, ${ms} ms)`);
  if (error) { console.log('  ERROR:', error.message); continue; }
  if (!result) { console.log('  NO DETECTION'); continue; }

  if (!result.cropRegion) { console.log(`  REVIEW (${result.diagnostics?.method})  lineSearch=${JSON.stringify(result.diagnostics?.lineSearch)}`); continue; }
  // The crop is relative to the rotated frame, whose size the result carries.
  const ref = { width: result.rotatedWidth, height: result.rotatedHeight };
  const det = {
    x0: result.cropRegion.left / ref.width,
    x1: (result.cropRegion.left + result.cropRegion.width) / ref.width,
    y0: result.cropRegion.top / ref.height,
    y1: (result.cropRegion.top + result.cropRegion.height) / ref.height,
  };
  const overlap = iou(det, testCase.gt);
  const ok = testCase.strict ? overlap >= 0.75 : overlap >= 0.5;
  if (ok) pass += 1;
  console.log(`  angle=${result.angle}°  confidence=${result.confidence} (${result.confidenceLevel})  format=${result.detectedFormat}  method=${result.diagnostics?.method}  lineSearch=${JSON.stringify(result.diagnostics?.lineSearch)}  stageMs=${JSON.stringify(result.stageMs)}`);
  console.log(`  detected: x ${det.x0.toFixed(3)}-${det.x1.toFixed(3)}, y ${det.y0.toFixed(3)}-${det.y1.toFixed(3)}`);
  console.log(`  truth:    x ${testCase.gt.x0}-${testCase.gt.x1}, y ${testCase.gt.y0}-${testCase.gt.y1}`);
  console.log(`  IoU=${overlap.toFixed(3)}  ${ok ? 'PASS' : 'FAIL'}`);
  if (result.diagnostics?.scoreBreakdown) console.log('  breakdown:', JSON.stringify(result.diagnostics.scoreBreakdown));
}

console.log(`\n${pass}/${total} cases pass`);
process.exit(0);
