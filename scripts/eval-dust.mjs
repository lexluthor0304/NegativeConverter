// Dust-removal detector evaluator. Takes a real converted-positive base image,
// overlays synthetic dust spots and scratches at known positions, and scores
// detectDust recall / false-positive area / runtime.
//
//   node scripts/eval-dust.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = '/tmp/nc_autoframe_eval';
mkdirSync(TMP, { recursive: true });

globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    if (typeof data === 'number') { height = width; width = data; data = new Uint8ClampedArray(width * height * 4); }
    this.data = data; this.width = width; this.height = height;
  }
};
globalThis.window = globalThis;

const cvModule = require(join(ROOT, 'node_modules/@techstark/opencv-js/dist/opencv.js'));
globalThis.window.cv = typeof cvModule.then === 'function' ? await cvModule : cvModule;
console.log('OpenCV ready:', Boolean(window.cv.Mat));

const { detectDust } = await import(join(ROOT, 'negative2positive/src/silvercore/engine/DustRemoval.js'));

// ---- base image: real negative frame, inverted to a rough positive ----
const nef = join(ROOT, '_DSC3111.NEF');
const tiff = join(TMP, '_DSC3111_1600.tiff');
if (!existsSync(tiff)) {
  execFileSync('sips', ['-s', 'format', 'tiff', '-Z', '1600', nef, '--out', tiff], { stdio: 'ignore' });
}
const UTIF = require('utif');
const buf = readFileSync(tiff);
const ifds = UTIF.decode(buf);
UTIF.decodeImage(buf, ifds[0]);
const rgbaFull = new Uint8ClampedArray(UTIF.toRGBA8(ifds[0]));
const fw = ifds[0].width, fh = ifds[0].height;

// crop to frame interior and invert
const cx0 = Math.round(fw * 0.10), cx1 = Math.round(fw * 0.90);
const cy0 = Math.round(fh * 0.14), cy1 = Math.round(fh * 0.86);
const w = cx1 - cx0, h = cy1 - cy0;
const base = new Uint8ClampedArray(w * h * 4);
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const si = ((cy0 + y) * fw + (cx0 + x)) * 4, di = (y * w + x) * 4;
    base[di] = 255 - rgbaFull[si];
    base[di + 1] = 255 - rgbaFull[si + 1];
    base[di + 2] = 255 - rgbaFull[si + 2];
    base[di + 3] = 255;
  }
}

// ---- synthetic defects with a fixed-seed PRNG ----
let seed = 1234567;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

function cloneImage(src) { return new ImageData(new Uint8ClampedArray(src), w, h); }

const gt = new Uint8Array(w * h);
const dirty = cloneImage(base);
const paint = (x, y, value) => {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 4;
  dirty.data[i] = dirty.data[i + 1] = dirty.data[i + 2] = value;
  gt[y * w + x] = 1;
};

const SPOTS = 60;
for (let s = 0; s < SPOTS; s++) {
  const cxp = Math.round(20 + rand() * (w - 40));
  const cyp = Math.round(20 + rand() * (h - 40));
  const r = 1 + rand() * 3;
  const value = s % 2 === 0 ? 245 : 12; // white dust on positive / black specks
  for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
    for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
      if (dx * dx + dy * dy <= r * r) paint(cxp + dx, cyp + dy, value);
    }
  }
}
// scratches: thin bright/dark lines
for (let l = 0; l < 3; l++) {
  const x0 = Math.round(40 + rand() * (w - 80));
  const y0 = Math.round(40 + rand() * (h - 200));
  const len = Math.round(90 + rand() * 200);
  const drift = rand() * 0.4 - 0.2;
  const value = l === 1 ? 10 : 250;
  for (let t = 0; t < len; t++) {
    const x = Math.round(x0 + t * drift);
    const y = y0 + t;
    paint(x, y, value);
    paint(x + 1, y, value);
  }
}
const gtArea = gt.reduce((a, b) => a + b, 0);
console.log(`base ${w}x${h}, synthetic defect pixels: ${gtArea}`);

function score(mask) {
  let hit = 0, falsePix = 0, maskArea = 0;
  for (let i = 0; i < mask.length; i++) {
    const m = mask[i] > 0;
    if (!m) continue;
    maskArea++;
    if (gt[i]) hit += 1; else falsePix += 1;
  }
  // recall over GT pixels
  let covered = 0;
  for (let i = 0; i < gt.length; i++) if (gt[i] && mask[i] > 0) covered++;
  return { recall: covered / gtArea, maskArea, falseRatio: falsePix / (w * h) };
}

for (const strength of [3, 5, 8]) {
  const t0 = Date.now();
  const { mask, particleCount } = detectDust(cloneImage(dirty.data), { strength });
  const ms = Date.now() - t0;
  const s = score(mask);
  console.log(`strength=${strength}: recall=${(s.recall * 100).toFixed(1)}%  falseArea=${(s.falseRatio * 100).toFixed(2)}%  maskArea=${s.maskArea}  particles=${particleCount}  ${ms} ms`);
}

// false-positive floor on the clean image
{
  const t0 = Date.now();
  const { mask, particleCount } = detectDust(cloneImage(base), { strength: 3 });
  const ms = Date.now() - t0;
  let area = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] > 0) area++;
  console.log(`clean image (strength=3): maskArea=${area} (${(area / (w * h) * 100).toFixed(2)}% of frame)  particles=${particleCount}  ${ms} ms`);
}

process.exit(0);
