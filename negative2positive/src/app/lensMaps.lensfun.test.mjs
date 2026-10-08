// Lens correction with the real lensfun (#278): the installed
// @neoanaloglabkk/lensfun-wasm's maps through buildLensMaps and the remap
// the editor, exports and display-proxy fills share (lensMaps.js), for the
// lens a saved profile names (findLensHandle: recipes store the profile's
// identity, never lensfun's handle).
//
// Each frame is remapped as two coordinate planes, every channel holding
// (x + 1) * 16 or (y + 1) * 16: bilinear sampling of a linear ramp is exact,
// so an output pixel's value names the source position its channel was
// read from (0: outside the frame). The corrected frame must move by the
// distortion map's amount; TCA on must add only the per-channel shift (green
// stays where the distortion puts it); a lens without TCA or vignetting
// calibration must still be corrected; nothing may throw.
//
// Lenses without distortion calibration get their TCA and vignetting alone,
// read in place. Every entry of the database resolves from its saved
// identity, and a recipe saved with one reopens with the same correction in
// another build, whose handles differ.
//
// lensfun-wasm 0.1.3 builds no maps (its core exports no HEAPF32 view):
// with it, buildLensMaps throws for every lens and the editor converts the
// frame uncorrected (applyLensCorrectionWithSettings catches it, which
// displaySessions.test.mjs checks with a client that throws the same way).
import assert from 'node:assert/strict';

globalThis.ImageData = class ImageData {
  constructor(dataOrWidth, width, height) {
    if (typeof dataOrWidth === 'number') {
      this.width = dataOrWidth; this.height = width; this.data = new Uint8ClampedArray(dataOrWidth * width * 4);
    } else {
      this.data = dataOrWidth; this.width = width; this.height = height;
    }
  }
};
const { applyLensMapsToImage, buildLensMaps, lensMapRequest, lensRowExtents, lensHandleFor, findLensHandle, lensProfileKey } = await import('./lensMaps.js');
const { lensfunNodeClient, lensfunPackageVersion, lensfunDatabaseModels, versionAtLeast } = await import('./lensfunNodeClient.mjs');

const version = lensfunPackageVersion();
const { client, errors } = await lensfunNodeClient();

const CANON_24_105 = {
  query: { lensMaker: 'Canon', lensModel: 'EF 24-105mm f/4L IS USM', cameraMaker: 'Canon', cameraModel: 'Canon EOS 5D Mark III' },
  model: /^Canon EF 24-105mm f\/4L IS USM$/
};
const NIKKOR_18_55 = {
  query: { lensMaker: 'Nikon', lensModel: 'AF-S DX Nikkor 18-55mm f/3.5-5.6G VR', cameraMaker: 'Nikon Corporation', cameraModel: 'Nikon D7000' },
  model: /18-55mm f\/3\.5-5\.6G DX VR$/
};
const CANON_28_105 = {
  query: { lensMaker: 'Canon', lensModel: 'EF 28-105mm f/3.5-4.5 II USM', cameraMaker: 'Canon', cameraModel: 'Canon EOS 5D Mark III' },
  model: /^Canon EF 28-105mm f\/3\.5-4\.5 II USM$/
};

// The lens panel's search (sorted and uniquified, with the photo's camera).
function findLens({ query, model }, lensfun = client) {
  const lens = lensfun.searchLenses({ ...query, searchFlags: 2 }).find(match => model.test(match.model));
  assert.ok(lens, `lensfun finds ${query.lensModel}`);
  return lens;
}

// The profile a recipe keeps of a search result (sanitizeLensSelection's
// form): its identity and the search's camera, without the handle or the
// score, saved and read back.
function savedProfile(lens, spec = null) {
  const { handle, score, ...profile } = lens;
  const camera = spec?.query.cameraModel ? { maker: spec.query.cameraMaker, model: spec.query.cameraModel } : null;
  return JSON.parse(JSON.stringify({ ...profile, camera }));
}

// A resolved lens block with that profile, and the request for its maps,
// for the handle the profile resolves to in `lensfun`.
function lensBlock(profile, params, modes = {}) {
  return {
    enabled: true, selectedLens: profile,
    params: { aperture: 8, distance: 1000, stepMode: 'auto', step: 2, ...params },
    modes: { includeTca: true, includeVignetting: true, ...modes },
    lastError: ''
  };
}
function mapRequest(block, width, height, lensfun = client) {
  const handle = lensHandleFor(lensfun, block.selectedLens);
  assert.ok(handle, `${block.selectedLens.model} resolves in this build`);
  return lensMapRequest(block, width, height, handle);
}

