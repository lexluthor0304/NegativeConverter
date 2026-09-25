// #238 real-file parity: converts the RAW files at the repository root through the
// live SilverCore adapter and the frozen 1703835 adapter (pipeline/oracle/) and
// compares SHA-256 of the 16-bit plane, the 8-bit data and the analysis preview.
// Files that are absent are skipped. Decoding uses macOS `sips` (16-bit TIFF) and
// UTIF, so the script runs on macOS only; both adapters see the same pixels.
//
//   node scripts/silvercore-parity-real.mjs [--max-mp 12] [--only NAME[,NAME]]
//
// --max-mp skips files whose decoded size is above that many megapixels, before
// decoding them (sips reads the size from the metadata): the 60 MP cases need about
// 3 GB and one heavy run at a time.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { convertBoth, resetBoth } from '../negative2positive/src/pipeline/oracle/adapterParity.mjs';
import { decodeTiffBuffer } from '../negative2positive/src/app/tiffFileLoader.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const maxMp = Number(args[args.indexOf('--max-mp') + 1]) || Infinity;
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;

// Frame crops are fractions of the decoded image; scales are target megapixels.
const FILES = [
  { name: '_DSC3111.NEF', mode: 'color', crop: [0.07, 0.10, 0.93, 0.90], scales: [null, 4] },
  { name: 'L1009967.dng', mode: 'color', crop: null, scales: [null] },
  { name: 'L1000618.DNG', mode: ['positive', 'bw'], crop: null, scales: [2.2, 4, null] },
  { name: 'L1000617.DNG', mode: ['positive', 'bw'], crop: null, scales: [2.2] },
  { name: 'L1000623.DNG', mode: ['positive', 'bw'], crop: null, scales: [2.2] },
];

function cropImage(image, [x0, y0, x1, y1]) {
  const left = Math.round(image.width * x0), top = Math.round(image.height * y0);
  const width = Math.round(image.width * x1) - left, height = Math.round(image.height * y1) - top;
  const data = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = ((top + y) * image.width + left) * 4;
    data.set(image.data.subarray(from, from + width * 4), y * width * 4);
  }
  return { width, height, data };
}

// Box average to about `mp` megapixels, rounded to 16-bit integers.
function scaleTo(image, mp) {
  const factor = Math.sqrt((mp * 1e6) / (image.width * image.height));
  if (factor >= 1) return image;
  const width = Math.max(1, Math.round(image.width * factor)), height = Math.max(1, Math.round(image.height * factor));
  const data = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy0 = Math.floor(y * image.height / height), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * image.height / height));
    for (let x = 0; x < width; x++) {
      const sx0 = Math.floor(x * image.width / width), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * image.width / width));
      const sum = [0, 0, 0, 0];
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * image.width + sx) * 4;
          for (let c = 0; c < 4; c++) sum[c] += image.data[i + c];
        }
      }
      const count = (sy1 - sy0) * (sx1 - sx0);
      for (let c = 0; c < 4; c++) data[(y * width + x) * 4 + c] = Math.round(sum[c] / count);
    }
  }
  return { width, height, data };
}

function pixelSize(path) {
  const run = spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], { encoding: 'utf8' });
  const width = Number(/pixelWidth:\s*(\d+)/.exec(run.stdout || '')?.[1]);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(run.stdout || '')?.[1]);
  return width > 0 && height > 0 ? { width, height } : null;
}

function decode(path) {
  const dir = mkdtempSync(join(tmpdir(), 'silvercore-parity-'));
  try {
    const out = join(dir, 'frame.tiff');
    const run = spawnSync('sips', ['-s', 'format', 'tiff', '-s', 'formatOptions', 'none', path, '--out', out], { stdio: 'ignore' });
    if (run.status !== 0 || !existsSync(out)) throw new Error(`sips could not decode ${path}`);
    const buf = readFileSync(out);
    const decoded = decodeTiffBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    return decoded.__image16;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const strokes = (image) => ({
  localExposure: { strokes: [
    { stops: 0.7, size: 0.25, feather: 0.5, points: [{ x: 0.3, y: 0.4, p: 1 }, { x: 0.5, y: 0.6, p: 0.8 }] },
    { stops: -0.5, size: 0.2, feather: 0.4, points: [{ x: 0.7, y: 0.3, p: 1 }] },
  ] },
  localExposureGeometry: { baseWidth: image.width, baseHeight: image.height, rotatedWidth: image.width, rotatedHeight: image.height, rotationAngle: 0, mirrored: false },
});
const BASE = {
  color: { colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 } },
  bw: { colorModel: 'standard' },
  positive: { positiveMode: 'correct' },
};

let compared = 0, failed = 0;
async function check(label, mode, image, settings, options) {
  const { live, oracle } = await convertBoth(mode, image, settings, options);
  compared++;
  const same = JSON.stringify(live) === JSON.stringify(oracle);
  if (!same) failed++;
  console.log(`${same ? 'same' : 'DIFF'}  ${label}  ${live.image16}/${live.image8}${same ? '' : `  oracle ${oracle.image16}/${oracle.image8}`}`);
}

if (spawnSync('sips', ['--help'], { stdio: 'ignore' }).error) {
  console.log('silvercore-parity-real: sips not available (macOS only); skipped');
  process.exit(0);
}
for (const file of FILES) {
  const path = join(root, file.name);
  if (only && !only.includes(file.name)) continue;
  if (!existsSync(path)) { console.log(`skip  ${file.name} (absent)`); continue; }
  const size = pixelSize(path);
  if (!size || size.width * size.height / 1e6 > maxMp) {
    console.log(`skip  ${file.name} ${size ? `${size.width}x${size.height}` : '(size unknown)'} (over --max-mp, not decoded)`);
    continue;
  }
  const decoded = decode(path);
  const frame = file.crop ? cropImage(decoded, file.crop) : decoded;
  for (const mp of file.scales) {
    const image = mp ? scaleTo(frame, mp) : frame;
    const megapixels = image.width * image.height / 1e6;
    const reference = cropImage(image, [0.2, 0.2, 0.8, 0.8]);
    for (const mode of [].concat(file.mode)) {
      const tag = `${file.name} ${image.width}x${image.height} ${mode}`;
      const base = BASE[mode];
      resetBoth();
      // Forced (export / settle) conversions, with and without the analysis sample.
      await check(`${tag} forced`, mode, image, base, { forceFullProcess: true });
      await check(`${tag} forced+reference`, mode, image, { ...base, brightness: 10 }, { forceFullProcess: true, analysisImageData: reference, includeAnalysisPreview: false });
      await check(`${tag} forced+strokes`, mode, image, { ...base, ...strokes(image) }, { forceFullProcess: true });
      if (megapixels > 16) continue; // larger sources never take the interactive path
      // A slider drag in the preview slot, as the preview worker sends it.
      const tick = { preview: true, includeAnalysisPreview: false, analysisImageData: reference };
      for (const [i, change] of [{}, { brightness: 12 }, { preSaturation: 120 }, { preSaturation: 120, brightness: 20 }, strokes(image), { ...strokes(image), contrast: 15 }, { saturation: 130, paper: mode === 'bw' ? 'multigrade-rc' : 'none', paperToning: 'selenium' }].entries()) {
        await check(`${tag} tick ${i}`, mode, image, { ...base, ...change }, tick);
      }
    }
  }
}
resetBoth();
console.log(`silvercore-parity-real: ${compared} conversions compared, ${failed} different`);
process.exit(failed ? 1 : 0);
