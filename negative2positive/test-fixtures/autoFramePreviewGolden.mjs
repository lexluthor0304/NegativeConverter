// A fixed synthetic frame for the auto-frame preview resizer (#251 part 2)
// and the SHA-256 its preview must hash to on every engine: Node
// (autoFramePreview.test.mjs), Chrome (the smoke suite) and the macOS
// WKWebView build. Odd sizes, gradients, hard edges and LCG noise, so every
// coverage weight and rounding branch is exercised.

export const GOLDEN_PREVIEW_CASES = [
  { width: 2003, height: 1337, maxSide: 1600, seed: 251 },
  { width: 1601, height: 3001, maxSide: 1600, seed: 17 },
];

// SHA-256 (hex) of areaResizeToMaxSide(goldenPreviewSource(case), maxSide).data
export const GOLDEN_PREVIEW_SHA256 = [
  '39e9b4c10c26af135c63fbfb12ea66da24c576d6bbbd5a72a566041f83e61caf',
  'f9eb95c6f3c2f1e887ec3b59778fa5dceab7264a9c5d464e9af566a74a6aa659',
];

export function goldenPreviewSource({ width, height, seed }) {
  const data = new Uint8ClampedArray(width * height * 4);
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state >>> 24;
  };
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i += 4) {
      const edge = (x > width * 0.2 && x < width * 0.8 && y > height * 0.25 && y < height * 0.75) ? 90 : 0;
      data[i] = (x * 255 / width + edge + (next() & 31)) & 255;
      data[i + 1] = (y * 255 / height + (next() & 15)) & 255;
      data[i + 2] = ((x ^ y) & 255) - (edge >> 1) + (next() & 7);
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}
