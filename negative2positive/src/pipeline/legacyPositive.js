function histogramPercentile(hist, target) {
  let sum = 0;
  for (let i = 0; i < hist.length; i++) {
    sum += hist[i];
    if (sum >= target) return i;
  }
  return hist.length - 1;
}

export function convertPositiveLegacy(imageData, options = {}) {
  const { width, height, data } = imageData;
  const output = new ImageData(new Uint8ClampedArray(data.length), width, height);
  const outData = output.data;
  const pixelCount = width * height;

  const clipPercent = Math.max(0, Math.min(0.1, options.clipPercent ?? 0.01));
  const lowTarget = pixelCount * clipPercent;
  const highTarget = pixelCount * (1 - clipPercent);

  const rHist = new Uint32Array(256);
  const gHist = new Uint32Array(256);
  const bHist = new Uint32Array(256);

  for (let i = 0; i < data.length; i += 4) {
    rHist[data[i]]++;
    gHist[data[i + 1]]++;
    bHist[data[i + 2]]++;
  }

  const rLow = histogramPercentile(rHist, lowTarget);
  const gLow = histogramPercentile(gHist, lowTarget);
  const bLow = histogramPercentile(bHist, lowTarget);
  const rHigh = histogramPercentile(rHist, highTarget);
  const gHigh = histogramPercentile(gHist, highTarget);
  const bHigh = histogramPercentile(bHist, highTarget);

  const rScale = 255 / Math.max(1, rHigh - rLow);
  const gScale = 255 / Math.max(1, gHigh - gLow);
  const bScale = 255 / Math.max(1, bHigh - bLow);

  for (let i = 0; i < data.length; i += 4) {
    let r = (data[i] - rLow) * rScale;
    let g = (data[i + 1] - gLow) * gScale;
    let b = (data[i + 2] - bLow) * bScale;

    if (r < 0) r = 0;
    else if (r > 255) r = 255;
    if (g < 0) g = 0;
    else if (g > 255) g = 255;
    if (b < 0) b = 0;
    else if (b > 255) b = 255;

    outData[i] = (r + 0.5) | 0;
    outData[i + 1] = (g + 0.5) | 0;
    outData[i + 2] = (b + 0.5) | 0;
    outData[i + 3] = 255;
  }

  return output;
}
