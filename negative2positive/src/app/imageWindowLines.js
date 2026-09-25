// 閉じた輪郭が得られないフィルムでも、独立した四辺を組み合わせる。
// 比率から辺を作らず、画像上で観測できる線分だけを候補にする。

// Medians of the window search (#251): the samples are finite integers (pixel
// values, their differences and sums), so a Float64Array copy sorted natively
// yields the same order statistic as the comparator sort of a spread copy,
// without allocating per call. One scratch view per length (19, 31, 41, 76);
// each worker has its own module instance, and nothing here re-enters.
const medianScratch = new Map();
export function sampleMedian(values, length = values.length) {
  let scratch = medianScratch.get(length);
  if (!scratch) medianScratch.set(length, scratch = new Float64Array(length));
  for (let i = 0; i < length; i++) scratch[i] = values[i];
  scratch.sort();
  return scratch[length >> 1];
}
const median = values => sampleMedian(values);

function sample(image, x, y) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
}

// The pre-#251 evidence, kept for inputs whose sample coordinates are not
// finite (a zero-length or NaN segment). The search never produces one: its
// slopes stay within |m| <= .27, so every intersection is finite.
function lineEvidenceFallback(image, p, q) {
  const sorted = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const length = Math.hypot(q.x - p.x, q.y - p.y);
  const nx = -(q.y - p.y) / length, ny = (q.x - p.x) / length;
  const gap = Math.max(3, Math.min(image.width, image.height) * .004);
  const a = [], b = [], deltas = [];
  for (let j = 1; j < 32; j++) {
    const t = j / 32, x = p.x + (q.x - p.x) * t, y = p.y + (q.y - p.y) * t;
    const inside = sample(image, x + nx * gap, y + ny * gap);
    const outside = sample(image, x - nx * gap, y - ny * gap);
    if (!inside || !outside) return 0;
    a.push(inside); b.push(outside);
    deltas.push(Math.max(...inside.map((v, c) => Math.abs(v - outside[c]))));
  }
  const variation = pixels => {
    const color = [0, 1, 2].map(c => sorted(pixels.map(p => p[c])));
    return sorted(pixels.map(p => Math.max(...p.map((v, c) => Math.abs(v - color[c])))));
  };
  const contrast = sorted(deltas), support = deltas.filter(d => d >= 10).length / deltas.length;
  if (contrast < 12 || support < .65) return 0;
  const clean = Math.min(variation(a), variation(b));
  if (clean > 18) return 0;
  return support * .5 + Math.min(contrast / 80, 1) * .25 + (1 - clean / 24) * .25;
}

const EVIDENCE_SAMPLES = 31;
const evidenceInside = new Float64Array(EVIDENCE_SAMPLES * 3);
const evidenceOutside = new Float64Array(EVIDENCE_SAMPLES * 3);
const evidenceDeltas = new Float64Array(EVIDENCE_SAMPLES);
const evidenceChannel = new Float64Array(EVIDENCE_SAMPLES);

// Median absolute deviation (max over RGB) of 31 interleaved pixels from
// their per-channel median colour.
function evidenceVariation(pixels) {
  const color = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    for (let j = 0; j < EVIDENCE_SAMPLES; j++) evidenceChannel[j] = pixels[j * 3 + c];
    color[c] = sampleMedian(evidenceChannel);
  }
  for (let j = 0, i = 0; j < EVIDENCE_SAMPLES; j++, i += 3) {
    evidenceChannel[j] = Math.max(Math.abs(pixels[i] - color[0]), Math.abs(pixels[i + 1] - color[1]), Math.abs(pixels[i + 2] - color[2]));
  }
  return sampleMedian(evidenceChannel);
}

