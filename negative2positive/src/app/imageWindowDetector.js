import { findWindowLineQuads } from './imageWindowLines.js';

// OpenCV の四辺形から実際の撮影窓を求める。画幅比率のテンプレートで切り抜かない。
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const axisAngle = angle => {
  while (angle > 45) angle -= 90;
  while (angle <= -45) angle += 90;
  return angle;
};

function windowTilt(points) {
  const edges = points.map((p, i) => {
    const q = points[(i + 1) % 4], dx = q.x - p.x, dy = q.y - p.y;
    return { angle: axisAngle(Math.atan2(dy, dx) * 180 / Math.PI), weight: dx * dx + dy * dy };
  });
  // 短辺の一画素の丸め誤差でパノラマの傾きがずれないよう、長辺を重視する。
  return edges.reduce((sum, edge) => sum + edge.angle * edge.weight, 0) / edges.reduce((sum, edge) => sum + edge.weight, 0);
}

export function boundaryEvidence(image, points, targeted = false, { consistentBase = false, gapRatio = .008, darkHolder = false } = {}) {
  const center = points.reduce((c, p) => ({ x: c.x + p.x / 4, y: c.y + p.y / 4 }), { x: 0, y: 0 });
  const outside = [], contrasts = [], supports = [], outerEdges = [], polarities = [];
  const sample = (x, y) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
    const offset = (y * image.width + x) * 4;
    return [image.data[offset], image.data[offset + 1], image.data[offset + 2]];
  };
  for (let i = 0; i < 4; i++) {
    const p = points[i], q = points[(i + 1) % 4];
    const length = Math.hypot(q.x - p.x, q.y - p.y);
    let nx = -(q.y - p.y) / length, ny = (q.x - p.x) / length;
    if (nx * (center.x - p.x) + ny * (center.y - p.y) < 0) { nx = -nx; ny = -ny; }
    const gap = Math.max(3, Math.min(image.width, image.height) * gapRatio);
    const deltas = [], edgeOutside = [], signed = [];
    for (let j = 1; j <= 19; j++) {
      const t = j / 20, x = p.x + (q.x - p.x) * t, y = p.y + (q.y - p.y) * t;
      const inside = sample(x + nx * gap, y + ny * gap);
      const out = sample(x - nx * gap, y - ny * gap);
      if (!inside || !out) return null;
      outside.push(out);
      edgeOutside.push(out);
      signed.push(inside.reduce((sum, v, c) => sum + v - out[c], 0));
      deltas.push(Math.max(...inside.map((v, c) => Math.abs(v - out[c]))));
    }
    contrasts.push(median(deltas));
    supports.push(deltas.filter(v => v >= (targeted ? 10 : 22)).length / deltas.length);
    outerEdges.push([0, 1, 2].map(c => median(edgeOutside.map(p => p[c]))));
    polarities.push(Math.sign(median(signed)));
  }
  const outerMedian = [0, 1, 2].map(c => median(outside.map(p => p[c])));
  const variation = median(outside.map(p => Math.max(...p.map((v, c) => Math.abs(v - outerMedian[c])))));
  const contrast = Math.min(...contrasts), support = Math.min(...supports);
  // 全周の中央値だけでは、一本だけ隣接コマやライトボックスに接する誤枠を
  // 見逃す。独立線の組み合わせは四辺とも同じ片基・同じ濃度方向を要求する。
  if (consistentBase && (new Set(polarities).size !== 1
    || outerEdges.some(edge => edge.some((v, c) => Math.abs(v - outerMedian[c]) > 24)))) return null;
  if (darkHolder && (polarities.some(sign => sign !== 1) || outerEdges.some(edge => Math.max(...edge) > 24))) return null;
  if (contrast < (targeted ? 12 : 25) || support < (targeted ? .6 : .74) || variation > 32) return null;
  if (consistentBase) {
    // 一つの枠が隣接二コマを包含する場合、内部に片基と同色の帯が通る。
    // 単発の明るい画素ではなく、二本連続する全長の帯だけを除外する。
    for (const vertical of [true, false]) {
      let consecutive = 0;
      for (let lane = 4; lane <= 46; lane++) {
        let matches = 0;
        for (let j = 1; j <= 19; j++) {
          const u = vertical ? lane / 50 : j / 20, v = vertical ? j / 20 : lane / 50;
          const top = { x: points[0].x * (1 - u) + points[1].x * u, y: points[0].y * (1 - u) + points[1].y * u };
          const bottom = { x: points[3].x * (1 - u) + points[2].x * u, y: points[3].y * (1 - u) + points[2].y * u };
          const pixel = sample(top.x * (1 - v) + bottom.x * v, top.y * (1 - v) + bottom.y * v);
          if (pixel && pixel.every((value, c) => Math.abs(value - outerMedian[c]) <= 12)) matches++;
        }
        consecutive = matches >= 18 ? consecutive + 1 : 0;
        if (consecutive >= 2) return null;
      }
    }
  }
  return { contrast, support, variation };
}

