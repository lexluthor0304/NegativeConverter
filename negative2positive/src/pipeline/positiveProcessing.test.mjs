import assert from 'node:assert/strict';
globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
const { convertPositiveWithSilverCore, convertColorWithSilverCore, invalidateSilverCoreCache } = await import('./silverAdapter.js');
const { analyzePositive } = await import('../silvercore/engine/PositiveProcessing.js');
const image = { width: 512, height: 1, data: new Uint16Array(512 * 4) };
for (let x = 0; x < 512; x++) image.data.set([x * 127, x * 91, x * 63, x % 3 ? 65535 : 32768], x * 4);
image.data.set([17990, 33410, 48830, 65535], 0); // blue: catches the negative model's hue adjustment
const original = new Uint16Array(image.data);
const edit = await convertPositiveWithSilverCore(image, { positiveMode: 'edit', borderBuffer: 0 });
assert.deepEqual(edit.__image16.data, original, 'Edit only at neutral settings must preserve every 16-bit value including alpha');
assert.deepEqual(analyzePositive(null, { positiveMode: 'edit' }), { gain: 1, wb: [1, 1, 1] }, 'Edit only must not read source pixels for analysis');
const dim = { width: 512, height: 1, data: new Uint16Array(image.data) };
for (let i = 0; i < dim.data.length; i += 4) for (let c = 0; c < 3; c++) dim.data[i + c] = Math.round(dim.data[i + c] * .4);
// Rare bright highlight must retain detail outside the analysed percentile.
dim.data.set([62000, 31000, 15500, 65535], 510 * 4);
dim.data.set([64500, 32250, 16125, 65535], 511 * 4);
const correction = await convertPositiveWithSilverCore(dim, { positiveMode: 'correct', borderBuffer: 0 });
assert.ok(correction.__image16.data[256 * 4] > dim.data[256 * 4], 'dim slide receives tonal lift');
for (let i = 0; i < dim.data.length; i += 4) {
  const src = dim.data, dst = correction.__image16.data;
  assert.equal(dst[i + 3], src[i + 3]);
  if (src[i] > 1000) {
    assert.ok(Math.abs(dst[i + 1] / dst[i] - src[i + 1] / src[i]) < .001, 'tone mapping preserves channel ratios');
    assert.ok(Math.abs(dst[i + 2] / dst[i] - src[i + 2] / src[i]) < .001);
  }
}
assert.ok(correction.__image16.data[510 * 4] < correction.__image16.data[511 * 4]);
assert.ok(correction.__image16.data[511 * 4] < 65535, 'highlight tail is not clipped');
const afterToggle = await convertPositiveWithSilverCore(dim, { positiveMode: 'edit', borderBuffer: 0 });
assert.deepEqual(afterToggle.__image16.data, dim.data, 'mode switching invalidates the cached analysis');
const exposure = await convertPositiveWithSilverCore(dim, { positiveMode: 'edit', exposure: 50, borderBuffer: 0 });
assert.notDeepEqual(exposure.__image16.data, dim.data, 'manual edits still work in edit-only mode');
const reference = { width: 256, height: 1, data: dim.data.slice(0, 1024) };
const withReference = await convertPositiveWithSilverCore(dim, { positiveMode: 'correct', borderBuffer: 0 }, { analysisImageData: reference });
const exportReference = await convertPositiveWithSilverCore(dim, { positiveMode: 'correct', borderBuffer: 0 }, { analysisImageData: reference, includeAnalysisPreview: false, forceFullProcess: true });
assert.deepEqual(withReference.__image16.data, exportReference.__image16.data, 'preview and export use the same analysis');
await convertColorWithSilverCore(dim, {}, { forceFullProcess: true });
const afterNegative = await convertPositiveWithSilverCore(image, { positiveMode: 'edit' });
assert.deepEqual(afterNegative.__image16.data, original, 'negative cache must not contaminate edit only');
assert.deepEqual(image.data, original, 'source remains immutable');
invalidateSilverCoreCache();
console.log('positiveProcessing: identity, tone, colour ratios, highlights, alpha, controls and cache passed');