// A saved profile names the lens it was chosen as, in this build too: the
// search's identity resolves to the search's handle (lensfun-wasm 0.1.3's
// search without a camera searches one camera's mount: the profile's camera
// finds it there).
for (const spec of [CANON_24_105, NIKKOR_18_55, CANON_28_105]) {
  const lens = findLens(spec);
  assert.equal(findLensHandle(client, savedProfile(lens, spec)), lens.handle, `${lens.model}: the saved profile names the entry chosen`);
  assert.ok(!JSON.stringify(savedProfile(lens, spec)).includes(String(lens.handle)), 'the saved profile names no handle');
}

if (!versionAtLeast(version, '0.1.4')) {
  const lens = findLens(CANON_24_105);
  const { request } = mapRequest(lensBlock(savedProfile(lens, CANON_24_105), { focal: 24, crop: 1 }), 600, 400);
  assert.throws(() => buildLensMaps(client, request), 'lensfun-wasm 0.1.3 builds no maps');
  console.log(`lensMaps.lensfun: lensfun-wasm ${version} builds no maps (buildLensMaps throws, so the editor converts uncorrected), saved profiles resolve to the entries chosen; the correction checks run from 0.1.4 on`);
  process.exit(0);
}

assert.deepEqual(errors.filter(message => message.includes('[Lensfun]')), [], 'the lens database parses without errors');

// The coordinate planes of a width x height frame: every channel holds
// (x + 1) * 16, or (y + 1) * 16.
function coordinatePlane(width, height, axis) {
  const data16 = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const v = ((axis === 'x' ? x : y) + 1) * 16;
      data16[i] = v; data16[i + 1] = v; data16[i + 2] = v; data16[i + 3] = 65535;
    }
  }
  const image = new ImageData(Uint8ClampedArray.from(data16, v => v >>> 8), width, height);
  image.__image16 = { width, height, data: data16 };
  return image;
}

const remap16 = (image, maps, modes) => applyLensMapsToImage(image, maps, modes).__image16.data;
// The source coordinate an output channel read, or null outside the frame.
const sourceAt = (plane, i, c) => (plane[i * 4 + c] ? plane[i * 4 + c] / 16 - 1 : null);

function samePlane(a, b, channel) {
  for (let i = channel; i < a.length; i += 4) if (a[i] !== b[i]) return false;
  return true;
}

// The pixel a grid node stands for (lensfun's nodes: index * step, clamped).
const nodeAt = (index, step, size) => Math.min(index * step, size - 1);

