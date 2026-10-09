// Test-only lens maps (#278) in lensfun's format (buildLensMaps' from
// @neoanaloglabkk/lensfun-wasm: a node every `step` pixels, the geometry
// map's source x, y per node, per channel the source x, y with distortion
// and TCA corrected together, vignetting's gains), shaped like a real
// lens's: lensfun's maps of a 9000 x 6000 frame at 18 mm read the corners
// about 2.3 % inward and multiply them by about 1.5. A radial remap toward
// the centre, TCA scaling red and blue a little apart from it, gains rising
// toward the corners. `shift` moves every source y; `poison` puts NaN,
// infinite and far-off nodes into the grid. `distortion: false` (a lens
// without distortion calibration): no geometry map, and TCA alone (red and
// blue scaled a little about the centre, green in place). `coverFrame`
// (default true, the grid buildLensMaps gives: lensGridNodes): the grid
// covers the frame, one more node per axis up to step - 1 pixels past the
// last pixel where step does not divide the side; false: lensfun-wasm's
// default grid, which ends at or before the last pixel. Never imported by
// the app.
export function lensTestMaps(width, height, step, { strength = 0.023, tca = true, vignetting = true, shift = 0, poison = false, distortion = true, coverFrame = true } = {}) {
  const nodesOf = size => (coverFrame ? Math.ceil((size - 1) / step) : Math.floor((size - 1) / step)) + 1;
  const gridWidth = nodesOf(width);
  const gridHeight = nodesOf(height);
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const norm = cx * cx + cy * cy;
  const geometry = new Float32Array(gridWidth * gridHeight * 2);
  const tcaMap = tca ? new Float32Array(gridWidth * gridHeight * 6) : undefined;
  const gains = vignetting ? new Float32Array(gridWidth * gridHeight * 3) : undefined;
  for (let gy = 0; gy < gridHeight; gy++) {
    for (let gx = 0; gx < gridWidth; gx++) {
      const dx = gx * step - cx;
      const dy = gy * step - cy;
      const r2 = (dx * dx + dy * dy) / norm;
      const scale = distortion ? 1 - strength * r2 : 1;
      const node = gy * gridWidth + gx;
      geometry[node * 2] = cx + dx * scale;
      geometry[node * 2 + 1] = cy + dy * scale + shift;
      if (tcaMap) {
        [1.0008, 1, 0.9993].forEach((f, c) => {
          tcaMap[node * 6 + c * 2] = cx + dx * scale * f;
          tcaMap[node * 6 + c * 2 + 1] = cy + dy * scale * f + shift;
        });
      }
      if (gains) for (let c = 0; c < 3; c++) gains[node * 3 + c] = 1 + (0.5 + 0.03 * c) * r2;
    }
  }
  if (poison) {
    const nodes = gridWidth * gridHeight;
    for (const [node, value] of [[1, NaN], [Math.floor(nodes / 3), Infinity], [Math.floor(nodes / 2), -Infinity], [nodes - 2, height * 9], [gridWidth + 1, -height * 4]]) {
      geometry[node * 2 + 1] = value;
      if (tcaMap) tcaMap[node * 6 + 3] = value;
    }
    if (tcaMap) tcaMap[5 * 6] = NaN;
  }
  return { gridWidth, gridHeight, step, geometry: distortion ? geometry : null, tca: tcaMap, vignetting: gains };
}

// A lensfun client (lensfun-wasm 0.1.4's API) whose maps are lensTestMaps
// for the size, step and grid (`coverFrame`) it is asked:
// buildCorrectionMaps' geometry (and vignetting as requested; its own TCA
// map too, which buildLensMaps never asks for), buildSubpixelGeometryMap's
// per-channel map, lensTestMaps' `tca`, and buildVignettingMap's gains
// alone. It records the requests of each (`requests`, `subpixelRequests`,
// `vignettingRequests`); searchLenses finds `lens`, which has distortion,
// TCA and vignetting calibration (`modifications`). Without distortion
// calibration it fails as lensfun does (code -4): buildCorrectionMaps
// always, buildSubpixelGeometryMap without TCA calibration, and
// buildVignettingMap without vignetting calibration. `coversFrame: false`:
// a client before lensfun-wasm 0.1.4, which ignores `coverFrame` and builds
// its default grid.
export function lensTestClient({ lens = { handle: 2741040, maker: 'Test', model: 'Test 18-55mm', score: 90, minFocal: 18, maxFocal: 55, minAperture: 3.5, maxAperture: 22, cropFactor: 1.5 }, modifications = 0x1 | 0x2 | 0x8, coversFrame = true, ...options } = {}) {
  const requests = [];
  const subpixelRequests = [];
  const vignettingRequests = [];
  const distortion = Boolean(modifications & 0x8);
  const failed = () => new Error('[lensfun-wasm] native map builder failed with code -4');
  const maps = (request, extra) => lensTestMaps(request.width, request.height, request.step,
    { ...options, ...extra, coverFrame: coversFrame && Boolean(request.coverFrame) });
  return {
    requests,
    subpixelRequests,
    vignettingRequests,
    searchLenses: () => [lens],
    getAvailableModifications: () => modifications,
    buildCorrectionMaps(request) {
      requests.push({ ...request });
      if (!distortion) throw failed();
      return maps(request, { tca: Boolean(request.includeTca), vignetting: Boolean(request.includeVignetting) });
    },
    buildSubpixelGeometryMap(request) {
      subpixelRequests.push({ ...request });
      if (!distortion && !(modifications & 0x1)) throw failed();
      const built = maps(request, { distortion, tca: true, vignetting: false });
      return { gridWidth: built.gridWidth, gridHeight: built.gridHeight, step: built.step, coords: built.tca,
        modifications: (distortion ? 0x8 : 0) | (modifications & 0x1) };
    },
    buildVignettingMap(request) {
      vignettingRequests.push({ ...request });
      if (!(modifications & 0x2)) throw failed();
      const built = maps(request, { tca: false, vignetting: true });
      return { gridWidth: built.gridWidth, gridHeight: built.gridHeight, step: built.step, gains: built.vignetting };
    }
  };
}
