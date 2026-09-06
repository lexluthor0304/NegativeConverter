import assert from 'node:assert/strict';
import { Engine } from '../silvercore/engine/Engine.js';
import { cloneImage16, toImageData8 } from '../silvercore/util/image16.js';
import { bwMixWeights } from '../silvercore/engine/Presets.js';
import { applyFilmBaseCompensationToBuffer } from './filmBaseCompensation.js';
import { buildSilverCoreParams, convertColorWithSilverCore, convertBwWithSilverCore, convertPositiveWithSilverCore, invalidateSilverCoreCache } from './silverAdapter.js';

globalThis.ImageData = class {
  constructor(data, width, height) { Object.assign(this, { data, width, height }); }
};
function fixture(width, height, seed = 1) {
  const data = new Uint16Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data.set([7000 + (i * 73 * seed) % 48000, 3000 + (i * 139 * seed) % 35000, 1000 + (i * 211 * seed) % 22000, i % 13 ? 65535 : 0], i);
  }
  return { width, height, data };
}
// 最適化前と同じ「標本 process → 出力 reprocess」を独立 Engine で再現する。
async function oracle(source, reference, settings, mode) {
  const params = await buildSilverCoreParams(mode, settings);
  function prepare(image) {
    const copy = cloneImage16(image);
    if (mode === 'color' && settings.filmBase) applyFilmBaseCompensationToBuffer(copy.data, settings.filmBase, { method: settings.filmBaseMethod || 'density', strength: settings.filmBaseStrength ?? 1 });
    if (mode === 'bw') {
      const w = bwMixWeights[params.bwMix] || bwMixWeights.standard;
      for (let i = 0; i < copy.data.length; i += 4) {
        const v = Math.round(copy.data[i] * w.r + copy.data[i + 1] * w.g + copy.data[i + 2] * w.b);
        copy.data[i] = copy.data[i + 1] = copy.data[i + 2] = v;
      }
    }
    return copy;
  }
  const engine = new Engine(source.width, source.height);
  const analysis = toImageData8(engine.process(prepare(reference), { ...params, analysisRegion: null, excludeTransparent: true }));
  return { image: engine.reprocess(prepare(source), params), analysis };
}

const source = fixture(96, 64), reference = fixture(60, 40);
const base = { colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 }, preSaturation: 115 };
const changes = [{}, { temperature: 23 }, { saturation: 0 }, { preSaturation: 80 }, { bwMix: 'red' }, { colorModel: 'frontier' }, { colorModel: 'noritsu' }, { borderBuffer: 0 }, { filmBase: { r16: 51555, g16: 33999, b16: 21444 } }, { filmBaseMethod: 'linear', filmBaseStrength: .4 }, { curvePrecision: 'precise', contrast: 19 }];
for (const [mode, convert] of [['color', convertColorWithSilverCore], ['bw', convertBwWithSilverCore], ['positive', convertPositiveWithSilverCore]]) {
  for (const preview of [true, false]) {
    invalidateSilverCoreCache();
    for (const change of changes) {
      const settings = { ...base, ...change };
      const expected = await oracle(source, reference, settings, mode);
      for (const includeAnalysisPreview of [true, false]) {
        const result = await convert(source, settings, { preview, analysisImageData: reference, includeAnalysisPreview });
        assert.deepEqual(result.__image16.data, expected.image.data, `${mode}: 16-bit 出力一致`);
        assert.deepEqual(result.data, toImageData8(expected.image).data);
        if (includeAnalysisPreview) assert.deepEqual(result.__analysisPreview.data, expected.analysis.data);
        else assert.equal(result.__analysisPreview, undefined);
      }
    }
  }
}

// 調色中は再解析しない。ただし標本・寸法・解析パラメーター・強制更新は反映する。
invalidateSilverCoreCache();
let analyses = 0;
const analyze = Engine.prototype.analyze;
Engine.prototype.analyze = function (...args) { analyses++; return analyze.apply(this, args); };
try {
  const options = { preview: true, analysisImageData: reference, includeAnalysisPreview: false };
  const first = await convertColorWithSilverCore(source, base, options);
  assert.equal(analyses, 1);
  const saved = first.__image16.data.slice();
  await convertColorWithSilverCore(source, { ...base, temperature: 12 }, options);
  assert.equal(analyses, 1, '調色で標本を再解析しない');
  assert.deepEqual(first.__image16.data, saved, '以前の結果を上書きしない');
  structuredClone(first.__image16.data.buffer, { transfer: [first.__image16.data.buffer] });
  const repeated = await convertColorWithSilverCore(source, base, options);
  assert.deepEqual(repeated.__image16.data, saved, '転送してもキャッシュを切り離さない');
  await convertColorWithSilverCore(source, base, { ...options, forceFullProcess: true });
  assert.equal(analyses, 2);
  const nextReference = fixture(60, 40, 3);
  const next = await convertColorWithSilverCore(source, base, { ...options, analysisImageData: nextReference });
  assert.equal(analyses, 3);
  assert.deepEqual(next.__image16.data, (await oracle(source, nextReference, base, 'color')).image.data);
  const reshaped = { width: 40, height: 60, data: nextReference.data };
  const before = analyses;
  await convertColorWithSilverCore(source, base, { ...options, analysisImageData: reshaped });
  assert.equal(analyses, before + 1, '同じ配列でも寸法の異なる標本は再解析');
  await convertColorWithSilverCore(source, base, { preview: true });
  assert.equal(analyses, before + 2, '標本のない入力に標本の解析を流用しない');
  await convertColorWithSilverCore(source, base, options);
  assert.equal(analyses, before + 3);
} finally { Engine.prototype.analyze = analyze; }
assert.deepEqual(source, fixture(96, 64));
assert.deepEqual(reference, fixture(60, 40));
console.log('referenceCache: 再解析削減・設定変更・標本切替・所有権・旧処理との 16-bit 厳密一致を検証');