function checkCase(label, spec, params, { width, height, expect }) {
  const lens = findLens(spec);
  const block = lensBlock(savedProfile(lens, spec), params);
  const { request } = mapRequest(block, width, height);
  let maps;
  assert.doesNotThrow(() => { maps = buildLensMaps(client, request); }, `${label}: maps build`);
  assert.equal(Boolean(maps.tca), expect.tca, `${label}: TCA ${expect.tca ? 'applied' : 'not applied (no calibration)'}`);
  assert.equal(Boolean(maps.vignetting), expect.vignetting, `${label}: vignetting ${expect.vignetting ? 'applied' : 'not applied (no calibration)'}`);

  const X = coordinatePlane(width, height, 'x');
  const Y = coordinatePlane(width, height, 'y');
  const off = { includeTca: false, includeVignetting: false };
  const on = { includeTca: true, includeVignetting: false };
  const xOff = remap16(X, maps, off), yOff = remap16(Y, maps, off);
  const xOn = remap16(X, maps, on), yOn = remap16(Y, maps, on);

  // At every grid node the remap reads exactly the distortion map's source
  // position (to the planes' 1/16 px), with TCA on as off for green.
  const { gridWidth, gridHeight, step } = maps;
  let nodeError = 0, mapMove = 0, nodes = 0;
  for (let gy = 0; gy < gridHeight; gy++) {
    for (let gx = 0; gx < gridWidth; gx++) {
      const x = gx * step, y = gy * step;
      if (x > width - 1 || y > height - 1) continue;
      const node = gy * gridWidth + gx;
      const sx = maps.geometry[node * 2], sy = maps.geometry[node * 2 + 1];
      if (!(sx >= 0 && sy >= 0 && sx <= width - 1 && sy <= height - 1)) continue;
      const i = y * width + x;
      for (const [planeX, planeY] of [[xOff, yOff], [xOn, yOn]]) {
        nodeError = Math.max(nodeError, Math.abs(sourceAt(planeX, i, 1) - sx), Math.abs(sourceAt(planeY, i, 1) - sy));
      }
      mapMove = Math.max(mapMove, Math.hypot(sx - nodeAt(gx, step, width), sy - nodeAt(gy, step, height)));
      nodes++;
    }
  }
  assert.ok(nodes > 100, `${label}: nodes checked`);
  assert.ok(nodeError <= 1 / 32 + 1e-9, `${label}: the remap reads the distortion map's source positions (${nodeError} px off)`);

  // The corrected frame moves by the distortion: its largest move is the map's.
  let moved = 0, shift = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const gxs = sourceAt(xOff, i, 1), gys = sourceAt(yOff, i, 1);
      if (gxs === null || gys === null) continue;
      moved = Math.max(moved, Math.hypot(gxs - x, gys - y));
      for (const c of [0, 2]) {
        const cx = sourceAt(xOn, i, c), cy = sourceAt(yOn, i, c);
        if (cx === null || cy === null) continue;
        shift = Math.max(shift, Math.hypot(cx - gxs, cy - gys));
      }
    }
  }
  assert.ok(moved >= expect.minMove, `${label}: the frame moves by up to ${moved.toFixed(1)} px (distortion)`);
  assert.ok(Math.abs(moved - mapMove) <= 1.5, `${label}: as far as the distortion map moves it (${moved.toFixed(2)} vs ${mapMove.toFixed(2)} px)`);

  // TCA on: green exactly where the distortion puts it, red and blue a
  // little apart; without TCA calibration, TCA on changes nothing.
  assert.ok(samePlane(xOn, xOff, 1) && samePlane(yOn, yOff, 1), `${label}: TCA leaves green where the distortion puts it`);
  if (expect.tca) {
    assert.ok(shift > 0.05 && shift < 3, `${label}: TCA moves red and blue by up to ${shift.toFixed(2)} px from green`);
  } else {
    assert.ok(samePlane(xOn, xOff, 0) && samePlane(xOn, xOff, 2) && samePlane(yOn, yOff, 0) && samePlane(yOn, yOff, 2),
      `${label}: without TCA calibration TCA on changes nothing`);
  }

  // Vignetting, where the lens has it, brightens the corners of a flat frame.
  if (expect.vignetting) {
    const flat = new Uint16Array(width * height * 4).fill(20000);
    const image = new ImageData(Uint8ClampedArray.from(flat, v => v >>> 8), width, height);
    image.__image16 = { width, height, data: flat };
    const out = remap16(image, maps, { includeTca: false, includeVignetting: true });
    const at = (x, y) => out[(y * width + x) * 4 + 1];
    const centre = at(width >> 1, height >> 1);
    assert.ok(Math.abs(centre - 20000) < 400, `${label}: the centre keeps its level (${centre})`);
    assert.ok(at(Math.round(width * 0.1), Math.round(height * 0.1)) > centre, `${label}: the corners are brightened`);
  }
  return { label, lens: lens.model, width, height, step, moved: +moved.toFixed(2), tcaShift: +shift.toFixed(2), tca: Boolean(maps.tca), vignetting: Boolean(maps.vignetting) };
}

const results = [
  checkCase('Canon 24-105 at 24 mm', CANON_24_105, { focal: 24, crop: 1 }, { width: 1200, height: 800, expect: { tca: true, vignetting: true, minMove: 20 } }),
  checkCase('Canon 24-105 at 70 mm', CANON_24_105, { focal: 70, crop: 1 }, { width: 900, height: 600, expect: { tca: true, vignetting: true, minMove: 2 } }),
  checkCase('Nikkor 18-55 DX at 18 mm', NIKKOR_18_55, { focal: 18, crop: 1.528, aperture: 5.6 }, { width: 1200, height: 800, expect: { tca: false, vignetting: true, minMove: 5 } }),
  checkCase('Canon 28-105 at 28 mm', CANON_28_105, { focal: 28, crop: 1 }, { width: 800, height: 1200, expect: { tca: false, vignetting: false, minMove: 5 } })
];

