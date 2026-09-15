import { KODAK_YEAR_CODES, YEAR_SYMBOL_BITMAPS, decodeKodakYear } from './kodakYearCodes.js';
import { BITMAP_FONT } from './sprocketFrame.js';
import { classifyFilmName } from './dxFilmDatabase.js';
const STOCKS = ['PORTRA 160', 'PORTRA 400', 'PORTRA 800', 'EKTAR 100', 'GOLD 100', 'GOLD 200', 'GOLD 400', 'ULTRAMAX 400', 'SUPERIA 200', 'SUPERIA 400', 'DELTA 100', 'DELTA 400', 'DELTA 3200', 'PORTRA', 'EKTAR', 'GOLD', 'ULTRAMAX', 'SUPERIA', 'PRO 400H', 'HP5', 'FP4', 'DELTA', 'PAN F', 'TRI-X', 'T-MAX', 'TMAX', 'KENTMERE', 'FOMAPAN', 'CINESTILL', 'LOMOGRAPHY', 'EKTACHROME', 'PROVIA', 'VELVIA'];
const WORDS = ['KODAK', 'FUJIFILM', 'FUJI', 'ILFORD', 'FOMA', ...STOCKS];
export function edgeTextTemplate(text) {
  const chars = [...text]; const width = chars.length * 6 - 1;
  const data = new Float32Array(width * 7);
  chars.forEach((char, i) => { const rows = YEAR_SYMBOL_BITMAPS[char] || BITMAP_FONT[char]; if (!rows) return; rows.forEach((row, y) => [...row].forEach((v, x) => { data[y * width + i * 6 + x] = Number(v); })); });
  return { width, height: 7, data };
}
export function normalizedCorrelation(a, b) {
  if (a.length !== b.length || !a.length) return 0;
  const meanA = a.reduce((s, v) => s + v, 0) / a.length;
  const meanB = b.reduce((s, v) => s + v, 0) / b.length;
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - meanA, y = b[i] - meanB; ab += x * y; aa += x * x; bb += y * y; }
  return aa * bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}
