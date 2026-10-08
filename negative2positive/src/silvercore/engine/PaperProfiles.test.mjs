// Standalone Node test for PaperProfiles.js - run with:
// node negative2positive/src/silvercore/engine/PaperProfiles.test.mjs

import assert from 'node:assert/strict';
import {
  paperProfiles,
  paperTonings,
  PAPER_IDS,
  paperCurve,
  paperBlackLevel,
  buildPaperLuts,
  applyPaperLuts,
  paperIdsForFilmKind,
  normalizePaperId,
  normalizeToningId
} from './PaperProfiles.js';

// Every paper is well formed and its curve is monotone within [0, 1].
for (const id of PAPER_IDS) {
  const paper = paperProfiles[id];
  assert.equal(paper.id, id);
  if (paper.kind === 'none') continue;
  assert.ok(paper.dmax > paper.dmin && paper.isoR > 0 && paper.label);
  let previous = -1;
  for (let i = 0; i <= 100; i++) {
    const y = paperCurve(paper, i / 100);
    assert.ok(y >= 0 && y <= 1, `${id} curve in range`);
    assert.ok(y >= previous - 1e-9, `${id} curve monotone at ${i}`);
    previous = y;
  }
  assert.ok(paperCurve(paper, 0) < 0.02 && paperCurve(paper, 1) > 0.98, `${id} curve spans the range`);
}

// Density limits: glossy blacks are deeper than matte blacks; selenium deepens Dmax.
{
  const glossy = paperBlackLevel(paperProfiles['multigrade-rc']);
  const matte = paperBlackLevel(paperProfiles['matte-fibre']);
  assert.ok(glossy < matte, `glossy black ${glossy} < matte black ${matte}`);
  assert.ok(matte > 0.02 && matte < 0.05, 'matte paper black is about 2-3 % of white');
  assert.ok(paperBlackLevel(paperProfiles['multigrade-rc'], paperTonings.selenium) < glossy, 'selenium deepens the black');
}

// LUTs: identity for "none", monotone, black lifted on matte paper, warm whites on warmtone.
{
  assert.equal(buildPaperLuts('none'), null);
  assert.equal(buildPaperLuts('does-not-exist'), null);
  const glossy = buildPaperLuts('multigrade-rc');
  const matte = buildPaperLuts('matte-fibre');
  for (const luts of [glossy, matte]) {
    for (const ch of ['r', 'g', 'b']) {
      assert.equal(luts[ch].length, 65536);
      for (let i = 1; i < 65536; i += 97) assert.ok(luts[ch][i] >= luts[ch][i - 1], 'paper LUT monotone');
    }
  }
  assert.ok(matte.g[0] > glossy.g[0], `matte black ${matte.g[0]} lifted above glossy ${glossy.g[0]}`);
  assert.ok(matte.g[0] > 65535 * 0.06, 'matte black is visibly grey');
  const warm = buildPaperLuts('multigrade-fb-warmtone');
  assert.ok(warm.r[65535] > warm.b[65535], 'warmtone paper white is yellowish');
  const cool = buildPaperLuts('multigrade-fb-cooltone');
  assert.ok(cool.b[65535] >= cool.r[65535], 'cooltone paper white is not yellow');
  // Contrast: a harder paper (Endura, ISO(R) 105) has a steeper mid-slope than a softer one (Fomatone, 120).
  const slope = (luts) => (luts.g[36000] - luts.g[30000]) / 6000;
  assert.ok(slope(buildPaperLuts('endura')) > slope(buildPaperLuts('fomatone')), 'shorter exposure range means more contrast');
  // Strength 0 is identity.
  const off = buildPaperLuts('endura', { strength: 0 });
  for (let i = 0; i < 65536; i += 4111) assert.equal(off.g[i], i);
}

// Toning tints the shadows and highlights the way the darkroom does.
{
  const plain = buildPaperLuts('multigrade-rc');
  const sepia = buildPaperLuts('multigrade-rc', { toning: 'sepia' });
  const selenium = buildPaperLuts('multigrade-rc', { toning: 'selenium' });
  const mid = 32768;
  assert.ok(sepia.r[mid] > sepia.b[mid], 'sepia mid-tones are warm');
  assert.ok(sepia.r[mid] - sepia.b[mid] > plain.r[mid] - plain.b[mid]);
  const shadow = 9000;
  assert.ok(selenium.b[shadow] >= selenium.r[shadow], 'selenium shadows are cool');
  const half = buildPaperLuts('multigrade-rc', { toning: 'sepia', toningStrength: 0.5 });
  assert.ok(half.r[mid] - half.b[mid] < sepia.r[mid] - sepia.b[mid], 'toning strength scales the tint');
  // Toning is a B&W thing: RA-4 paper ignores it.
  const colour = buildPaperLuts('crystal-archive', { toning: 'sepia' });
  assert.equal(colour.toning, 'none');
}

