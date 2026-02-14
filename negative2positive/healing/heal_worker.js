const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = (c <= 0.04045) ? (c / 12.92) : Math.pow((c + 0.055) / 1.055, 2.4);
}

const LINEAR_TO_SRGB = new Uint8Array(4096);
for (let i = 0; i < LINEAR_TO_SRGB.length; i++) {
  const c = i / (LINEAR_TO_SRGB.length - 1);
  const s = (c <= 0.0031308) ? (12.92 * c) : (1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  LINEAR_TO_SRGB[i] = clampU8(Math.round(s * 255));
}

function clampU8(v) {
  return v < 0 ? 0 : (v > 255 ? 255 : v);
}

function clampInt(v, min, max) {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(t) {
  return t <= 0 ? 0 : (t >= 1 ? 1 : (t * t * (3 - 2 * t)));
}

function approxLumaU8(r, g, b) {
  return (77 * r + 150 * g + 29 * b) >>> 8;
}

function computeDabAlpha(dist2, radius, feather) {
  if (radius <= 0) return 0;
  const r1 = radius;
  const r0 = Math.max(0, radius * (1 - feather));
  const r02 = r0 * r0;
  const r12 = r1 * r1;
  if (dist2 >= r12) return 0;
  if (dist2 <= r02 || r1 === r0) return 255;
  const t = (Math.sqrt(dist2) - r0) / (r1 - r0);
  const w = 1 - smoothstep(t);
  return clampU8(Math.round(w * 255));
}

function calcPatchSSD(luma, w, x1, y1, x2, y2, patchR) {
  let sum = 0;
  for (let dy = -patchR; dy <= patchR; dy++) {
    const row1 = (y1 + dy) * w;
    const row2 = (y2 + dy) * w;
    for (let dx = -patchR; dx <= patchR; dx++) {
      const d = luma[row1 + (x1 + dx)] - luma[row2 + (x2 + dx)];
      sum += d * d;
    }
  }
  return sum;
}

function poissonBlend(dstRgba, srcRgba, maskBinary, w, h, iters) {
  const n = w * h;
  const dstR = new Float32Array(n);
  const dstG = new Float32Array(n);
  const dstB = new Float32Array(n);
  const srcR = new Float32Array(n);
  const srcG = new Float32Array(n);
  const srcB = new Float32Array(n);

  for (let i = 0, p = 0; p < n; p++, i += 4) {
    dstR[p] = SRGB_TO_LINEAR[dstRgba[i]];
    dstG[p] = SRGB_TO_LINEAR[dstRgba[i + 1]];
    dstB[p] = SRGB_TO_LINEAR[dstRgba[i + 2]];
    srcR[p] = SRGB_TO_LINEAR[srcRgba[i]];
    srcG[p] = SRGB_TO_LINEAR[srcRgba[i + 1]];
    srcB[p] = SRGB_TO_LINEAR[srcRgba[i + 2]];
  }

  const solveIdxs = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = y * w + x;
      if (maskBinary[idx]) solveIdxs.push(idx);
    }
  }
  if (!solveIdxs.length) {
    const out = new Uint8Array(dstRgba.length);
    out.set(dstRgba);
    return out;
  }

  let curR = new Float32Array(dstR);
  let curG = new Float32Array(dstG);
  let curB = new Float32Array(dstB);
  let nextR = new Float32Array(n);
  let nextG = new Float32Array(n);
  let nextB = new Float32Array(n);

  const wStride = w;
  for (let iter = 0; iter < iters; iter++) {
    for (let k = 0; k < solveIdxs.length; k++) {
      const idx = solveIdxs[k];
      const left = idx - 1;
      const right = idx + 1;
      const up = idx - wStride;
      const down = idx + wStride;

      const sumNR = (maskBinary[left] ? curR[left] : dstR[left])
        + (maskBinary[right] ? curR[right] : dstR[right])
        + (maskBinary[up] ? curR[up] : dstR[up])
        + (maskBinary[down] ? curR[down] : dstR[down]);
      const sumNG = (maskBinary[left] ? curG[left] : dstG[left])
        + (maskBinary[right] ? curG[right] : dstG[right])
        + (maskBinary[up] ? curG[up] : dstG[up])
        + (maskBinary[down] ? curG[down] : dstG[down]);
      const sumNB = (maskBinary[left] ? curB[left] : dstB[left])
        + (maskBinary[right] ? curB[right] : dstB[right])
        + (maskBinary[up] ? curB[up] : dstB[up])
        + (maskBinary[down] ? curB[down] : dstB[down]);

      const bR = (srcR[idx] - srcR[left]) + (srcR[idx] - srcR[right]) + (srcR[idx] - srcR[up]) + (srcR[idx] - srcR[down]);
      const bG = (srcG[idx] - srcG[left]) + (srcG[idx] - srcG[right]) + (srcG[idx] - srcG[up]) + (srcG[idx] - srcG[down]);
      const bB = (srcB[idx] - srcB[left]) + (srcB[idx] - srcB[right]) + (srcB[idx] - srcB[up]) + (srcB[idx] - srcB[down]);

      let r = (sumNR + bR) * 0.25;
      let g = (sumNG + bG) * 0.25;
      let b = (sumNB + bB) * 0.25;

      if (r < 0) r = 0; else if (r > 1) r = 1;
      if (g < 0) g = 0; else if (g > 1) g = 1;
      if (b < 0) b = 0; else if (b > 1) b = 1;

      nextR[idx] = r;
      nextG[idx] = g;
      nextB[idx] = b;
    }

    // Keep non-mask pixels pinned to destination.
    for (let k = 0; k < solveIdxs.length; k++) {
      const idx = solveIdxs[k];
      curR[idx] = nextR[idx];
      curG[idx] = nextG[idx];
      curB[idx] = nextB[idx];
    }
  }

  const out = new Uint8Array(dstRgba.length);
  out.set(dstRgba);
  for (let i = 0, p = 0; p < n; p++, i += 4) {
    if (!maskBinary[p]) continue;
    const ri = clampInt((curR[p] * (LINEAR_TO_SRGB.length - 1) + 0.5) | 0, 0, LINEAR_TO_SRGB.length - 1);
    const gi = clampInt((curG[p] * (LINEAR_TO_SRGB.length - 1) + 0.5) | 0, 0, LINEAR_TO_SRGB.length - 1);
    const bi = clampInt((curB[p] * (LINEAR_TO_SRGB.length - 1) + 0.5) | 0, 0, LINEAR_TO_SRGB.length - 1);
    out[i] = LINEAR_TO_SRGB[ri];
    out[i + 1] = LINEAR_TO_SRGB[gi];
    out[i + 2] = LINEAR_TO_SRGB[bi];
    out[i + 3] = 255;
  }

  return out;
}