function matches(line, template, cv) {
  if (line.width < template.width) return [];
  const found = [];
  if (cv?.matchTemplate) {
    let src, target, scores;
    try {
      src = cv.matFromArray(7, line.width, cv.CV_32FC1, line.data);
      target = cv.matFromArray(7, template.width, cv.CV_32FC1, template.data); scores = new cv.Mat();
      cv.matchTemplate(src, target, scores, cv.TM_CCOEFF_NORMED);
      for (let x = 0; x < scores.cols; x++) if (scores.data32F[x] >= 0.94) found.push({ x, score: scores.data32F[x] });
    } finally { src?.delete(); target?.delete(); scores?.delete(); }
  } else {
    const crop = new Float32Array(template.data.length);
    for (let x = 0; x <= line.width - template.width; x++) {
      for (let y = 0; y < 7; y++) crop.set(line.data.subarray(y * line.width + x, y * line.width + x + template.width), y * template.width);
      const score = normalizedCorrelation(crop, template.data);
      if (score >= 0.94) found.push({ x, score });
    }
  }
  return found;
}
export function readEdgeTextLine(line, { cv = null } = {}) {
  const candidates = [];
  for (const word of WORDS) for (const match of matches(line, edgeTextTemplate(word), cv)) candidates.push({ ...match, word });
  const stock = candidates.filter(c => STOCKS.includes(c.word)).sort((a, b) => b.word.length - a.word.length || b.score - a.score)[0];
  const maker = candidates.find(c => ['KODAK', 'FUJIFILM', 'FUJI', 'ILFORD', 'FOMA'].includes(c.word));
  let date = { year: null, candidates: [] };
  if (maker?.word === 'KODAK') {
    const codes = [];
    for (const symbols of Object.keys(KODAK_YEAR_CODES).filter(s => s.length >= 2)) {
      for (const match of matches(line, edgeTextTemplate(symbols), cv)) {
        if (match.x >= maker.x + 5 * 6 && match.x <= maker.x + 5 * 6 + 18) codes.push({ symbols, ...match });
      }
    }
    codes.sort((a, b) => b.symbols.length - a.symbols.length || b.score - a.score);
    if (codes[0]) date = decodeKodakYear(codes[0].symbols);
  }
  if (!stock && !date.candidates.length) return null;
  // A stock word is required; isolated frame digits/manufacturer text do not
  // establish a rebate. Search digits only outside stock/manufacturer spans.
  const spans = candidates.map(c => [c.x - 2, c.x + c.word.length * 6 + 2]);
  const numbers = [];
  for (let n = 1; n <= 40; n++) for (const suffix of ['', 'A']) {
    const word = String(n) + suffix, template = edgeTextTemplate(word);
    for (const match of matches(line, template, cv)) {
      if (spans.some(([a, b]) => match.x < b && match.x + template.width > a)) continue;
      let boundary = 0;
      for (let y = 0; y < 7; y++) for (let gap = 0; gap < 3; gap++) {
        const before = match.x - 1 - gap, after = match.x + template.width + gap;
        if (before >= 0) boundary += line.data[y * line.width + before];
        if (after < line.width) boundary += line.data[y * line.width + after];
      }
      if (boundary > 0.5) continue;
      numbers.push({ ...match, word });
    }
  }
  numbers.sort((a, b) => Math.abs(a.x - line.width / 2) - Math.abs(b.x - line.width / 2));
  const filmName = `${maker ? maker.word + ' ' : ''}${stock?.word || ''}`.trim();
  return { text: filmName, filmName, ...classifyFilmName(filmName), frameNumber: numbers[0]?.word || null, confidence: stock?.score || maker.score, year: date.year, yearCandidates: date.candidates };
}
function lineCandidates(band) {
  // Uniform rebate is the dominant population; reject highly textured image
  // rows. Try dense and clear printing. Projection locates the text baseline.
  const finite = [...band.values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return [];
  const base = finite[Math.floor(finite.length * 0.5)];
  const lines = [];
  for (const polarity of [-1, 1]) {
    const ink = new Float32Array(band.values.length);
    const occupied = [];
    for (let y = 0; y < band.rows; y++) {
      let n = 0;
      for (let x = 0; x < band.cols; x++) { const v = Number(polarity * (band.values[y * band.cols + x] - base) > 28); ink[y * band.cols + x] = v; n += v; }
      if (n >= 3 && n < band.cols * 0.45) occupied.push(y);
    }
    const groups = [];
    for (const y of occupied) { const last = groups.at(-1); if (last && y - last.at(-1) <= 2) last.push(y); else groups.push([y]); }
    for (const rows of groups) {
      const top = rows[0], height = rows.at(-1) - top + 1;
      if (height < 7 || height > 70) continue;
      for (const stretch of [1, 0.9, 1.1]) {
        const width = Math.round(band.cols * 7 / height * stretch);
        if (width < 18 || width > 1800) continue;
        const data = new Float32Array(width * 7);
        for (let y = 0; y < 7; y++) for (let x = 0; x < width; x++) {
          // Average within cells so round dot-matrix marks survive sampling.
          const x0 = Math.floor(x * band.cols / width), x1 = Math.max(x0 + 1, Math.floor((x + 1) * band.cols / width));
          const y0 = top + Math.floor(y * height / 7), y1 = Math.max(y0 + 1, top + Math.floor((y + 1) * height / 7));
          let sum = 0, count = 0;
          for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { sum += ink[yy * band.cols + xx]; count++; }
          data[y * width + x] = sum / count > 0.3 ? 1 : 0;
        }
        lines.push({ width, height: 7, data, polarity: polarity === 1 ? 'light' : 'dark' });
      }
    }
  }
  return lines;
}
export function readTextInBands(bands, options = {}) {
  const hits = [];
  for (const band of bands) for (const line of lineCandidates(band)) for (const upsideDown of [false, true]) for (const mirrored of [false, true]) {
    const data = new Float32Array(line.data.length);
    for (let y = 0; y < 7; y++) for (let x = 0; x < line.width; x++) data[y * line.width + x] = line.data[(upsideDown ? 6 - y : y) * line.width + ((mirrored !== upsideDown) ? line.width - 1 - x : x)];
    const hit = readEdgeTextLine({ ...line, data }, options);
    if (hit) hits.push({ ...hit, mirrorDetected: mirrored, polarity: line.polarity });
  }
  hits.sort((a, b) => b.confidence - a.confidence);
  const best = hits[0];
  if (!best) return null;
  const opposing = hits.find(hit => hit.mirrorDetected !== best.mirrorDetected);
  // An ambiguous orientation may identify stock, but cannot change geometry.
  return { ...best, mirrorDetected: best.mirrorDetected && (!opposing || best.confidence - opposing.confidence > 0.08) };
}
export function borderTextBands(image) {
  const bands = [];
  for (const vertical of [false, true]) for (const far of [false, true]) {
    const along = vertical ? image.height : image.width, across = vertical ? image.width : image.height;
    const step = Math.max(1, Math.ceil(along / 1800));
    const cols = Math.floor(along / step), rows = Math.min(140, Math.floor(across * 0.08 / step));
    const values = new Float32Array(rows * cols);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const a = x * step, b = far ? across - 1 - y * step : y * step;
      const i = ((vertical ? a : b) * image.width + (vertical ? b : a)) * 4;
      values[y * cols + x] = (image.data[i] + image.data[i + 1] + image.data[i + 2]) / 3;
    }
    bands.push({ rows, cols, values });
  }
  return bands;
}
