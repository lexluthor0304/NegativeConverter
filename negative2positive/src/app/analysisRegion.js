// 撮影窓を元画像座標で保持し、回転→ミラー→切り抜きに追従する。
function geometry(source, angle = 0) {
  const rad = angle * Math.PI / 180;
  const snap = v => Math.abs(v) < 1e-10 ? 0 : Math.abs(1 - Math.abs(v)) < 1e-10 ? Math.sign(v) : v;
  const cos = snap(Math.cos(rad)), sin = snap(Math.sin(rad));
  return { cos, sin, width: Math.ceil(source.width * Math.abs(cos) + source.height * Math.abs(sin)), height: Math.ceil(source.width * Math.abs(sin) + source.height * Math.abs(cos)) };
}

export function validImageArea(points) {
  return Array.isArray(points) && points.length === 4 && points.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
}

export function imageAreaFromWorkingRect(rect, settings, source) {
  const g = geometry(source, settings.rotationAngle || 0);
  return [[rect.left, rect.top], [rect.left + rect.width, rect.top], [rect.left + rect.width, rect.top + rect.height], [rect.left, rect.top + rect.height]].map(([x, y]) => {
    if (settings.mirrored) x = g.width - x;
    x -= g.width / 2; y -= g.height / 2;
    return { x: (x * g.cos + y * g.sin + source.width / 2) / source.width, y: (-x * g.sin + y * g.cos + source.height / 2) / source.height };
  });
}

// 出力の裁切・拡大率から独立した、同一の 16-bit 解析標本を生成する。
export function sampleAnalysisArea(source, points, maxPixels = 250000) {
  if (!source?.data || !validImageArea(points)) return null;
  const p = points.map(v => ({ x: v.x * source.width, y: v.y * source.height }));
  const w = Math.hypot(p[1].x - p[0].x, p[1].y - p[0].y), h = Math.hypot(p[3].x - p[0].x, p[3].y - p[0].y);
  if (!Number.isFinite(w * h) || w < 2 || h < 2) return null;
  const scale = Math.min(1, Math.sqrt(maxPixels / (w * h)));
  const width = Math.max(1, Math.floor(w * scale)), height = Math.max(1, Math.floor(h * scale));
  const data = new Uint16Array(width * height * 4);
  const plane = source.__image16;
  const sixteen = plane?.data instanceof Uint16Array && plane.width === source.width && plane.height === source.height;
  const input = sixteen ? plane.data : source.data;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = (x + .5) / width, v = (y + .5) / height;
    const sx = Math.floor(p[0].x + (p[1].x - p[0].x) * u + (p[3].x - p[0].x) * v);
    const sy = Math.floor(p[0].y + (p[1].y - p[0].y) * u + (p[3].y - p[0].y) * v);
    if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;
    const src = (sy * source.width + sx) * 4, dst = (y * width + x) * 4;
    for (let c = 0; c < 4; c++) data[dst + c] = input[src + c] * (sixteen ? 1 : 257);
  }
  return { width, height, data };
}

export function imageAreaFromDetection(result, source) {
  if (!result?.cropRegion) return null;
  const { cos, sin, width: w, height: h } = geometry(source, result.angle);
  const { left, top, width, height } = result.cropRegion;
  return [[left, top], [left + width, top], [left + width, top + height], [left, top + height]].map(([x, y]) => ({
    x: ((x - w / 2) * cos + (y - h / 2) * sin + source.width / 2) / source.width,
    y: (-(x - w / 2) * sin + (y - h / 2) * cos + source.height / 2) / source.height
  }));
}

export function resolveAnalysisRegion(settings, source) {
  const points = settings.autoFrameMeta?.imageArea;
  if (!validImageArea(points) || !source?.width || !source?.height) return null;
  const { cos, sin, width: rw, height: rh } = geometry(source, settings.rotationAngle || 0);
  const crop = settings.cropRegion || { left: 0, top: 0, width: rw, height: rh };
  const transformed = points.map(p => {
    const x = p.x * source.width - source.width / 2, y = p.y * source.height - source.height / 2;
    const rx = x * cos - y * sin + rw / 2;
    return { x: (settings.mirrored ? rw - rx : rx) - crop.left, y: x * sin + y * cos + rh / 2 - crop.top };
  });
  const xs = transformed.map(p => p.x).sort((a, b) => a - b), ys = transformed.map(p => p.y).sort((a, b) => a - b);
  const left = Math.max(0, xs[1]), top = Math.max(0, ys[1]);
  const right = Math.min(crop.width, xs[2]), bottom = Math.min(crop.height, ys[2]);
  if (right - left < 2 || bottom - top < 2) return null;
  return { left: left / crop.width, top: top / crop.height, width: (right - left) / crop.width, height: (bottom - top) / crop.height };
}

export function analysisPixelBounds(width, height, region, borderPct = 0) {
  const valid = region && ['left', 'top', 'width', 'height'].every(k => Number.isFinite(region[k])) && region.width > 0 && region.height > 0;
  const roi = valid ? region : { left: 0, top: 0, width: 1, height: 1 };
  const inset = Math.max(0, Math.min(0.3, borderPct));
  if (!valid) {
    // 領域指定のない既存写真の丸め規則は変えない。
    const left = Math.min(width - 1, Math.round(width * inset)), top = Math.min(height - 1, Math.round(height * inset));
    return { left, top, width: Math.max(1, width - 2 * left), height: Math.max(1, height - 2 * top) };
  }
  const x = Math.max(0, Math.min(width - 1, Math.ceil((roi.left + roi.width * inset) * width)));
  const y = Math.max(0, Math.min(height - 1, Math.ceil((roi.top + roi.height * inset) * height)));
  const right = Math.min(width, Math.max(x + 1, Math.floor((roi.left + roi.width * (1 - inset)) * width)));
  const bottom = Math.min(height, Math.max(y + 1, Math.floor((roi.top + roi.height * (1 - inset)) * height)));
  return { left: x, top: y, width: right - x, height: bottom - y };
}