// 長さだけでは被写体の建物・木・粒状性が上位を占める。片側に均一な片基が
// 連続している線を優先し、穴や隣接コマを横切る仮想線は支持率で落とす。
// Most candidate lines have no real border: support >= .65 allows at most 10
// of the 31 deltas below 10, and a median >= 12 at most 15 below 12, so the
// walk stops as soon as either count is exceeded (the result is 0 either
// way, as it is for a sample outside the image).
export function lineEvidence(image, p, q) {
  const length = Math.hypot(q.x - p.x, q.y - p.y);
  if (!(length > 0 && length < Infinity)) return lineEvidenceFallback(image, p, q);
  const nx = -(q.y - p.y) / length, ny = (q.x - p.x) / length;
  const { width, height, data } = image;
  const gap = Math.max(3, Math.min(width, height) * .004);
  let unsupported = 0, low = 0;
  for (let j = 1, k = 0; j < 32; j++, k += 3) {
    const t = j / 32, x = p.x + (q.x - p.x) * t, y = p.y + (q.y - p.y) * t;
    const ix = Math.round(x + nx * gap), iy = Math.round(y + ny * gap);
    if (ix < 0 || iy < 0 || ix >= width || iy >= height) return 0;
    const ox = Math.round(x - nx * gap), oy = Math.round(y - ny * gap);
    if (ox < 0 || oy < 0 || ox >= width || oy >= height) return 0;
    const i = (iy * width + ix) * 4, o = (oy * width + ox) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const R = data[o], G = data[o + 1], B = data[o + 2];
    const delta = Math.max(Math.abs(r - R), Math.abs(g - G), Math.abs(b - B));
    if (delta < 10 && ++unsupported >= 11) return 0;
    if (delta < 12 && ++low >= 16) return 0;
    evidenceInside[k] = r; evidenceInside[k + 1] = g; evidenceInside[k + 2] = b;
    evidenceOutside[k] = R; evidenceOutside[k + 1] = G; evidenceOutside[k + 2] = B;
    evidenceDeltas[j - 1] = delta;
  }
  const contrast = sampleMedian(evidenceDeltas), support = (EVIDENCE_SAMPLES - unsupported) / EVIDENCE_SAMPLES;
  if (contrast < 12 || support < .65) return 0;
  const clean = Math.min(evidenceVariation(evidenceInside), evidenceVariation(evidenceOutside));
  if (clean > 18) return 0;
  return support * .5 + Math.min(contrast / 80, 1) * .25 + (1 - clean / 24) * .25;
}

function intersect(h, v) {
  const x = (v.m * h.b + v.b) / (1 - v.m * h.m);
  return { x, y: h.m * x + h.b };
}

function isOpenPair(image, a, b, verticalPair) {
  const span = verticalPair ? image.height : image.width;
  const center = verticalPair ? image.width / 2 : image.height / 2;
  if (a.position >= center || b.position <= center) return false;
  // 少なくとも一辺が実際に撮影範囲の端まで観測されていること。
  const reachesEdge = [a, b].some(line => [line.p, line.q].some(p => {
    const v = verticalPair ? p.y : p.x;
    return v < 4 || v > span - 5;
  }));
  if (!reachesEdge) return false;
  const gap = Math.max(3, Math.min(image.width, image.height) * .004);
  const colors = [], signs = [], supports = [], contrasts = [], endSupport = [0, 0];
  for (const [index, line] of [a, b].entries()) {
    const outside = [], deltas = [], signed = [];
    for (let j = 0; j < 41; j++) {
      const v = 2 + (span - 5) * j / 40, u = line.m * v + line.b;
      const d = index === 0 ? gap : -gap;
      const inside = verticalPair ? sample(image, u + d, v) : sample(image, v, u + d);
      const out = verticalPair ? sample(image, u - d, v) : sample(image, v, u - d);
      if (!inside || !out) return false;
      const delta = Math.max(...inside.map((x, c) => Math.abs(x - out[c])));
      if (j === 0 && delta >= 12) endSupport[0]++;
      if (j === 40 && delta >= 12) endSupport[1]++;
      outside.push(out); deltas.push(delta);
      signed.push(inside.reduce((sum, x, c) => sum + x - out[c], 0));
    }
    const support = deltas.filter(d => d >= 12).length / deltas.length;
    if (median(deltas) < 8 || support < .4) return false;
    supports.push(support); contrasts.push(median(deltas));
    const color = [0, 1, 2].map(c => median(outside.map(p => p[c])));
    if (median(outside.map(p => Math.max(...p.map((x, c) => Math.abs(x - color[c]))))) > 18) return false;
    colors.push(color); signs.push(Math.sign(median(signed)));
  }
  // 白黒の空・白い被写体は片側の境界が薄いことがある。これは切り抜きの
  // 根拠ではなく「要確認」の判定だけに使い、少なくとも他方は強い辺を要求する。
  return Math.max(...supports) >= .8 && Math.max(...contrasts) >= 25
    && endSupport.some(count => count >= 1) && signs[0] === -1 && signs[1] === -1
    && colors[0].every((v, c) => Math.abs(v - colors[1][c]) <= 24);
}

// 窓の辺は縦横 ±15° の直線だけなので、全 1800 方向を探索する確率的 Hough
// (HoughLinesP) の代わりに、方向を限定した標準 Hough で強い直線を拾い、その
// 直線上の輪郭画素を走査して線分にする。粒状の強いスキャンでは HoughLinesP が
// 1 チャンネルあたり 2〜5 秒かかっていたが、この経路は数十 ms で同じ線分を
// 返し、最小二乗の当てはめで傾きは画素未満の精度になる。
const AXIS_RANGE_RAD = 15 * Math.PI / 180;
const HOUGH_THETA_STEP = Math.PI / 1800;
const HOUGH_MAX_PEAKS = 240;

