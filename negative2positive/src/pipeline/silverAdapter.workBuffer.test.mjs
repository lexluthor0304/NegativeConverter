// #233 with #238: the preview worker hands its previous result plane back as
// options.workBuffer16, and every output path (the prepared-prefix tail, the B&W
// grey table and the transient planes) writes into it instead of allocating. The
// pixels must equal a conversion that allocates, and a plane that shares memory
// with the source is never written.
import assert from 'node:assert/strict';

globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
const {
  convertColorWithSilverCore,
  convertBwWithSilverCore,
  convertPositiveWithSilverCore,
  invalidateSilverCoreCache,
} = await import('./silverAdapter.js');
const { sanitizeFlatFieldMap } = await import('../app/flatField.js');

const CONVERT = { color: convertColorWithSilverCore, bw: convertBwWithSilverCore, positive: convertPositiveWithSilverCore };
const W = 48, H = 36, PX = W * H;

function negative() {
  const data = new Uint16Array(PX * 4);
  for (let p = 0; p < PX; p++) {
    const t = p / PX;
    data.set([46000 - 20000 * t + (p * 37) % 3000, 30000 - 15000 * t + (p * 53) % 2000, 20000 - 9000 * t + (p * 29) % 1500, p % 17 ? 65535 : 0], p * 4);
  }
  return { width: W, height: H, data };
}
function slide() {
  const data = new Uint16Array(PX * 4);
  for (let p = 0; p < PX; p++) {
    const x = p % W, y = (p / W) | 0;
    const v = 0.25 + 0.75 * (x + y) / (W + H);
    const [r, g, b] = (x * 7 + y * 3) % 11 === 0 ? [v * 0.9, v * 0.5, v * 0.2] : [v, v, v];
    data.set([Math.min(65535, Math.round(r * 1.1 * 65535)), Math.round(g * 65535), Math.round(b * 0.9 * 65535), 65535], p * 4);
  }
  return { width: W, height: H, data };
}
const geometry = { baseWidth: W, baseHeight: H, rotatedWidth: W, rotatedHeight: H, rotationAngle: 0, mirrored: false };
const EXTRAS = {
  plain: {},
  flatField: {
    flatField: sanitizeFlatFieldMap({ id: 'pad', width: 2, height: 2, gains: [1, 1.1, 1.2, 1.05, 1, 1.1, 1.2, 1.3, 1, 1, 1.1, 1.2] }),
    flatFieldGeometry: { ...geometry, cropRegion: null },
  },
  strokes: {
    localExposure: { strokes: [{ stops: 0.7, size: 0.4, feather: 0.5, points: [{ x: 0.3, y: 0.5, p: 1 }] }] },
    localExposureGeometry: geometry,
  },
  preSaturation: { preSaturation: 130 },
};
const BASE = {
  color: { colorModel: 'standard', filmBase: { r: 210, g: 140, b: 90 } },
  bw: { colorModel: 'standard' },
  positive: { positiveMode: 'correct' },
};
const SOURCE = { color: negative(), bw: negative(), positive: slide() };
const garbage = () => new Uint16Array(PX * 4).fill(40503);

// Two slider ticks, each with the previous output handed back (or not).
async function drag(mode, extra, options, reuse) {
  invalidateSilverCoreCache();
  const source = SOURCE[mode];
  const outputs = [];
  let previous = reuse ? garbage() : null;
  for (const exposure of [-4, 9]) {
    const result = await CONVERT[mode](source, { ...BASE[mode], ...extra, exposure }, { ...options, workBuffer16: previous || undefined });
    if (previous) assert.equal(result.__image16.data, previous, `${mode}: the output is written into the handed-back plane`);
    outputs.push({ data16: result.__image16.data.slice(), data8: result.data.slice() });
    previous = reuse ? result.__image16.data : null;
  }
  return outputs;
}

for (const mode of ['color', 'bw', 'positive']) {
  for (const [name, extra] of Object.entries(EXTRAS)) {
    for (const [path, options] of [['interactive', { preview: true, includeAnalysisPreview: false }], ['transient', { preview: true, includeAnalysisPreview: false, forceFullProcess: true }]]) {
      const label = `${mode}/${name}/${path}`;
      const fresh = await drag(mode, extra, options, false);
      const reused = await drag(mode, extra, options, true);
      for (let tick = 0; tick < fresh.length; tick++) {
        assert.deepEqual(reused[tick].data16, fresh[tick].data16, `${label} tick ${tick}: 16-bit output equals a fresh allocation`);
        assert.deepEqual(reused[tick].data8, fresh[tick].data8, `${label} tick ${tick}: 8-bit output equals a fresh allocation`);
      }
    }
  }
}

// A plane that is the source itself, or of another size, is refused.
for (const mode of ['color', 'bw', 'positive']) {
  invalidateSilverCoreCache();
  const source = { ...SOURCE[mode], data: SOURCE[mode].data.slice() };
  const before = source.data.slice();
  const settings = { ...BASE[mode], exposure: 3 };
  const expected = await CONVERT[mode](source, settings, { preview: true, includeAnalysisPreview: false });
  for (const workBuffer16 of [source.data, new Uint16Array(PX * 4 - 4).fill(1)]) {
    const result = await CONVERT[mode](source, settings, { preview: true, includeAnalysisPreview: false, workBuffer16 });
    assert.notEqual(result.__image16.data, workBuffer16, `${mode}: an unusable plane is not taken`);
    assert.deepEqual(result.__image16.data, expected.__image16.data);
  }
  assert.deepEqual(source.data, before, `${mode}: the source is never written`);
}
invalidateSilverCoreCache();
console.log('silverAdapter.workBuffer: handed-back planes are written in full on the tail, grey and transient paths; source aliases refused');
