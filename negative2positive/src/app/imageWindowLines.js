// 閉じた輪郭が得られないフィルムでも、独立した四辺を組み合わせる。
// 比率から辺を作らず、画像上で観測できる線分だけを候補にする。
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function sample(image, x, y) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2]];
}

// 長さだけでは被写体の建物・木・粒状性が上位を占める。片側に均一な片基が
// 連続している線を優先し、穴や隣接コマを横切る仮想線は支持率で落とす。
function lineEvidence(image, p, q) {
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
    const color = [0, 1, 2].map(c => median(pixels.map(p => p[c])));
    return median(pixels.map(p => Math.max(...p.map((v, c) => Math.abs(v - color[c])))));
  };
  const contrast = median(deltas), support = deltas.filter(d => d >= 10).length / deltas.length;
  const clean = Math.min(variation(a), variation(b));
  if (contrast < 12 || support < .65 || clean > 18) return 0;
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
    const v0 = Math.round(center);
    let hit = -1;
    for (let d = 0; d <= tolerance && hit < 0; d++) {
      for (const v of d ? [v0 - d, v0 + d] : [v0]) {
        if (v < 0 || v >= limit) continue;
        if (data[horizontal ? v * width + u : u * width + v]) { hit = v; break; }
      }
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

export function findWindowLineQuads(image, src, debug = null) {
  const cv = globalThis.cv;
  if (!cv?.HoughLines || !cv?.split) return { quads: [], incomplete: false };
  const gray = new cv.Mat(), smooth = new cv.Mat(), edges = new cv.Mat();
  const channels = new cv.MatVector(), horizontal = [], vertical = [];
  const minDim = Math.min(image.width, image.height);
  try {
    cv.split(src, channels);
    for (const channel of [-1, 0, 1, 2]) {
      if (channel < 0) cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      else { const plane = channels.get(channel); try { plane.copyTo(gray); } finally { plane.delete(); } }
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
    if (debug) { debug.horizontal = hSel; debug.vertical = vSel; debug.rawH = horizontal.length; debug.rawV = vertical.length; }
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
  } finally {
    gray.delete(); smooth.delete(); edges.delete(); channels.delete();
  }
}