function applyHealingDabInPlace(imageRgba, imgW, imgH, dab, params) {
  const cx = dab.cx | 0;
  const cy = dab.cy | 0;
  const radius = Math.max(1, params.brushRadius | 0);
  const feather = Math.max(0, Math.min(1, +params.feather || 0));
  const flow = Math.max(0, Math.min(1, +params.flow || 1));
  const gap = Math.max(0, params.gap | 0);
  const sampleRadius = Math.max(8, params.sampleRadius | 0);
  const patchSize = Math.max(3, params.patchSize | 0) | 1;
  const patchR = patchSize >> 1;
  const iters = Math.max(1, params.patchmatchIters | 0);
  const poissonIters = Math.max(0, params.poissonIters | 0);

  const roiHalf = radius + sampleRadius + patchR + 8;
  const x0 = clampInt(cx - roiHalf, 0, imgW - 1);
  const y0 = clampInt(cy - roiHalf, 0, imgH - 1);
  const x1 = clampInt(cx + roiHalf, 0, imgW - 1);
  const y1 = clampInt(cy + roiHalf, 0, imgH - 1);
  const w = (x1 - x0 + 1) | 0;
  const h = (y1 - y0 + 1) | 0;
  if (w <= patchSize + 2 || h <= patchSize + 2) return null;

  const n = w * h;
  const dstRoi = new Uint8Array(n * 4);
  const luma = new Uint8Array(n);
  for (let ry = 0; ry < h; ry++) {
    const gy = y0 + ry;
    const srcRow = (gy * imgW + x0) * 4;
    const dstRow = ry * w * 4;
    dstRoi.set(imageRgba.subarray(srcRow, srcRow + w * 4), dstRow);
    for (let rx = 0; rx < w; rx++) {
      const di = dstRow + rx * 4;
      luma[ry * w + rx] = approxLumaU8(dstRoi[di], dstRoi[di + 1], dstRoi[di + 2]);
    }
  }

  const maskAlpha = new Uint8Array(n);
  const maskBinary = new Uint8Array(n);
  const localCx = cx - x0;
  const localCy = cy - y0;
  const r2 = radius * radius;
  for (let ry = 0; ry < h; ry++) {
    const dy = ry - localCy;
    for (let rx = 0; rx < w; rx++) {
      const dx = rx - localCx;
      const dist2 = dx * dx + dy * dy;
      const a = computeDabAlpha(dist2, radius, feather);
      const idx = ry * w + rx;
      maskAlpha[idx] = a;
      if (a) maskBinary[idx] = 1;
    }
  }

  const ringInner2 = (radius + gap) * (radius + gap);
  const ringOuter2 = (radius + sampleRadius) * (radius + sampleRadius);
  const safeInner2 = (radius + patchR + 1) * (radius + patchR + 1);

  const candOk = new Uint8Array(n);
  const candIdxs = [];
  for (let ry = patchR; ry < h - patchR; ry++) {
    const dy = ry - localCy;
    for (let rx = patchR; rx < w - patchR; rx++) {
      const dx = rx - localCx;
      const dist2 = dx * dx + dy * dy;
      const idx = ry * w + rx;
      if (maskBinary[idx]) continue;
      if (dist2 < ringInner2 || dist2 > ringOuter2) continue;
      if (dist2 < safeInner2) continue;
      candOk[idx] = 1;
      candIdxs.push(idx);
    }
  }

  const dxField = new Int16Array(n);
  const dyField = new Int16Array(n);
  const costField = new Float32Array(n);
  costField.fill(Infinity);

  if (!candIdxs.length) {
    return { x0, y0, w, h, roiRgba: dstRoi };
  }

  for (let ry = patchR; ry < h - patchR; ry++) {
    for (let rx = patchR; rx < w - patchR; rx++) {
      const idx = ry * w + rx;
      if (!maskBinary[idx]) continue;
      // Initialize with random candidate.
      let bestDx = 0;
      let bestDy = 0;
      let bestCost = Infinity;
      for (let t = 0; t < 12; t++) {
        const cIdx = candIdxs[(Math.random() * candIdxs.length) | 0];
        const cx2 = cIdx % w;
        const cy2 = (cIdx / w) | 0;
        const candDx = cx2 - rx;
        const candDy = cy2 - ry;
        const c = calcPatchSSD(luma, w, rx, ry, cx2, cy2, patchR);
        if (c < bestCost) {
          bestCost = c;
          bestDx = candDx;
          bestDy = candDy;
        }
      }
      dxField[idx] = bestDx;
      dyField[idx] = bestDy;
      costField[idx] = bestCost;
    }
  }

  const randTries = 2;
  for (let iter = 0; iter < iters; iter++) {
    // Forward pass.
    for (let ry = patchR; ry < h - patchR; ry++) {
      for (let rx = patchR; rx < w - patchR; rx++) {
        const idx = ry * w + rx;
        if (!maskBinary[idx]) continue;

        let bestCost = costField[idx];
        let bestDx = dxField[idx];
        let bestDy = dyField[idx];

        const left = idx - 1;
        const up = idx - w;

        if (rx > patchR && maskBinary[left]) {
          const candDx = dxField[left];
          const candDy = dyField[left];
          const sx = rx + candDx;
          const sy = ry + candDy;
          const sIdx = sy * w + sx;
          if (candOk[sIdx]) {
            const c = calcPatchSSD(luma, w, rx, ry, sx, sy, patchR);
            if (c < bestCost) {
              bestCost = c;
              bestDx = candDx;
              bestDy = candDy;
            }
          }
        }

        if (ry > patchR && maskBinary[up]) {
          const candDx = dxField[up];
          const candDy = dyField[up];
          const sx = rx + candDx;
          const sy = ry + candDy;
          const sIdx = sy * w + sx;
          if (candOk[sIdx]) {
            const c = calcPatchSSD(luma, w, rx, ry, sx, sy, patchR);
            if (c < bestCost) {
              bestCost = c;
              bestDx = candDx;
              bestDy = candDy;
            }
          }
        }

        for (let t = 0; t < randTries; t++) {
          const cIdx = candIdxs[(Math.random() * candIdxs.length) | 0];
          const sx = cIdx % w;
          const sy = (cIdx / w) | 0;
          const c = calcPatchSSD(luma, w, rx, ry, sx, sy, patchR);
          if (c < bestCost) {
            bestCost = c;
            bestDx = sx - rx;
            bestDy = sy - ry;
          }
        }

        dxField[idx] = bestDx;
        dyField[idx] = bestDy;
        costField[idx] = bestCost;
      }
    }

    // Backward pass.
    for (let ry = h - patchR - 1; ry >= patchR; ry--) {
      for (let rx = w - patchR - 1; rx >= patchR; rx--) {
        const idx = ry * w + rx;
        if (!maskBinary[idx]) continue;

        let bestCost = costField[idx];
        let bestDx = dxField[idx];
        let bestDy = dyField[idx];

        const right = idx + 1;
        const down = idx + w;

        if (rx < w - patchR - 1 && maskBinary[right]) {
          const candDx = dxField[right];
          const candDy = dyField[right];
          const sx = rx + candDx;
          const sy = ry + candDy;
          const sIdx = sy * w + sx;
          if (candOk[sIdx]) {
            const c = calcPatchSSD(luma, w, rx, ry, sx, sy, patchR);
            if (c < bestCost) {
              bestCost = c;
              bestDx = candDx;
              bestDy = candDy;
            }
          }
        }

        if (ry < h - patchR - 1 && maskBinary[down]) {
          const candDx = dxField[down];
          const candDy = dyField[down];
          const sx = rx + candDx;
          const sy = ry + candDy;
          const sIdx = sy * w + sx;
          if (candOk[sIdx]) {
            const c = calcPatchSSD(luma, w, rx, ry, sx, sy, patchR);
            if (c < bestCost) {
              bestCost = c;
              bestDx = candDx;
              bestDy = candDy;
            }
          }
        }

        for (let t = 0; t < randTries; t++) {
          const cIdx = candIdxs[(Math.random() * candIdxs.length) | 0];
          const sx = cIdx % w;
          const sy = (cIdx / w) | 0;
          const c = calcPatchSSD(luma, w, rx, ry, sx, sy, patchR);
          if (c < bestCost) {
            bestCost = c;
            bestDx = sx - rx;
            bestDy = sy - ry;
          }
        }

        dxField[idx] = bestDx;
        dyField[idx] = bestDy;
        costField[idx] = bestCost;
      }
    }
  }

  const srcRoi = new Uint8Array(dstRoi.length);
  srcRoi.set(dstRoi);
  for (let ry = patchR; ry < h - patchR; ry++) {
    for (let rx = patchR; rx < w - patchR; rx++) {
      const idx = ry * w + rx;
      if (!maskBinary[idx]) continue;
      const sx = rx + dxField[idx];
      const sy = ry + dyField[idx];
      if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
      const si = (sy * w + sx) * 4;
      const di = idx * 4;
      srcRoi[di] = dstRoi[si];
      srcRoi[di + 1] = dstRoi[si + 1];
      srcRoi[di + 2] = dstRoi[si + 2];
      srcRoi[di + 3] = 255;
    }
  }

  let blended = srcRoi;
  if (poissonIters > 0) {
    blended = poissonBlend(dstRoi, srcRoi, maskBinary, w, h, poissonIters);
  }

  const outRoi = new Uint8Array(dstRoi.length);
  outRoi.set(dstRoi);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const a = maskAlpha[p];
    if (!a) continue;
    const t = (a / 255) * flow;
    outRoi[i] = clampU8(Math.round(lerp(dstRoi[i], blended[i], t)));
    outRoi[i + 1] = clampU8(Math.round(lerp(dstRoi[i + 1], blended[i + 1], t)));
    outRoi[i + 2] = clampU8(Math.round(lerp(dstRoi[i + 2], blended[i + 2], t)));
    outRoi[i + 3] = 255;
  }

  // Commit ROI back to the input image (in-place).
  for (let ry = 0; ry < h; ry++) {
    const gy = y0 + ry;
    const dstRow = (gy * imgW + x0) * 4;
    const srcRow = ry * w * 4;
    imageRgba.set(outRoi.subarray(srcRow, srcRow + w * 4), dstRow);
  }

  return { x0, y0, w, h, roiRgba: outRoi };
}

