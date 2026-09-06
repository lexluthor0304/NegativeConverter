// OpenCV の四辺形から実際の撮影窓を求める。画幅比率のテンプレートで切り抜かない。
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const axisAngle = angle => {
  while (angle > 45) angle -= 90;
  while (angle <= -45) angle += 90;
  return angle;
};

export function boundaryEvidence(image, points, targeted = false) {
  const center = points.reduce((c, p) => ({ x: c.x + p.x / 4, y: c.y + p.y / 4 }), { x: 0, y: 0 });
  const outside = [], contrasts = [], supports = [];
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
    const gap = Math.max(3, Math.min(image.width, image.height) * 0.008);
    const deltas = [];
    for (let j = 1; j <= 19; j++) {
      const t = j / 20, x = p.x + (q.x - p.x) * t, y = p.y + (q.y - p.y) * t;
      const inside = sample(x + nx * gap, y + ny * gap);
      const out = sample(x - nx * gap, y - ny * gap);
      if (!inside || !out) return null;
      outside.push(out);
      deltas.push(Math.max(...inside.map((v, c) => Math.abs(v - out[c]))));
    }
    contrasts.push(median(deltas));
    supports.push(deltas.filter(v => v >= (targeted ? 10 : 22)).length / deltas.length);
  }
  const outerMedian = [0, 1, 2].map(c => median(outside.map(p => p[c])));
  const variation = median(outside.map(p => Math.max(...p.map((v, c) => Math.abs(v - outerMedian[c])))));
  const contrast = Math.min(...contrasts), support = Math.min(...supports);
  if (contrast < (targeted ? 12 : 25) || support < (targeted ? .6 : .74) || variation > 32) return null;
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
    for (const variant of targeted ? ['normal', 'inverse', 'edges'] : ['normal', 'inverse']) {
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
          const tilt = median(angles);
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
    candidates.sort((a, b) => b.score - a.score);
    // 離れた二つの有力な窓がある画像は、単一コマと断定しない。
    if (candidates[1] && Math.abs(candidates[0].score - candidates[1].score) < 0.025) {
      const center = candidate => candidate.points.reduce((c, p) => ({ x: c.x + p.x / 4, y: c.y + p.y / 4 }), { x: 0, y: 0 });
      const a = center(candidates[0]), b = center(candidates[1]);
      if (Math.hypot(a.x - b.x, a.y - b.y) > Math.min(image.width, image.height) * 0.15) return null;
    }
    return candidates[0] || null;
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