// Applying to an image: in place, all channels through their LUT.
{
  const image = { width: 2, height: 1, data: new Uint16Array([0, 32768, 65535, 65535, 1000, 2000, 3000, 65535]) };
  const luts = buildPaperLuts('matte-fibre');
  applyPaperLuts(image, luts);
  assert.equal(image.data[0], luts.r[0]);
  assert.equal(image.data[1], luts.g[32768]);
  assert.equal(image.data[2], luts.b[65535]);
  assert.equal(image.data[3], 65535, 'alpha untouched');
  assert.equal(image.data[4], luts.r[1000]);
  assert.equal(applyPaperLuts(image, null), image);
}

// Film kind gating and normalisation.
{
  assert.deepEqual(paperIdsForFilmKind('color'), ['none', 'crystal-archive', 'crystal-archive-matte', 'endura']);
  assert.ok(paperIdsForFilmKind('bw').includes('multigrade-rc') && !paperIdsForFilmKind('bw').includes('endura'));
  assert.deepEqual(paperIdsForFilmKind('positive'), ['none']);
  assert.equal(normalizePaperId('endura', 'bw'), 'none', 'RA-4 paper is not offered for B&W');
  assert.equal(normalizePaperId('endura', 'color'), 'endura');
  assert.equal(normalizePaperId('endura'), 'endura');
  assert.equal(normalizePaperId('nope'), 'none');
  assert.equal(normalizeToningId('sepia'), 'sepia');
  assert.equal(normalizeToningId('gold'), 'none');
}

// #239: the cached strength-independent base gives the LUTs of the full build at
// 1703835, kept here as the reference, for every paper, toning and strength, in any
// order (cache hits, misses and evictions).
{
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  const smoothstep = (t) => { const x = clamp01(t); return x * x * (3 - 2 * x); };
  function referencePaperLuts(paperId, { toning = 'none', toningStrength = 1, strength = 1 } = {}) {
    const paper = paperProfiles[paperId];
    if (!paper || paper.kind === 'none') return null;
    const tone = paper.kind === 'bw' && paperTonings[toning] && toning !== 'none' ? paperTonings[toning] : null;
    const toneAmount = tone ? clamp01(toningStrength) : 0;
    const blend = clamp01(strength);
    const black = paperBlackLevel(paper, tone);
    const white = paper.whiteTint || [1, 1, 1];
    const image = paper.imageTone || [1, 1, 1];
    const luts = [new Uint16Array(65536), new Uint16Array(65536), new Uint16Array(65536)];
    for (let i = 0; i < 65536; i++) {
      const x = i / 65535;
      const curve = paperCurve(paper, x);
      const linear = black + (1 - black) * Math.pow(clamp01(curve), 2.2);
      const base = Math.pow(clamp01(linear), 1 / 2.2);
      for (let ch = 0; ch < 3; ch++) {
        let tint = white[ch] * base + (image[ch] - 1) * (1 - base) * base;
        if (tone) {
          const shadowWeight = 1 - smoothstep(base / 0.65);
          const highlightWeight = smoothstep((base - 0.35) / 0.65);
          const shadow = 1 + (tone.shadowTint[ch] - 1) * shadowWeight * toneAmount;
          const highlight = 1 + (tone.highlightTint[ch] - 1) * highlightWeight * toneAmount;
          tint *= shadow * highlight;
        }
        const value = clamp01(tint);
        const mixed = x * (1 - blend) + value * blend;
        luts[ch][i] = Math.round(mixed * 65535);
      }
    }
    return { r: luts[0], g: luts[1], b: luts[2], paperId, toning: tone ? toning : 'none' };
  }
  let checked = 0;
  for (const paperId of PAPER_IDS) {
    for (const toning of Object.keys(paperTonings)) {
      for (const options of [{}, { toningStrength: 0 }, { toningStrength: 0.37 }, { toningStrength: 1, strength: 0.6 }, { toningStrength: 1.4, strength: -1 }]) {
        const expected = referencePaperLuts(paperId, { toning, ...options });
        const actual = buildPaperLuts(paperId, { toning, ...options });
        if (!expected) { assert.equal(actual, null); continue; }
        assert.equal(actual.toning, expected.toning);
        for (const ch of ['r', 'g', 'b']) assert.deepEqual(actual[ch], expected[ch], `${paperId}/${toning}/${JSON.stringify(options)}/${ch}`);
        checked++;
      }
    }
  }
  // Revisit a pair after it was evicted.
  const again = buildPaperLuts('fomatone', { toning: 'sepia', toningStrength: 0.5 });
  assert.deepEqual(again.g, referencePaperLuts('fomatone', { toning: 'sepia', toningStrength: 0.5 }).g);
  assert.ok(checked > 100);
}

console.log('PaperProfiles.test.mjs passed');
