import { houghLineCount } from './opencvLines.js';

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

export function findWindowLineQuads(image, src) {
  const cv = globalThis.cv;
  if (!cv?.HoughLinesP || !cv?.split) return { quads: [], incomplete: false };
  const gray = new cv.Mat(), smooth = new cv.Mat(), edges = new cv.Mat(), lines = new cv.Mat();
  const channels = new cv.MatVector(), horizontal = [], vertical = [];
  const minDim = Math.min(image.width, image.height);
  try {
    cv.split(src, channels);
    for (const channel of [-1, 0, 1, 2]) {
      if (channel < 0) cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      else { const plane = channels.get(channel); try { plane.copyTo(gray); } finally { plane.delete(); } }
      cv.GaussianBlur(gray, smooth, new cv.Size(3, 3), 0);
      cv.Canny(smooth, edges, 10, 30);
      cv.HoughLinesP(edges, lines, 1, Math.PI / 1800, Math.max(30, Math.round(minDim * .047)), Math.max(30, minDim * .14), Math.max(5, minDim * .023));
      // OpenCV のバージョンによって N×1 / 1×N の両方になる。
      const data = lines.data32S;
      for (let i = 0, end = houghLineCount(lines) * 4; i < end; i += 4) {
        const p = { x: data[i], y: data[i + 1] }, q = { x: data[i + 2], y: data[i + 3] };
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
    const hPairs = pairs(select(horizontal)), vPairs = pairs(select(vertical));
    const quads = [];
    for (const [top, bottom] of hPairs) for (const [left, right] of vPairs) {
      if (Math.abs(Math.atan(top.m) + Math.atan(left.m)) > .045) continue;
      quads.push([intersect(top, left), intersect(top, right), intersect(bottom, right), intersect(bottom, left)]);
    }
    // 穴・低コントラスト・模様の接続で線分が短くなる場合、観測済みの平行二辺
    // の間で直交辺を走査する。幅は規格から推測せず、全長の画素支持を必要とする。
    const scanPairs = (parallelPairs, horizontalPair) => {
      const limit = horizontalPair ? image.width : image.height;
      for (const [a, b] of [...parallelPairs].sort((p, q) => q[0].score + q[1].score - p[0].score - p[1].score).slice(0, 12)) {
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
    gray.delete(); smooth.delete(); edges.delete(); lines.delete(); channels.delete();
  }
}