// The Canon 24-105 at 24 mm on a 60 MP crop (8385 x 5569): the rows the
// remap reads follow the distortion (lensfun-wasm's TCA map alone moved
// them by about 1 px, the distortion map by about 148 px), and green is
// the distortion map's.
{
  const lens = findLens(CANON_24_105);
  const width = 8385, height = 5569;
  const { request } = mapRequest(lensBlock(savedProfile(lens, CANON_24_105), { focal: 24, crop: 1 }), width, height);
  const maps = buildLensMaps(client, request);
  assert.ok(maps.tca && maps.vignetting && maps.step === 8, 'the 60 MP crop gets distortion, TCA and vignetting at step 8');
  const extents = lensRowExtents(maps, { includeTca: true });
  let rowMove = 0;
  for (let gy = 0; gy < maps.gridHeight; gy++) {
    const y = nodeAt(gy, maps.step, height);
    rowMove = Math.max(rowMove, Math.abs(extents.min[gy] - y), Math.abs(extents.max[gy] - y));
  }
  const tcaOnly = client.buildCorrectionMaps({ ...request, includeTca: true, includeVignetting: false }).tca;
  let tcaOnlyRowMove = 0, greenOff = 0;
  for (let gy = 0; gy < maps.gridHeight; gy++) {
    const y = nodeAt(gy, maps.step, height);
    for (let gx = 0; gx < maps.gridWidth; gx++) {
      const node = gy * maps.gridWidth + gx;
      for (let c = 0; c < 3; c++) tcaOnlyRowMove = Math.max(tcaOnlyRowMove, Math.abs(tcaOnly[node * 6 + c * 2 + 1] - y));
      greenOff = Math.max(greenOff, Math.abs(maps.tca[node * 6 + 2] - maps.geometry[node * 2]), Math.abs(maps.tca[node * 6 + 3] - maps.geometry[node * 2 + 1]));
    }
  }
  assert.ok(rowMove > 100, `the remap reads rows up to ${rowMove.toFixed(1)} px away (distortion)`);
  assert.ok(tcaOnlyRowMove < 5, `lensfun's TCA map alone moves rows by ${tcaOnlyRowMove.toFixed(1)} px`);
  assert.equal(greenOff, 0, 'green is the distortion map\'s position');
  results.push({ label: 'Canon 24-105 at 24 mm, 60 MP crop (maps)', width, height, step: maps.step, rowMove: +rowMove.toFixed(1), tcaOnlyRowMove: +tcaOnlyRowMove.toFixed(1) });
}

