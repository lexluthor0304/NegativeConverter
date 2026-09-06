// 固定の 16-bit 合成ネガで処理時間と全出力の SHA-256 を記録する。
// node scripts/bench-conversion.mjs [JSON 出力先]
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { Engine } from '../negative2positive/src/silvercore/engine/Engine.js';
import { convertColorWithSilverCore, invalidateSilverCoreCache } from '../negative2positive/src/pipeline/silverAdapter.js';
import { sampleAnalysisArea } from '../negative2positive/src/app/analysisRegion.js';
import { computeFilmBaseGains, applyFilmBaseCompensationToBuffer } from '../negative2positive/src/pipeline/filmBaseCompensation.js';

globalThis.ImageData = class {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
};
const metrics = {};
for (const name of ['process', 'reprocess', '_applyLuts', '_applyPreSaturation']) {
  const original = Engine.prototype[name];
  Engine.prototype[name] = function (...args) {
    const start = performance.now();
    try { return original.apply(this, args); }
    finally {
      const metric = metrics[name] ||= { calls: 0, ms: 0 };
      metric.calls++; metric.ms += performance.now() - start;
    }
  };
}
function fixture(width, height) {
  const data = new Uint16Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const p = i / 4;
    data[i] = 8000 + (p * 137) % 46000;
    data[i + 1] = 4000 + (p * 173) % 35000;
    data[i + 2] = 2000 + (p * 191) % 23000;
    data[i + 3] = p % 47 ? 65535 : 0;
  }
  return { width, height, data };
}
const preview = fixture(600, 400);
const full = fixture(3000, 2000);
const reference = fixture(500, 500);
const base = { colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 }, preSaturation: 115 };
const rows = [];
async function bench(name, source, options, cold) {
  invalidateSilverCoreCache();
  await convertColorWithSilverCore(source, base, options);
  for (const key of Object.keys(metrics)) delete metrics[key];
  const times = [], hashes = [], pixelHashes = [];
  for (let i = 0; i < 5; i++) {
    if (cold) invalidateSilverCoreCache();
    const start = performance.now();
    const output = await convertColorWithSilverCore(source, { ...base, temperature: i * 3, contrast: i * 2 }, options);
    times.push(performance.now() - start);
    const hash = createHash('sha256').update(output.__image16.data).update(output.data);
    pixelHashes.push(hash.copy().digest('hex'));
    if (output.__analysisPreview) hash.update(output.__analysisPreview.data);
    hashes.push(hash.digest('hex'));
  }
  const sorted = times.toSorted((a, b) => a - b);
  const row = { name, pixels: source.width * source.height, medianMs: +sorted[2].toFixed(2), timesMs: times.map(x => +x.toFixed(2)), stages: structuredClone(metrics), hashes, pixelHashes };
  rows.push(row); console.log(JSON.stringify(row));
}
await bench('preview-reference-cold', preview, { preview: true, analysisImageData: reference }, true);
await bench('preview-reference-sliders', preview, { preview: true, analysisImageData: reference }, false);
await bench('preview-without-reference', preview, { preview: true }, false);
await bench('full-reference-6mp', full, { forceFullProcess: true, analysisImageData: reference }, true);
await bench('preview-reference-interactive', preview, { preview: true, analysisImageData: reference, includeAnalysisPreview: false }, false);
const compensation = [];
for (const optimized of [false, true]) {
  const times = [];
  let hash;
  for (let n = 0; n < 6; n++) {
    const data = full.data.slice();
    const start = performance.now();
    if (optimized) applyFilmBaseCompensationToBuffer(data, base.filmBase);
    else {
      const gains = computeFilmBaseGains(base.filmBase);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = Math.max(0, Math.min(65535, Math.round(data[i] * gains.r)));
        data[i + 1] = Math.max(0, Math.min(65535, Math.round(data[i + 1] * gains.g)));
        data[i + 2] = Math.max(0, Math.min(65535, Math.round(data[i + 2] * gains.b)));
      }
    }
    if (n) times.push(performance.now() - start);
    hash = createHash('sha256').update(data).digest('hex');
  }
  compensation.push({ optimized, medianMs: +times.toSorted((a,b) => a-b)[2].toFixed(2), hash });
}
console.log(JSON.stringify({ compensation }));
const sampleStart = performance.now();
sampleAnalysisArea({ ...full, __image16: full }, [{x:.1,y:.1},{x:.9,y:.1},{x:.9,y:.9},{x:.1,y:.9}]);
const report = { node: process.version, cpu: cpus()[0]?.model, sampleAnalysisMs: performance.now() - sampleStart, rows, compensation };
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