export function detectImageWindow(image, targets, { targeted = false } = {}) {
  const cv = globalThis.cv;
  if (!cv?.Mat) return null;
  const src = cv.matFromImageData(image), gray = new cv.Mat(), smooth = new cv.Mat();
  const mask = new cv.Mat(), contours = new cv.MatVector(), hierarchy = new cv.Mat();
  const candidates = [];
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, smooth, new cv.Size(3, 3), 0);
    // 明るいフィルムベース、暗いホルダーの双方を探索する。
    for (const variant of ['normal', 'inverse', 'edges']) {
      if (variant === 'edges') {
        cv.Canny(smooth, mask, 20, 60);
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
        try { cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel); } finally { kernel.delete(); }
      } else cv.threshold(smooth, mask, 0, 255, (variant === 'inverse' ? cv.THRESH_BINARY_INV : cv.THRESH_BINARY) | cv.THRESH_OTSU);
      cv.findContours(mask, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const contour = contours.get(i), approx = new cv.Mat();
        try {
          const area = Math.abs(cv.contourArea(contour));
          const coverage = area / (image.width * image.height);
          if (coverage < 0.12 || coverage > 0.96) continue;
          cv.approxPolyDP(contour, approx, cv.arcLength(contour, true) * 0.012, true);
          if (approx.rows !== 4 || !cv.isContourConvex(approx)) continue;
          const points = Array.from({ length: 4 }, (_, j) => ({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] }));
          if (points.some(p => p.x < 3 || p.y < 3 || p.x > image.width - 4 || p.y > image.height - 4)) continue;
          const rect = cv.minAreaRect(contour);
          const rectangularity = area / Math.max(1, rect.size.width * rect.size.height);
          if (rectangularity < 0.94) continue;
          const ratio = Math.max(rect.size.width, rect.size.height) / Math.min(rect.size.width, rect.size.height);
          const matches = targets.map(target => ({ ...target, delta: Math.abs(ratio / target.ratio - 1) })).sort((a, b) => a.delta - b.delta);
          if (!matches.length || matches[0].delta > 0.09) continue;
          const angles = points.map((p, j) => {
            const q = points[(j + 1) % 4];
            return axisAngle(Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI);
          });
          const tilt = windowTilt(points);
          if (angles.some(angle => Math.abs(angle - tilt) > 2.5)) continue;
          const evidence = boundaryEvidence(image, points, targeted);
          if (!evidence) continue;
          candidates.push({
            points, angle: Math.abs(tilt) < 0.12 ? 0 : -tilt,
            detectedFormat: matches[0].key,
            confidence: Math.min(0.96, 0.80 + evidence.support * 0.08 + rectangularity * 0.06 - matches[0].delta),
            score: coverage * 0.45 + evidence.support * 0.25 + rectangularity * 0.20 + (1 - matches[0].delta) * 0.10,
            evidence
          });
        } finally { contour.delete(); approx.delete(); }
      }
    }
    const lineResult = candidates.length ? { quads: [], incomplete: false } : findWindowLineQuads(image, src);
    for (const points of lineResult.quads) {
      if (points.some(p => p.x < 3 || p.y < 3 || p.x > image.width - 4 || p.y > image.height - 4)) continue;
      const lengths = points.map((p, i) => Math.hypot(p.x - points[(i + 1) % 4].x, p.y - points[(i + 1) % 4].y));
      const width = (lengths[0] + lengths[2]) / 2, height = (lengths[1] + lengths[3]) / 2;
      const coverage = width * height / (image.width * image.height);
      if (coverage < .12 || coverage > .96) continue;
      const ratio = Math.max(width, height) / Math.min(width, height);
      const match = targets.map(target => ({ ...target, delta: Math.abs(ratio / target.ratio - 1) })).sort((a, b) => a.delta - b.delta)[0];
      if (!match || match.delta > .09) continue;
      const evidence = boundaryEvidence(image, points, targeted, { consistentBase: true })
        // 黒いホルダーの薄い反射縁は数画素外で再確認する。四辺の外側が
        // 本当に黒く均一な場合だけ許可し、橙色片基の条件は緩めない。
        || boundaryEvidence(image, points, targeted, { consistentBase: true, gapRatio: .012, darkHolder: true });
      if (!evidence) continue;
      const angles = points.map((p, i) => {
        const q = points[(i + 1) % 4];
        return axisAngle(Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI);
      });
      const tilt = windowTilt(points);
      if (angles.some(angle => Math.abs(angle - tilt) > 2.5)) continue;
      candidates.push({ points, angle: Math.abs(tilt) < .12 ? 0 : -tilt, detectedFormat: match.key,
        confidence: Math.min(.94, .84 + evidence.support * .08 - match.delta),
        score: coverage * .45 + evidence.support * .25 + .20 + (1 - match.delta) * .10,
        evidence, method: 'opencv-line-window' });
    }
    candidates.sort((a, b) => b.score - a.score);
    // 離れた二つの有力な窓がある画像は、単一コマと断定しない。
    if (candidates[1]) {
      const center = candidate => candidate.points.reduce((c, p) => ({ x: c.x + p.x / 4, y: c.y + p.y / 4 }), { x: 0, y: 0 });
      const a = center(candidates[0]);
      // 二値化の表裏や線分経路が同じ窓を重複提案しても、他の窓を隠さない。
      const ambiguous = candidates.slice(1).some(candidate => {
        const b = center(candidate);
        return candidates[0].score - candidate.score < .025
          && Math.hypot(a.x - b.x, a.y - b.y) > Math.min(image.width, image.height) * .15;
      });
      if (ambiguous) return targeted ? null : { requiresReview: true, ambiguous: true };
    }
    return candidates[0] || (!targeted && lineResult.incomplete ? { incomplete: true } : null);
  } finally {
    src.delete(); gray.delete(); smooth.delete(); mask.delete(); contours.delete(); hierarchy.delete();
  }
}

export function projectWindowCrop(window, preview, source, rotated) {
  const rad = window.angle * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const points = window.points.map(p => {
    const x = p.x * source.width / preview.width - source.width / 2;
    const y = p.y * source.height / preview.height - source.height / 2;
    return { x: x * cos - y * sin + rotated.width / 2, y: x * sin + y * cos + rotated.height / 2 };
  });
  const xs = points.map(p => p.x).sort((a, b) => a - b);
  const ys = points.map(p => p.y).sort((a, b) => a - b);
  // 傾き補正後の四辺の内側を採用し、ホルダーの細い縁を残さない。
  const inset = Math.max(1, source.width / preview.width);
  const left = Math.max(0, Math.ceil(xs[1] + inset));
  const top = Math.max(0, Math.ceil(ys[1] + inset));
  const right = Math.min(rotated.width, Math.floor(xs[2] - inset));
  const bottom = Math.min(rotated.height, Math.floor(ys[2] - inset));
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
}