// ---- Lenses without distortion calibration (39 of 0.1.4's 1558 entries):
// no geometry map (lensfun refuses one, -4), TCA alone and vignetting
// alone, every pixel read in place where TCA is off ----
const SIGMA_70_MACRO = {
  query: { lensMaker: 'Sigma', lensModel: 'Sigma 70mm f/2.8 EX DG Macro', cameraMaker: 'Nikon Corporation', cameraModel: 'Nikon D7000' },
  model: /^Sigma 70mm f\/2\.8 EX DG Macro$/
};
const NIKKOR_60_MICRO = {
  query: { lensMaker: 'Nikon', lensModel: 'AF-S Micro Nikkor 60mm f/2.8G ED', cameraMaker: 'Nikon Corporation', cameraModel: 'Nikon D850' },
  model: /^Nikkor AF-S 60 mm f\/2\.8G ED Micro$/
};
const OLYMPUS_30_MACRO = {
  query: { lensMaker: 'Olympus', lensModel: 'M.Zuiko Digital ED 30mm f/3.5 Macro', cameraMaker: 'Olympus Corporation', cameraModel: 'E-M5' },
  model: /^Olympus M\.Zuiko Digital ED 30mm f\/3\.5 Macro$/
};
function checkWithoutDistortion(label, spec, params, { width, height, expect }) {
  const lens = findLens(spec);
  const block = lensBlock(savedProfile(lens, spec), params);
  const { request } = mapRequest(block, width, height);
  assert.equal(client.getAvailableModifications(request.lensHandle, request.crop) & 0x8, 0, `${label}: no distortion calibration`);
  assert.throws(() => client.buildCorrectionMaps({ ...request, includeTca: false, includeVignetting: false }), /-4/, `${label}: lensfun builds no geometry map for it`);
  const maps = buildLensMaps(client, request);
  assert.equal(maps.geometry, null, `${label}: no geometry map`);
  assert.equal(Boolean(maps.tca), expect.tca, `${label}: TCA ${expect.tca ? 'applied' : 'none'}`);
  assert.equal(Boolean(maps.vignetting), expect.vignetting, `${label}: vignetting ${expect.vignetting ? 'applied' : 'none'}`);
  const X = coordinatePlane(width, height, 'x');
  const Y = coordinatePlane(width, height, 'y');
  // TCA off: every pixel in place, its own value exactly.
  const still = { includeTca: false, includeVignetting: false };
  assert.ok(samePlane(remap16(X, maps, still), X.__image16.data, 1) && samePlane(remap16(Y, maps, still), Y.__image16.data, 0),
    `${label}: without TCA nothing moves`);
  let shift = 0, greenOff = 0;
  if (expect.tca) {
    // TCA on: green stays (lensfun's own rounding, well under a pixel), red
    // and blue move apart from it. Up to the grid's last node: the pixels
    // past it (the last (width - 1) % step columns and rows) read that
    // node's positions, as for every lens (docs/audit-backlog.md).
    const on = { includeTca: true, includeVignetting: false };
    const xOn = remap16(X, maps, on), yOn = remap16(Y, maps, on);
    const lastX = (maps.gridWidth - 1) * maps.step, lastY = (maps.gridHeight - 1) * maps.step;
    for (let y = 0; y <= lastY; y++) {
      for (let x = 0; x <= lastX; x++) {
        const i = y * width + x;
        const gx = sourceAt(xOn, i, 1), gy = sourceAt(yOn, i, 1);
        if (gx === null || gy === null) continue;
        greenOff = Math.max(greenOff, Math.hypot(gx - x, gy - y));
        for (const c of [0, 2]) {
          const cx = sourceAt(xOn, i, c), cy = sourceAt(yOn, i, c);
          if (cx !== null && cy !== null) shift = Math.max(shift, Math.hypot(cx - gx, cy - gy));
        }
      }
    }
    assert.ok(greenOff < 0.1, `${label}: TCA leaves green in place (${greenOff.toFixed(3)} px)`);
    assert.ok(shift > 0.05 && shift < 5, `${label}: TCA moves red and blue by up to ${shift.toFixed(2)} px`);
  }
  if (expect.vignetting) {
    // Vignetting alone: the gains, nothing moved: the centre keeps its
    // level, the corners are brightened, and each pixel is its own value
    // times its gain.
    const flat = new Uint16Array(width * height * 4).fill(20000);
    const image = new ImageData(Uint8ClampedArray.from(flat, v => v >>> 8), width, height);
    image.__image16 = { width, height, data: flat };
    const out = remap16(image, maps, { includeTca: false, includeVignetting: true });
    const at = (x, y) => out[(y * width + x) * 4 + 1];
    const centre = at(width >> 1, height >> 1);
    assert.ok(Math.abs(centre - 20000) < 400, `${label}: the centre keeps its level (${centre})`);
    assert.ok(at(Math.round(width * 0.05), Math.round(height * 0.05)) > centre * 1.05, `${label}: the corners are brightened`);
    const xV = remap16(X, maps, { includeTca: false, includeVignetting: true });
    assert.ok(xV[1] === Math.round(X.__image16.data[1] * maps.vignetting[1]), `${label}: the first pixel is its own value times its gain`);
  } else {
    assert.throws(() => buildLensMaps(client, { ...request, includeTca: false }), /nothing to correct/, `${label}: TCA off leaves nothing to correct`);
  }
  return { label, lens: lens.model, width, height, step: maps.step, tca: Boolean(maps.tca), tcaShift: +shift.toFixed(2), greenOff: +greenOff.toFixed(4), vignetting: Boolean(maps.vignetting) };
}
results.push(
  checkWithoutDistortion('Sigma 70mm Macro at 70 mm (TCA only)', SIGMA_70_MACRO, { focal: 70, crop: 1.534 }, { width: 900, height: 600, expect: { tca: true, vignetting: false } }),
  checkWithoutDistortion('Nikkor 60 mm Micro at 60 mm (vignetting only)', NIKKOR_60_MICRO, { focal: 60, crop: 1, aperture: 4 }, { width: 900, height: 600, expect: { tca: false, vignetting: true } }),
  checkWithoutDistortion('Olympus 30mm Macro at 30 mm (TCA and vignetting)', OLYMPUS_30_MACRO, { focal: 30, crop: 2, aperture: 3.5 }, { width: 800, height: 600, expect: { tca: true, vignetting: true } })
);