// 標準 Hough のピーク (rho, theta) を票数順に返す。OpenCV は隣接ビンを抑制済み。
function houghPeaks(cv, edges, minTheta, maxTheta, threshold) {
  const lines = new cv.Mat();
  try {
    cv.HoughLines(edges, lines, 1, HOUGH_THETA_STEP, threshold, 0, 0, minTheta, maxTheta);
    const data = lines.data32F, peaks = [];
    for (let i = 0; i + 1 < data.length && peaks.length < HOUGH_MAX_PEAKS * 4; i += 2) peaks.push({ rho: data[i], theta: data[i + 1] });
    return peaks;
  } finally { lines.delete(); }
}

// 一本の無限直線に沿って輪郭画素を走査し、許容間隔以内で連続する区間を線分に
// する。当たった画素で直線を当てはめ直し、端点はその直線上に置く。
function walkLineSegments(edges, width, height, rho, theta, minLength, maxGap, out, tolerance = 1) {
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const horizontal = Math.abs(sin) >= Math.abs(cos);
  const span = horizontal ? width : height, limit = horizontal ? height : width;
  const data = edges.data;
  let runStart = -1, lastHit = -1, sumU = 0, sumV = 0, sumUU = 0, sumUV = 0, count = 0;
  const flush = () => {
    if (runStart >= 0 && lastHit - runStart + 1 >= minLength && count >= 2) {
      const denom = count * sumUU - sumU * sumU;
      const slope = Math.abs(denom) > 1e-9 ? (count * sumUV - sumU * sumV) / denom : 0;
      const intercept = (sumV - slope * sumU) / count;
      const p = horizontal ? { x: runStart, y: intercept + slope * runStart } : { x: intercept + slope * runStart, y: runStart };
      const q = horizontal ? { x: lastHit, y: intercept + slope * lastHit } : { x: intercept + slope * lastHit, y: lastHit };
      out.push({ p, q });
    }
    runStart = -1; lastHit = -1; sumU = sumV = sumUU = sumUV = 0; count = 0;
  };
  for (let u = 0; u < span; u++) {
    // 直線上の位置。theta の量子化 (0.1°) による画素ずれは隣接 1 画素で吸収する。
    const center = horizontal ? (rho - u * cos) / sin : (rho - u * sin) / cos;
    // v0, then v0 - d before v0 + d for d = 1..tolerance, without building
    // an array per step (#251). `center` stays the direct formula: an
    // incremental sum would round v0 differently.
    const v0 = Math.round(center);
    let hit = -1;
    if (v0 >= 0 && v0 < limit && data[horizontal ? v0 * width + u : u * width + v0]) hit = v0;
    for (let d = 1; d <= tolerance && hit < 0; d++) {
      const below = v0 - d, above = v0 + d;
      if (below >= 0 && below < limit && data[horizontal ? below * width + u : u * width + below]) hit = below;
      else if (above >= 0 && above < limit && data[horizontal ? above * width + u : u * width + above]) hit = above;
    }
    if (hit < 0) {
      if (runStart >= 0 && u - lastHit > maxGap) flush();
      continue;
    }
    if (runStart < 0) runStart = u;
    lastHit = u;
    sumU += u; sumV += hit; sumUU += u * u; sumUV += u * hit; count++;
  }
  flush();
}

// 一方向（法線が縦 = 水平に近い線）のピークを走査する。投票は元の解像度で
// 集計する: 1/2 に縮めた輪郭では、撮影範囲の端で切れた辺の検出が変わり、
// 「確認必須」であるべき画格が裁切されてしまった。
function collectAxisSegments(cv, edges, width, height, axisRange, threshold, minLength, maxGap, out) {
  const kept = [];
  for (const peak of houghPeaks(cv, edges, Math.PI / 2 - axisRange, Math.PI / 2 + axisRange, threshold)) {
    // 同じ辺の隣接ビンを重複走査しない（後段の select と同じ間隔）。
    if (kept.some(other => Math.abs(other.rho - peak.rho) <= 2 && Math.abs(other.theta - peak.theta) <= HOUGH_THETA_STEP * 3)) continue;
    kept.push(peak);
    if (kept.length >= HOUGH_MAX_PEAKS) break;
  }
  for (const { rho, theta } of kept) walkLineSegments(edges, width, height, rho, theta, minLength, maxGap, out);
}

