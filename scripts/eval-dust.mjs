// Dust-removal detector evaluator. Takes a real negative frame, inverted to a
// rough positive, adds synthetic dust at known positions and scores detectDust:
// how many defects it finds, how much else it masks, how long it takes.
//
// Dust blocks light on the film, so on a negative's frame it is bright: every
// defect here brightens the frame. Half the specks are hard discs, half are
// soft (out of focus) and only a little above the grain; three are hairs.
// docs/dust-removal.md has the study on full-size frames this stands in for.
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

// `gt` holds 1 + the defect's index where the defect is at least half as
// strong as at its centre.
const gt = new Uint16Array(w * h);
const dirty = cloneImage(base);
const kinds = [];
const brighten = (x, y, amount, id, core) => {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 4;
  for (let c = 0; c < 3; c++) dirty.data[i + c] = Math.min(255, dirty.data[i + c] + amount);
  if (core) gt[y * w + x] = id;
};

const SPOTS = 60;
for (let s = 0; s < SPOTS; s++) {
  const cxp = Math.round(20 + rand() * (w - 40));
  const cyp = Math.round(20 + rand() * (h - 40));
  const id = kinds.length + 1;
  if (s % 2 === 0) {
    kinds.push('hard');
    const r = 1 + rand() * 3;
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        if (dx * dx + dy * dy <= r * r) brighten(cxp + dx, cyp + dy, 150, id, true);
      }
    }
  } else {
    kinds.push('soft');
    const sigma = 2 + rand() * 3, amount = 25 + rand() * 35, reach = Math.ceil(sigma * 3);
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const g = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
        brighten(cxp + dx, cyp + dy, Math.round(amount * g), id, g > 0.5);
      }
    }
  }
}
// hairs: thin bright lines that bend, as a hair on the film does (a long
// straight line is the picture's own: a wire, an edge)
for (let l = 0; l < 3; l++) {
  const x0 = Math.round(40 + rand() * (w - 80));
  const y0 = Math.round(40 + rand() * (h - 200));
  const len = Math.round(90 + rand() * 200);
  const drift = rand() * 0.4 - 0.2;
  const sagitta = (0.06 + rand() * 0.06) * len;
  const id = kinds.length + 1;
  kinds.push('hair');
  for (let t = 0; t < len; t++) {
    const x = Math.round(x0 + t * drift + sagitta * Math.sin(Math.PI * t / len));
    const y = y0 + t;
    brighten(x, y, 120, id, true);
    brighten(x + 1, y, 120, id, true);
  }
}
const sizes = new Uint32Array(kinds.length + 1);
for (let i = 0; i < gt.length; i++) sizes[gt[i]]++;
console.log(`base ${w}x${h}, ${kinds.length} synthetic defects (${kinds.filter(k => k === 'hard').length} hard, ${kinds.filter(k => k === 'soft').length} soft, ${kinds.filter(k => k === 'hair').length} hairs)`);

// Where each defect landed: the spread (standard deviation, 8-bit levels) of
// the clean frame's grey in a ring 12-24 px around it. Calm (below 6: sky,
// walls) is where dust shows and where the detector looks; busy (20 and up:
// foliage) is texture it leaves alone by design.
const boxes = kinds.map(() => [w, h, -1, -1]);
for (let i = 0; i < gt.length; i++) {
  if (!gt[i]) continue;
  const b = boxes[gt[i] - 1], x = i % w, y = (i - x) / w;
  if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y;
}
const greyAt = i => 0.299 * base[i * 4] + 0.587 * base[i * 4 + 1] + 0.114 * base[i * 4 + 2];
const places = boxes.map(([bx0, by0, bx1, by1]) => {
  let n = 0, sum = 0, squares = 0;
  for (let y = Math.max(0, by0 - 24); y <= Math.min(h - 1, by1 + 24); y++) {
    for (let x = Math.max(0, bx0 - 24); x <= Math.min(w - 1, bx1 + 24); x++) {
      if (x >= bx0 - 12 && x <= bx1 + 12 && y >= by0 - 12 && y <= by1 + 12) continue;
      const v = greyAt(y * w + x);
      n++; sum += v; squares += v * v;
    }
  }
  const spread = n ? Math.sqrt(Math.max(0, squares / n - (sum / n) ** 2)) : 0;
  return spread < 6 ? 'calm' : spread < 20 ? 'moderate' : 'busy';
});
const placed = place => places.filter(p => p === place).length;
console.log(`landed: ${placed('calm')} calm, ${placed('moderate')} moderate, ${placed('busy')} busy`);

// A defect is found when the mask covers at least 30 % of it.
function score(mask) {
  const covered = new Uint32Array(kinds.length + 1);
  let falsePix = 0, maskArea = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    maskArea++;
    if (gt[i]) covered[gt[i]]++; else falsePix++;
  }
  const found = { hard: 0, soft: 0, hair: 0 }, total = { hard: 0, soft: 0, hair: 0 };
  const byPlace = { calm: [0, 0], moderate: [0, 0], busy: [0, 0] };
  kinds.forEach((kind, k) => {
    const hit = covered[k + 1] >= 0.3 * sizes[k + 1];
    total[kind]++;
    byPlace[places[k]][1]++;
    if (hit) { found[kind]++; byPlace[places[k]][0]++; }
  });
  return { found, total, byPlace, maskArea, falseRatio: falsePix / (w * h) };
}

for (const strength of [1, 3, 5, 8]) {
  const t0 = Date.now();
  const { mask, particleCount } = detectDust(cloneImage(dirty.data), { strength });
  const ms = Date.now() - t0;
  const s = score(mask);
  const where = Object.entries(s.byPlace).map(([place, [hit, all]]) => `${place} ${hit}/${all}`).join(' ');
  console.log(`strength=${strength}: found hard ${s.found.hard}/${s.total.hard}  soft ${s.found.soft}/${s.total.soft}  hairs ${s.found.hair}/${s.total.hair}`
    + ` (${where})  otherArea=${(s.falseRatio * 100).toFixed(2)}% (includes the margin around each defect)  maskArea=${s.maskArea}  particles=${particleCount}  ${ms} ms`);
}

// what the detector masks on the frame without synthetic dust: strength 1 is
// the "I'd rather it removes too little" setting, so it must stay close to
// zero (#113). The frame carries a little dust of its own.
for (const strength of [1, 3]) {
  const t0 = Date.now();
  const { mask, particleCount } = detectDust(cloneImage(base), { strength });
  const ms = Date.now() - t0;
  let area = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] > 0) area++;
  console.log(`clean image (strength=${strength}): maskArea=${area} (${(area / (w * h) * 100).toFixed(2)}% of frame)  particles=${particleCount}  ${ms} ms`);
}

process.exit(0);
