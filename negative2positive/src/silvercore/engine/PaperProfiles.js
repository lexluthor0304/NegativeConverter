// Paper emulation: what the converted positive would look like printed on a
// given photographic paper. Applied as the last colour stage of the engine
// (after the tone curves, 3D profile and saturation, before sharpening) as
// three 16-bit LUTs, so it costs one LUT pass.
//
// Each paper is a parametric characteristic curve in display space plus the
// paper's density limits and base tint:
//   - dmin / dmax: reflection densities of paper white and maximum black. The
//     black level of the print is 10^-(dmax - dmin) of the white, which is
//     what separates a glossy fibre paper (Dmax ~2.2, black 0.6 %) from a
//     matte surface (Dmax ~1.65, black 2.2 %, visibly lifted blacks).
//   - isoR: exposure range (log exposure x100 between 0.04 above Dmin and
//     0.9 of Dmax). Relative to 110 it scales the mid-tone slope; a shorter
//     range is a harder paper.
//   - toe / shoulder: softness of the curve ends in [0, 1].
//   - whiteTint: RGB multipliers of the paper base (warmtone papers are
//     slightly yellow, cooltone slightly blue).
// Values are approximations drawn from published data sheets, documented in
// docs/darkroom.md. They give each paper its recognisable character rather
// than a colorimetric match.

export const paperProfiles = Object.freeze({
  none: { id: 'none', kind: 'none', label: 'None' },
  // RA-4 colour papers
  'crystal-archive': {
    id: 'crystal-archive', kind: 'ra4', label: 'Fujicolor Crystal Archive (glossy)',
    dmin: 0.08, dmax: 2.25, isoR: 110, toe: 0.35, shoulder: 0.45, whiteTint: [1, 1, 0.995]
  },
  'crystal-archive-matte': {
    id: 'crystal-archive-matte', kind: 'ra4', label: 'Fujicolor Crystal Archive (matte)',
    dmin: 0.1, dmax: 1.75, isoR: 115, toe: 0.4, shoulder: 0.5, whiteTint: [1, 1, 0.995]
  },
  endura: {
    id: 'endura', kind: 'ra4', label: 'Kodak Professional Endura (glossy)',
    dmin: 0.07, dmax: 2.3, isoR: 105, toe: 0.3, shoulder: 0.4, whiteTint: [1, 0.998, 0.99]
  },
  // B&W papers
  'multigrade-rc': {
    id: 'multigrade-rc', kind: 'bw', label: 'Ilford Multigrade RC (pearl)',
    dmin: 0.06, dmax: 2.1, isoR: 110, toe: 0.4, shoulder: 0.45, whiteTint: [1, 1, 1]
  },
  'multigrade-fb-warmtone': {
    id: 'multigrade-fb-warmtone', kind: 'bw', label: 'Ilford Multigrade FB Warmtone',
    dmin: 0.09, dmax: 2.05, isoR: 115, toe: 0.5, shoulder: 0.5, whiteTint: [1, 0.985, 0.955], imageTone: [1, 0.985, 0.96]
  },
  'multigrade-fb-cooltone': {
    id: 'multigrade-fb-cooltone', kind: 'bw', label: 'Ilford Multigrade FB Cooltone',
    dmin: 0.06, dmax: 2.2, isoR: 105, toe: 0.35, shoulder: 0.4, whiteTint: [0.985, 0.995, 1], imageTone: [0.985, 0.995, 1]
  },
  fomatone: {
    id: 'fomatone', kind: 'bw', label: 'Fomatone MG Classic (warm)',
    dmin: 0.1, dmax: 1.9, isoR: 120, toe: 0.55, shoulder: 0.55, whiteTint: [1, 0.98, 0.94], imageTone: [1, 0.975, 0.935]
  },
  'matte-fibre': {
    id: 'matte-fibre', kind: 'bw', label: 'Matte fibre paper',
    dmin: 0.1, dmax: 1.65, isoR: 115, toe: 0.5, shoulder: 0.6, whiteTint: [1, 0.995, 0.985]
  }
});

// Toning for B&W papers. Tints are RGB multipliers at full strength; shadows
// and highlights are weighted separately so selenium cools the deep tones
// while sepia warms the mid-tones and highlights most.
export const paperTonings = Object.freeze({
  none: { id: 'none', label: 'None' },
  selenium: { id: 'selenium', label: 'Selenium', shadowTint: [0.985, 0.97, 1.0], highlightTint: [1, 1, 1], dmaxBoost: 0.1 },
  sepia: { id: 'sepia', label: 'Sepia', shadowTint: [1, 0.93, 0.82], highlightTint: [1, 0.975, 0.93], dmaxBoost: -0.05 },
  split: { id: 'split', label: 'Split (sepia + selenium)', shadowTint: [0.985, 0.97, 1.0], highlightTint: [1, 0.965, 0.9], dmaxBoost: 0.05 }
});