let previewImage = null; // {width,height,rgba:Uint8Array}

function ok(id, result, transfer = []) {
  self.postMessage({ id, ok: true, result }, transfer);
}

function fail(id, error) {
  self.postMessage({ id, ok: false, error: String(error?.message || error || 'Unknown error') });
}

self.onmessage = (event) => {
  const { id, cmd, payload } = event.data || {};
  try {
    if (cmd === 'init') {
      ok(id, { ok: true });
      return;
    }

    if (cmd === 'setPreviewImage') {
      const width = payload.width | 0;
      const height = payload.height | 0;
      const rgba = payload.rgba;
      if (!(rgba instanceof Uint8Array)) throw new Error('Invalid preview rgba');
      previewImage = { width, height, rgba };
      ok(id, { ok: true });
      return;
    }

    if (cmd === 'applyPreviewDab') {
      if (!previewImage) throw new Error('Preview image not set');
      const dab = payload.dab || {};
      const params = payload.params || {};
      const res = applyHealingDabInPlace(previewImage.rgba, previewImage.width, previewImage.height, dab, params);
      if (!res) {
        ok(id, null);
        return;
      }
      ok(id, { bbox: { x: res.x0, y: res.y0, w: res.w, h: res.h }, rgba: res.roiRgba }, [res.roiRgba.buffer]);
      return;
    }

    if (cmd === 'applyStrokeOnRoi') {
      const roiW = payload.roiW | 0;
      const roiH = payload.roiH | 0;
      const rgba = payload.rgba;
      const dabs = Array.isArray(payload.dabs) ? payload.dabs : [];
      const params = payload.params || {};
      if (!(rgba instanceof Uint8Array)) throw new Error('Invalid roi rgba');
      if (roiW <= 0 || roiH <= 0) throw new Error('Invalid roi size');
      // Sequentially apply dabs onto the ROI image buffer.
      for (let i = 0; i < dabs.length; i++) {
        const dab = dabs[i];
        if (!dab) continue;
        applyHealingDabInPlace(rgba, roiW, roiH, dab, params);
      }
      ok(id, { rgba, roiW, roiH }, [rgba.buffer]);
      return;
    }

    throw new Error(`Unknown cmd: ${cmd}`);
  } catch (err) {
    fail(id, err);
  }
};