// ---- Every entry of the database resolves from the profile a recipe
// keeps of it (its identity, without a camera) to itself, or to a twin with
// the same name, crop factor and ranges (the same lens in another camera's
// mount, which the camera tells apart) ----
{
  const { files, models } = lensfunDatabaseModels();
  assert.ok(files > 40 && models.length > 1500, `the database's model names (${models.length} in ${files} files)`);
  const entries = new Map();
  for (const model of models) {
    for (const searchFlags of [0, 1]) {
      for (const lens of client.searchLenses({ lensModel: model, searchFlags })) entries.set(lens.handle, lens);
    }
  }
  assert.ok(entries.size >= 1558, `every entry is found (${entries.size})`);
  const started = performance.now();
  let itself = 0, twins = 0;
  const lost = [];
  for (const lens of entries.values()) {
    const handle = findLensHandle(client, savedProfile(lens));
    if (handle === lens.handle) itself++;
    else if (handle && lensProfileKey(savedProfile(entries.get(handle))) === lensProfileKey(savedProfile(lens))) twins++;
    else lost.push(`${lens.maker} | ${lens.model} | ${lens.cropFactor} -> ${handle}`);
  }
  const msPerProfile = (performance.now() - started) / entries.size;
  assert.deepEqual(lost, [], 'no profile resolves to another lens or none');
  assert.ok(twins <= 8, `${twins} entries resolve to a twin`);
  results.push({ label: 'every entry of the database', entries: entries.size, itself, twins, msPerProfile: +msPerProfile.toFixed(3) });
}

// ---- A recipe saved with a profile reopens with the same correction: on
// another start of the same build, and in a build whose handles differ (a
// stand-in that relocates every handle, as another build or database lays
// its lenses out elsewhere), where the saved handle names no lens ----
{
  const relocated = (base, offset) => {
    const back = handle => handle - offset;
    return {
      searchLenses: input => base.searchLenses(input).map(lens => ({ ...lens, handle: lens.handle + offset })),
      getAvailableModifications: (handle, crop) => base.getAvailableModifications(back(handle), crop),
      buildCorrectionMaps: input => base.buildCorrectionMaps({ ...input, lensHandle: back(input.lensHandle) }),
      buildSubpixelGeometryMap: input => base.buildSubpixelGeometryMap({ ...input, lensHandle: back(input.lensHandle) }),
      fns: { buildVignettingMap: (handle, ...args) => base.fns.buildVignettingMap(back(handle), ...args) },
      runFloatMap: (size, fn, ...args) => base.runFloatMap(size, fn, ...args)
    };
  };
  const restarted = (await lensfunNodeClient()).client;
  const elsewhere = relocated((await lensfunNodeClient()).client, 1 << 24);
  const bytes = array => Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  const sameMaps = (a, b, label) => {
    for (const key of ['geometry', 'tca', 'vignetting']) {
      assert.equal(Boolean(a[key]), Boolean(b[key]), `${label}: ${key}`);
      if (a[key]) assert.ok(bytes(a[key]).equals(bytes(b[key])), `${label}: the same ${key} map`);
    }
  };
  for (const [spec, params] of [[CANON_24_105, { focal: 24, crop: 1 }], [NIKKOR_60_MICRO, { focal: 60, crop: 1, aperture: 4 }], [SIGMA_70_MACRO, { focal: 70, crop: 1.534 }]]) {
    const lens = findLens(spec);
    const block = lensBlock(savedProfile(lens, spec), params);
    const saved = JSON.parse(JSON.stringify(block));
    const original = buildLensMaps(client, mapRequest(block, 600, 400).request);
    sameMaps(buildLensMaps(restarted, mapRequest(saved, 600, 400, restarted).request), original, `${lens.model} after a restart`);
    const moved = mapRequest(saved, 600, 400, elsewhere);
    assert.equal(moved.request.lensHandle, lens.handle + (1 << 24), `${lens.model}: the other build's handle`);
    assert.equal(moved.key, mapRequest(block, 600, 400).key, 'the same cache key');
    sameMaps(buildLensMaps(elsewhere, moved.request), original, `${lens.model} in another build`);
    assert.equal(elsewhere.getAvailableModifications(lens.handle, params.crop), 0, `${lens.model}: the saved handle names no lens there`);
  }
  results.push({ label: 'saved profiles reopen with the same maps after a restart and in a build with other handles' });
}

console.log(`lensMaps.lensfun: lensfun-wasm ${version}: ${results.map(r => JSON.stringify(r)).join('; ')}`);