export const PAPER_IDS = Object.freeze(Object.keys(paperProfiles));
export const TONING_IDS = Object.freeze(Object.keys(paperTonings));

const LUT_SIZE = 65536;

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smoothstep(t) {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

// Parametric paper curve in display space: a straight section through mid
// grey whose slope follows the paper's exposure range (110 / ISO(R)), blended
// back to the identity towards black and white. The toe and shoulder values
// set how early that blend starts, i.e. how soft the ends are. y(0) = 0 and
// y(1) = 1 always hold and the curve stays monotone for the paper contrasts
// in use (0.85-1.1).
export function paperCurve(paper, x) {
  const t = clamp01(x);
  const contrast = 110 / (paper.isoR || 110);
  const toe = clamp01(paper.toe ?? 0.4);
  const shoulder = clamp01(paper.shoulder ?? 0.45);
  const line = 0.5 + (t - 0.5) * contrast;
  const lo = 0.12 + 0.28 * toe;
  const hi = 0.88 - 0.28 * shoulder;
  let w = 0;
  if (t < lo) w = smoothstep((lo - t) / lo);
  else if (t > hi) w = smoothstep((t - hi) / (1 - hi));
  return clamp01(line + (t - line) * w);
}

// Reflectance of paper black relative to paper white.
export function paperBlackLevel(paper, toning = null) {
  const dmax = (paper.dmax || 2.1) + (toning?.dmaxBoost || 0);
  return Math.pow(10, -Math.max(0, dmax - (paper.dmin || 0.06)));
}

// sRGB-ish transfer used to place the paper's black level in display space.
function encodeDisplay(linear) {
  return Math.pow(clamp01(linear), 1 / 2.2);
}

function decodeDisplay(value) {
  return Math.pow(clamp01(value), 2.2);
}

// Builds three Uint16 LUTs (index = input 16-bit value, output 16-bit).
// `strength` in [0, 1] blends against identity.
export function buildPaperLuts(paperId, { toning = 'none', toningStrength = 1, strength = 1 } = {}) {
  const paper = paperProfiles[paperId];
  if (!paper || paper.kind === 'none') return null;
  const tone = paper.kind === 'bw' && paperTonings[toning] && toning !== 'none' ? paperTonings[toning] : null;
  const toneAmount = tone ? clamp01(toningStrength) : 0;
  const blend = clamp01(strength);
  const black = paperBlackLevel(paper, tone);
  const white = paper.whiteTint || [1, 1, 1];
  const image = paper.imageTone || [1, 1, 1];
  const luts = [new Uint16Array(LUT_SIZE), new Uint16Array(LUT_SIZE), new Uint16Array(LUT_SIZE)];
  for (let i = 0; i < LUT_SIZE; i++) {
    const x = i / (LUT_SIZE - 1);
    const curve = paperCurve(paper, x);
    // Place between paper black and paper white in linear light, then encode.
    const linear = black + (1 - black) * decodeDisplay(curve);
    const base = encodeDisplay(linear);
    for (let ch = 0; ch < 3; ch++) {
      // Paper white tints the highlights, the image tone tints the silver/dye.
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
      luts[ch][i] = Math.round(mixed * (LUT_SIZE - 1));
    }
  }
  return { r: luts[0], g: luts[1], b: luts[2], paperId, toning: tone ? toning : 'none' };
}

// Applies the paper LUTs to a 16-bit RGBA image in place.
export function applyPaperLuts(image16, luts) {
  if (!image16 || !luts) return image16;
  const data = image16.data;
  const { r, g, b } = luts;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r[data[i]];
    data[i + 1] = g[data[i + 1]];
    data[i + 2] = b[data[i + 2]];
  }
  return image16;
}

// Which papers make sense for a film type: colour negatives print on RA-4,
// B&W negatives on B&W papers; slides are not printed here.
export function paperIdsForFilmKind(kind) {
  if (kind === 'color') return PAPER_IDS.filter((id) => id === 'none' || paperProfiles[id].kind === 'ra4');
  if (kind === 'bw') return PAPER_IDS.filter((id) => id === 'none' || paperProfiles[id].kind === 'bw');
  return ['none'];
}

export function normalizePaperId(value, kind = null) {
  const id = typeof value === 'string' && paperProfiles[value] ? value : 'none';
  if (kind && !paperIdsForFilmKind(kind).includes(id)) return 'none';
  return id;
}

export function normalizeToningId(value) {
  return typeof value === 'string' && paperTonings[value] ? value : 'none';
}