/**
 * 縦横 ±axisRange の直線から線分 {p, q} を返す。HoughLinesP の代替として
 * 撮影窓の探索と回退経路の候補作りが共用する。垂直線は転置した輪郭画像で
 * 水平線として探し、座標を戻す（Hough の呼び出しがチャンネルあたり 2 回で済む）。
 */
export function axisLineSegments(cv, edges, width, height, {
  axisRange = AXIS_RANGE_RAD,
  threshold,
  minLength,
  maxGap
}) {
  const segments = [];
  collectAxisSegments(cv, edges, width, height, axisRange, threshold, minLength, maxGap, segments);
  const transposed = new cv.Mat();
  try {
    cv.transpose(edges, transposed);
    const vertical = [];
    collectAxisSegments(cv, transposed, height, width, axisRange, threshold, minLength, maxGap, vertical);
    for (const { p, q } of vertical) segments.push({ p: { x: p.y, y: p.x }, q: { x: q.y, y: q.x } });
  } finally { transposed.delete(); }
  return segments;
}

// The planes the line search reads: grey (-1), then R, G and B (0-2).
export const LINE_SEARCH_CHANNELS = Object.freeze([-1, 0, 1, 2]);

function samePlane(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// One plane of the search into `gray` (grey for -1, else that RGBA channel).
function readPlane(cv, src, split, channel, gray) {
  if (channel < 0) cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  else { const plane = split.get(channel); try { plane.copyTo(gray); } finally { plane.delete(); } }
}

/**
 * The planes of `channels` (in order) that are byte-identical to an earlier
 * one: they would give the same segments, which select() drops as
 * duplicates. Byte equality is an equivalence, so "equal to an earlier
 * plane" is "equal to an earlier searched plane". Every realm that holds the
 * same preview bytes decides the same (#252: parallel channel units).
 */
export function duplicateLinePlanes(src, channels = LINE_SEARCH_CHANNELS) {
  const cv = globalThis.cv;
  const skip = new Set();
  const gray = new cv.Mat(), split = new cv.MatVector();
  const seen = [];
  try {
    if (channels.some(channel => channel >= 0)) cv.split(src, split);
    for (let index = 0; index < channels.length; index++) {
      readPlane(cv, src, split, channels[index], gray);
      const bytes = gray.data;
      if (seen.some(plane => samePlane(plane, bytes))) { skip.add(channels[index]); continue; }
      // The last plane is never compared against.
      if (index + 1 < channels.length) seen.push(bytes.slice());
    }
  } finally { gray.delete(); split.delete(); }
  return skip;
}

/**
 * One channel unit of the line search (#252 part 4): blur, Canny, the two
 * restricted Hough passes and the segment walk on one plane. Returns the
 * scored lines in walk order, `{ channel, horizontal, vertical }`; the
 * search's tail (lineQuadsFromUnits) concatenates units in channel order.
 */
export function lineChannelUnit(image, src, channel) {
  const cv = globalThis.cv;
  const gray = new cv.Mat(), smooth = new cv.Mat(), edges = new cv.Mat(), split = new cv.MatVector();
  const horizontal = [], vertical = [];
  const minDim = Math.min(image.width, image.height);
  try {
    if (channel >= 0) cv.split(src, split);
    readPlane(cv, src, split, channel, gray);
    cv.GaussianBlur(gray, smooth, new cv.Size(3, 3), 0);
    cv.Canny(smooth, edges, 10, 30);
    const segments = axisLineSegments(cv, edges, image.width, image.height, {
      threshold: Math.max(30, Math.round(minDim * .047)),
      minLength: Math.max(30, minDim * .14),
      maxGap: Math.max(5, minDim * .023)
    });
    for (const { p, q } of segments) {
      const dx = q.x - p.x, dy = q.y - p.y;
      const isHorizontal = Math.abs(dx) > Math.abs(dy);
      const m = isHorizontal ? dy / dx : dx / dy;
      if (!Number.isFinite(m) || Math.abs(m) > .27) continue;
      const evidence = lineEvidence(image, p, q);
      if (!evidence) continue;
      const b = isHorizontal ? p.y - m * p.x : p.x - m * p.y;
      const position = b + m * (isHorizontal ? image.width : image.height) / 2;
      const length = Math.hypot(dx, dy);
      (isHorizontal ? horizontal : vertical).push({ m, b, position, length, p, q, score: evidence + Math.min(length / minDim, 1) * .2 });
    }
  } finally {
    gray.delete(); smooth.delete(); edges.delete(); split.delete();
  }
  return { channel, horizontal, vertical };
}

/**
 * The search's tail over channel units given in channel order: selection
 * (a stable sort, so the order of the units is part of the result), pairs,
 * quads, the orthogonal scans between parallel pairs and the open-frame
 * check. Pure JS on the preview's 8-bit plane.
 */
export function lineQuadsFromUnits(image, units, debug = null) {
  const minDim = Math.min(image.width, image.height);
  const horizontal = [], vertical = [];
  for (const unit of units) {
    for (const line of unit.horizontal) horizontal.push(line);
    for (const line of unit.vertical) vertical.push(line);
  }
  const select = items => {
    const selected = [];
    for (const line of items.sort((a, b) => b.score - a.score)) {
      if (selected.some(other => Math.abs(other.position - line.position) < Math.max(4, minDim * .006) && Math.abs(other.m - line.m) < .02)) continue;
      selected.push(line);
      if (selected.length >= 18) break;
    }
    return selected.sort((a, b) => a.position - b.position);
  };
  const pairs = items => {
    const result = [];
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (b.position - a.position < minDim * .23 || Math.abs(Math.atan(a.m) - Math.atan(b.m)) > .04) continue;
      result.push([a, b]);
    }
    return result;
  };
  const hSel = select(horizontal), vSel = select(vertical);
  if (debug) {
    debug.horizontal = hSel; debug.vertical = vSel; debug.rawH = horizontal.length; debug.rawV = vertical.length;
    debug.channels = units.map(unit => unit.channel);
  }
  const hPairs = pairs(hSel), vPairs = pairs(vSel);
  const quads = [];
  for (const [top, bottom] of hPairs) for (const [left, right] of vPairs) {
    if (Math.abs(Math.atan(top.m) + Math.atan(left.m)) > .045) continue;
    quads.push([intersect(top, left), intersect(top, right), intersect(bottom, right), intersect(bottom, left)]);
  }
  // 穴・低コントラスト・模様の接続で線分が短くなる場合、観測済みの平行二辺
  // の間で直交辺を走査する。幅は規格から推測せず、全長の画素支持を必要とする。
  // 全ての平行二辺を走査する。上位 12 組に限ると、穴や隣接コマの縁が多い
  // 画像では画格の二辺が走査されず、片側の辺が弱い画格を取り逃がす。
  const scanPairs = (parallelPairs, horizontalPair) => {
    const limit = horizontalPair ? image.width : image.height;
    for (const [a, b] of [...parallelPairs].sort((p, q) => q[0].score + q[1].score - p[0].score - p[1].score)) {
      const m = -(a.m + b.m) / 2, found = [];
      for (let position = 4; position < limit - 4; position += Math.max(1, Math.round(minDim / 600))) {
        const line = { m, b: position - m * (a.position + b.position) / 2, position };
        const p = horizontalPair ? intersect(a, line) : intersect(line, a);
        const q = horizontalPair ? intersect(b, line) : intersect(line, b);
        const score = lineEvidence(image, p, q);
        if (score) found.push({ ...line, p, q, length: Math.hypot(p.x - q.x, p.y - q.y), score });
      }
      for (const [c, d] of pairs(select(found))) {
        const [top, bottom, left, right] = horizontalPair ? [a, b, c, d] : [c, d, a, b];
        quads.push([intersect(top, left), intersect(top, right), intersect(bottom, right), intersect(bottom, left)]);
      }
    }
  };
  scanPairs(hPairs, true);
  scanPairs(vPairs, false);
  const incomplete = vPairs.some(([a, b]) => isOpenPair(image, a, b, true))
    || hPairs.some(([a, b]) => isOpenPair(image, a, b, false));
  return { quads, incomplete };
}

/**
 * `channels` limits the planes searched (default: grey, R, G, B). A plane
 * byte-identical to one already searched is skipped: it would give the same
 * segments, which select() drops as duplicates, so the quads do not change
 * (a greyscale scan searches once instead of four times). `debug.channels`
 * lists the planes actually searched. The serial composition of the stage
 * functions the parallel detector (#252) spreads over workers.
 */
export function findWindowLineQuads(image, src, debug = null, { channels: searchChannels = LINE_SEARCH_CHANNELS } = {}) {
  const cv = globalThis.cv;
  if (!cv?.HoughLines || !cv?.split) return { quads: [], incomplete: false };
  const skip = duplicateLinePlanes(src, searchChannels);
  const units = searchChannels.filter(channel => !skip.has(channel)).map(channel => lineChannelUnit(image, src, channel));
  return lineQuadsFromUnits(image, units, debug);
}
