// DX film number lookup and film-kind classification.
//
// The film edge barcode yields DX part 1 (product, 0-127) and part 2
// (generation, 0-15). The Big Film Database keys films by the four-digit
// "DX extract" = part1 * 16 + part2, so a lookup is a single map access once
// the table (dxFilmTable.js, lazily imported) is loaded.
//
// classifyFilmName() derives what the app can act on from a trade name:
// the film kind (color negative / B&W / positive) and a starting film preset.

let tablePromise = null;

export async function loadDxFilmTable() {
  if (!tablePromise) {
    tablePromise = import('./dxFilmTable.js').then((module) => {
      const map = new Map();
      for (const [extract, names] of module.DX_FILM_TABLE) map.set(extract, names);
      return map;
    }).catch((error) => {
      tablePromise = null;
      throw error;
    });
  }
  return tablePromise;
}

export function dxExtractFromParts(dx1, dx2) {
  if (!Number.isInteger(dx1) || !Number.isInteger(dx2)) return null;
  if (dx1 < 0 || dx1 > 127 || dx2 < 0 || dx2 > 15) return null;
  return dx1 * 16 + dx2;
}

const POSITIVE_WORDS = [
  'CHROME', 'PROVIA', 'VELVIA', 'ASTIA', 'SENSIA', 'KODACHROME', 'EKTACHROME', 'ELITE CHROME',
  'AGFACHROME', 'DIAPOSITIVE', 'SLIDE', 'REVERSAL', 'CT PRECISA', 'E100', 'E200', 'FUJICHROME'
];
const BW_WORDS = [
  'TRI-X', 'TRI X', 'T-MAX', 'TMAX', 'HP5', 'FP4', 'PAN F', 'DELTA', 'XP2', 'KENTMERE', 'FOMAPAN',
  'APX', 'ACROS', 'NEOPAN', 'PLUS-X', 'PLUS X', 'DOUBLE-X', 'DOUBLE X', 'ORTHO', 'RETRO', 'RPX',
  'SILVERMAX', 'BW400', 'T400CN', 'B&W', 'BLACK AND WHITE', 'BLACK & WHITE', 'SCHWARZ', 'PANCHRO',
  'AGFAPAN', 'ILFORD', 'FOMA ', 'ADOX', 'ROLLEI', 'BERGGER', 'STREET PAN', 'CINESTILL BWXX', 'ORWO N',
  'ORWO UN', 'UN54', 'N74', 'ARISTA EDU'
];
const COLOR_HINTS = ['COLOR', 'COLOUR', 'FARB', 'GOLD', 'PORTRA', 'EKTAR', 'SUPERIA', 'VISION', 'PHOENIX', 'CINESTILL 8', 'CINESTILL 4', 'CINESTILL 5', 'CINESTILL 2'];

const PRESET_RULES = [
  { kind: 'color', preset: 'portra-classic', words: ['PORTRA', 'VERICOLOR', 'PRO IMAGE'] },
  { kind: 'color', preset: 'rich-depth', words: ['EKTAR'] },
  { kind: 'color', preset: 'cinema-stock', words: ['VISION3', 'VISION 3', 'CINESTILL 800', 'CINESTILL 400', 'CINESTILL 50', 'CINESTILL 250', '500T', '250D', '800T', '50D'] },
  { kind: 'color', preset: 'gold-warm', words: ['ULTRA MAX', 'ULTRAMAX', 'GOLD', 'COLORPLUS', 'COLOR PLUS', 'KODACOLOR', 'FARBWELT', 'FUNTIME', 'ROYAL', 'MAX 400', 'MAX 800', 'KODAK 200', 'KODAK 400'] },
  { kind: 'color', preset: 'superia-vivid', words: ['SUPERIA', 'FUJICOLOR', 'FUJIFILM', 'FUJI ', 'C200', 'PRO 400H', 'PRO 160', 'REALA', 'NATURA', 'VENUS', 'NPH', 'NPS', 'NPC', 'VISTA', 'AGFA', 'KONICA', 'CENTURIA'] },
  { kind: 'positive', preset: 'slide-rich', words: ['VELVIA'] },
  { kind: 'positive', preset: 'slide-neutral', words: POSITIVE_WORDS },
  { kind: 'bw', preset: 'filmic-bw', words: BW_WORDS }
];

// Returns { filmKind: 'color' | 'bw' | 'positive' | null, presetId: string | null }.
export function classifyFilmName(name) {
  if (!name || typeof name !== 'string') return { filmKind: null, presetId: null };
  const upper = ` ${name.toUpperCase()} `;
  const isColor = COLOR_HINTS.some((word) => upper.includes(word));
  const isPositive = POSITIVE_WORDS.some((word) => upper.includes(word));
  const isBw = !isColor && !isPositive && BW_WORDS.some((word) => upper.includes(word));
  if (isPositive) {
    const rule = PRESET_RULES.find((r) => r.kind === 'positive' && r.words.some((w) => upper.includes(w)));
    return { filmKind: 'positive', presetId: rule ? rule.preset : 'slide-neutral' };
  }
  if (isBw) return { filmKind: 'bw', presetId: 'filmic-bw' };
  const rule = PRESET_RULES.find((r) => r.kind === 'color' && r.words.some((w) => upper.includes(w)));
  if (rule) return { filmKind: 'color', presetId: rule.preset };
  if (isColor) return { filmKind: 'color', presetId: null };
  return { filmKind: null, presetId: null };
}

// Builds the user-facing description for a decoded DX number. `table` is the
// map from loadDxFilmTable(); pass null when the table is unavailable and only
// the raw number is returned.
export function describeDxFilm(dx1, dx2, table) {
  const dxExtract = dxExtractFromParts(dx1, dx2);
  if (dxExtract === null) return null;
  const names = table instanceof Map ? (table.get(dxExtract) || []) : [];
  const primaryName = names[0] || null;
  const classification = classifyFilmName(primaryName);
  return {
    dx1,
    dx2,
    dxNumber: `${dx1}-${dx2}`,
    dxExtract,
    names: names.slice(),
    primaryName,
    filmKind: classification.filmKind,
    presetId: classification.presetId
  };
}

// Short label for badges and toasts: "Kodak ULTRA MAX 400 Film GC400" ->
// "Kodak ULTRA MAX 400".
export function shortFilmName(name, maxLength = 28) {
  if (!name) return '';
  const tidy = (text) => text
    .replace(/\s+([,;:])/g, '$1')
    .replace(/[,;:\s-]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  let short = tidy(name
    .replace(/\s*\((?:gen\.?|generation)[^)]*\)/gi, '')
    .replace(/\b(Professional|Film|Color Negative|Colour Negative|Negative)\b/gi, ''));
  const words = short.split(' ');
  while (short.length > maxLength && words.length > 2) {
    words.pop();
    short = tidy(words.join(' '));
  }
  return short || name;
}
