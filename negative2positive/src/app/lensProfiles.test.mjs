// Lens profiles in recipes (#278), on main.js's own functions and the
// installed @neoanaloglabkk/lensfun-wasm:
// - choosing a profile sets the lens, not the shot: the photo's focal
//   length and aperture stay what its file's metadata gives or the user
//   typed (a 24-105 shot at 24 mm was corrected as 64.5 mm at f/22);
// - recipes keep the profile's identity, never lensfun's handle, and a
//   recipe saved so reopens with the same correction, in a build whose
//   handles differ too;
// - an older recipe's handle is dropped: a profile with its name is looked
//   up by the name, a handle alone or a name this build lacks takes the
//   panel's "select a lens profile" path, the frame uncorrected.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

globalThis.ImageData = class ImageData {
  constructor(dataOrWidth, width, height) {
    if (typeof dataOrWidth === 'number') {
      this.width = dataOrWidth; this.height = width; this.data = new Uint8ClampedArray(dataOrWidth * width * 4);
    } else {
      this.data = dataOrWidth; this.width = width; this.height = height;
    }
  }
};
const lensMaps = await import('./lensMaps.js');
const { lensfunNodeClient, lensfunPackageVersion, versionAtLeast } = await import('./lensfunNodeClient.mjs');

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  const end = source.indexOf('\n    }', match.index);
  return source.slice(match.index, end + 6);
}

// Objects made in the vm context compared as plain data.
const plain = value => JSON.parse(JSON.stringify(value));

const version = lensfunPackageVersion();
const makesMaps = versionAtLeast(version, '0.1.4');
const { client } = await lensfunNodeClient();

// A lensfun build whose handles all differ from `base`'s (as another build
// or database lays its lenses out elsewhere): the same lenses and maps.
function relocated(base, offset = 1 << 24) {
  const back = handle => handle - offset;
  return {
    searchLenses: input => base.searchLenses(input).map(lens => ({ ...lens, handle: lens.handle + offset })),
    getAvailableModifications: (handle, crop) => base.getAvailableModifications(back(handle), crop),
    buildCorrectionMaps: input => base.buildCorrectionMaps({ ...input, lensHandle: back(input.lensHandle) }),
    buildSubpixelGeometryMap: input => base.buildSubpixelGeometryMap({ ...input, lensHandle: back(input.lensHandle) }),
    buildVignettingMap: input => base.buildVignettingMap({ ...input, lensHandle: back(input.lensHandle) })
  };
}

// The editor's lens functions around a lensfun client: the panel's status
// and warnings are recorded.
function editor(lensfun = client) {
  const statuses = [];
  const warnings = [];
  const inputs = new Map();
  const context = vm.createContext({
    ImageData,
    console: { ...console, warn: (...args) => warnings.push(args.join(' ')) },
    ...lensMaps,
    lensfunRuntime: { client: lensfun, source: 'local', initPromise: null, searchFlags: 2, lastError: '' },
    lensMapCache: new Map(), lensCorrectedSources: new WeakMap(), shotMetadataByFile: new WeakMap(), missingLensProfilesWarned: new Set(),
    ensureLensfunClient: async () => ({ client: lensfun, source: 'local', searchFlags: 2 }),
    setLensStatus: (statusKey, statusVars = {}) => {
      context.state.lensCorrection.statusKey = statusKey;
      context.state.lensCorrection.statusVars = { ...statusVars };
      statuses.push(statusKey);
    },
    updateLensCorrectionUI: () => {}, markCurrentFileDirty: () => { context.dirty = (context.dirty || 0) + 1; },
    // A frame's own lens block, or the editor's.
    resolveLensCorrection: settings => context.sanitizeLensCorrection(
      settings === context.state ? context.state.lensCorrection : settings?.lensCorrection, context.state.lensCorrection),
    document: { getElementById: id => inputs.get(id) || null }
  });
  vm.runInContext(['clampBetween', 'sanitizeNumeric', 'createDefaultLensCorrectionSettings', 'createInitialLensCorrectionState',
    'sanitizeLensSelection', 'sanitizeLensShotSource', 'sanitizeLensCorrection', 'formatLensLabel', 'sanitizeLensRuntimeError',
    'resolveLensStatusKeyForSource', 'rememberShotMetadata', 'shotMetadataFor', 'applyShotMetadata', 'withReceivingShot',
    'guessFocalFromLensProfile', 'applyLensProfileSelection', 'lensProfileMissingError', 'lensCorrectionMaps',
    'applyLensCorrectionWithSettings', 'lensCorrectionActive', 'lensSignatureOf', 'bindLensNumericParamInput']
    .map(functionSource).join('\n'), context);
  context.state = { lensCorrection: context.createInitialLensCorrectionState(), loadedFile: null };
  // The panel's focal length and aperture fields.
  const field = id => {
    const input = { value: '', listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; } };
    inputs.set(id, input);
    return input;
  };
  const focalInput = field('lensFocalInput'), apertureInput = field('lensApertureInput');
  context.bindLensNumericParamInput('lensFocalInput', 'focal', 1, 10_000, 2);
  context.bindLensNumericParamInput('lensApertureInput', 'aperture', 0.5, 512, 2);
  const type = (input, value) => { input.value = String(value); input.listeners.change(); };
  // A field left as updateLensCorrectionUI shows its value.
  const leave = (input, key) => {
    input.value = String(Number(context.state.lensCorrection.params[key]).toFixed(2)).replace(/\.00$/, '');
    input.listeners.blur();
  };
  return {
    c: context, statuses, warnings, typeFocal: value => type(focalInput, value), typeAperture: value => type(apertureInput, value),
    leaveFocal: () => leave(focalInput, 'focal'), leaveAperture: () => leave(apertureInput, 'aperture')
  };
}

// The lens panel's search, with the photo's camera; the profile chosen from it.
const CANON_24_105 = { lensMaker: 'Canon', lensModel: 'EF 24-105mm f/4L IS USM', cameraMaker: 'Canon', cameraModel: 'Canon EOS 5D Mark III' };
const NIKKOR_60 = { lensMaker: 'Nikon', lensModel: 'AF-S Micro Nikkor 60mm f/2.8G ED', cameraMaker: 'Nikon Corporation', cameraModel: 'Nikon D850' };
function search(c, query, model) {
  c.state.lensCorrection.searchResults = c.lensfunRuntime.client.searchLenses({ ...query, searchFlags: 2 });
  c.state.lensCorrection.searchCamera = { maker: query.cameraMaker, model: query.cameraModel };
  const lens = c.state.lensCorrection.searchResults.find(result => model.test(result.model));
  assert.ok(lens, `lensfun finds ${query.lensModel}`);
  return lens;
}
const ZOOM = /^Canon EF 24-105mm f\/4L IS USM$/;
const PRIME = /^Nikkor AF-S 60 mm f\/2\.8G ED Micro$/;
const shotFile = (name, metadata) => ({ name, metadata });

// ---- Choosing a profile sets the lens, not the shot ----
{
  // A photo whose file gives 24 mm at f/8 (LibRaw's metadata).
  const { c } = editor();
  const photo = shotFile('IMG_0001.CR2');
  c.rememberShotMetadata(photo, { lensModel: 'EF24-105mm f/4L IS USM', focal: 24, aperture: 8 });
  c.state.loadedFile = photo;
  // Its recipe was made with its metadata (createDefaultSettings).
  c.applyShotMetadata(c.state.lensCorrection.params, c.shotMetadataFor(photo), { replaceUser: true });
  const lens = search(c, CANON_24_105, ZOOM);
  assert.ok(c.applyLensProfileSelection(lens));
  const params = c.state.lensCorrection.params;
  assert.equal(params.focal, 24, 'the shot\'s focal length stays (not 64.5 mm, the middle of the zoom)');
  assert.equal(params.aperture, 8, `the shot's aperture stays (not f/${lens.maxAperture}, the profile's smallest opening)`);
  assert.deepEqual(plain([params.focalSource, params.apertureSource]), ['metadata', 'metadata']);
  assert.equal(params.crop, lens.cropFactor, 'the calibration\'s crop factor, as before');
  assert.equal(c.state.lensCorrection.enabled, true);
  // The recipe names the lens, not lensfun's handle.
  const recipe = c.sanitizeLensCorrection(c.state.lensCorrection, null);
  assert.equal(recipe.selectedLens.model, 'Canon EF 24-105mm f/4L IS USM');
  assert.deepEqual(plain(recipe.selectedLens.camera), { maker: 'Canon', model: 'Canon EOS 5D Mark III' }, 'with the camera the search was narrowed to');
  assert.ok(!('handle' in recipe.selectedLens) && !JSON.stringify(recipe).includes(String(lens.handle)), 'no handle in the recipe');
  assert.equal(recipe.params.focal, 24);

  // What the user types is the photo's: kept over a profile choice, and over
  // the file's metadata, until it changes again. A field left without a
  // change types nothing.
  const typed = editor();
  typed.c.state.loadedFile = photo;
  // LibRaw's aperture of f/5.6, from its APEX value.
  typed.c.rememberShotMetadata(photo, { focal: 24, aperture: 5.656854 });
  typed.c.applyShotMetadata(typed.c.state.lensCorrection.params, typed.c.shotMetadataFor(photo), { replaceUser: true });
  typed.leaveFocal();
  typed.leaveAperture();
  assert.deepEqual(plain(typed.c.state.lensCorrection.params), { ...plain(typed.c.state.lensCorrection.params), focal: 24, aperture: 5.656854, focalSource: 'metadata', apertureSource: 'metadata' },
    'fields left as shown (5.66) type nothing: the metadata\'s values stay, unrounded');
  assert.equal(typed.c.dirty, undefined, 'nor change the photo');
  typed.typeFocal(28);
  typed.typeAperture(11);
  typed.c.applyLensProfileSelection(search(typed.c, CANON_24_105, ZOOM));
  assert.deepEqual(plain([typed.c.state.lensCorrection.params.focal, typed.c.state.lensCorrection.params.aperture]), [28, 11], 'typed values survive a profile choice');
  assert.deepEqual(plain([typed.c.state.lensCorrection.params.focalSource, typed.c.state.lensCorrection.params.apertureSource]), ['user', 'user']);
  assert.equal(typed.c.applyShotMetadata(typed.c.state.lensCorrection.params, typed.c.shotMetadataFor(photo)), false, 'and the file\'s metadata');
  const kept = typed.c.sanitizeLensCorrection(JSON.parse(JSON.stringify(typed.c.state.lensCorrection)), null);
  assert.deepEqual(plain([kept.params.focal, kept.params.focalSource, kept.params.apertureSource]), [28, 'user', 'user'], 'saved with the recipe');

  // A photo without metadata (a TIFF scan): only the focal length is
  // guessed from the profile, a prime's own; the aperture stays.
  const scan = editor();
  scan.c.state.loadedFile = shotFile('scan.tif');
  scan.c.applyLensProfileSelection(search(scan.c, NIKKOR_60, PRIME));
  assert.deepEqual(plain([scan.c.state.lensCorrection.params.focal, scan.c.state.lensCorrection.params.aperture]), [60, 8], 'the prime\'s focal length, the default aperture');
  assert.equal(scan.c.state.lensCorrection.params.focalSource, undefined, 'a guess');
  scan.c.applyLensProfileSelection(search(scan.c, CANON_24_105, ZOOM));
  assert.equal(scan.c.state.lensCorrection.params.focal, 64.5, 'another profile guesses again: the zoom\'s middle');
  // A manual lens reports no focal length (0): unknown, not 1 mm.
  const manual = editor();
  manual.c.rememberShotMetadata(manual.c.state.loadedFile = shotFile('manual.nef'), { focal: 0, aperture: 0 });
  assert.equal(manual.c.shotMetadataFor(manual.c.state.loadedFile), null);
}

// ---- The next photo's own shot; a copy keeps the receiving photo's ----
{
  const { c } = editor();
  const params = { focal: 28, aperture: 11, focalSource: 'user', apertureSource: 'user' };
  // A new photo's block carries the last one's over: its own metadata
  // replaces even typed values there (they were typed for the other photo).
  const next = { ...params };
  c.applyShotMetadata(next, { focal: 70, aperture: 5.6 }, { replaceUser: true });
  assert.deepEqual(plain(next), { focal: 70, aperture: 5.6, focalSource: 'metadata', apertureSource: 'metadata' });
  const unknown = { ...params };
  c.applyShotMetadata(unknown, null, { replaceUser: true });
  assert.deepEqual(plain(unknown), params, 'without metadata the carried values stay');
  // Apply to selected / the roll reference: the lens and its modes are
  // copied, the receiving photo keeps its focal length and aperture.
  const donor = { enabled: true, selectedLens: { maker: 'Canon', model: 'Canon EF 24-105mm f/4L IS USM' }, params: { focal: 24, aperture: 8, crop: 1, focalSource: 'metadata', apertureSource: 'metadata' }, modes: {} };
  const receiver = { params: { focal: 105, aperture: 4, focalSource: 'metadata', apertureSource: 'user' } };
  const copied = c.withReceivingShot(donor, receiver, null);
  assert.deepEqual(plain([copied.params.focal, copied.params.aperture, copied.params.crop]), [105, 4, 1], 'its own shot');
  assert.equal(copied.selectedLens, donor.selectedLens, 'the donor\'s lens');
  assert.deepEqual(c.withReceivingShot(donor, null, { focal: 50, aperture: 2.8 }).params.focal, 50, 'its file\'s metadata where it had none');
  const typedDonor = { ...donor, params: { ...donor.params, focal: 35, focalSource: 'user' } };
  assert.equal(c.withReceivingShot(typedDonor, receiver, { focal: 50 }).params.focal, 35, 'a typed focal length is copied as typed');
}

// ---- Recipes keep the profile's identity ----
{
  const { c } = editor();
  const legacy = { handle: 2741040, maker: 'Canon', model: 'Canon EF 24-105mm f/4L IS USM', score: 87, minFocal: 24, maxFocal: 105, minAperture: 4, maxAperture: 22, cropFactor: 1 };
  assert.deepEqual(plain(c.sanitizeLensSelection(legacy)), { maker: 'Canon', model: 'Canon EF 24-105mm f/4L IS USM', minFocal: 24, maxFocal: 105, minAperture: 4, maxAperture: 22, cropFactor: 1, camera: null },
    'an older recipe\'s profile: its name, without the handle and score');
  assert.equal(c.sanitizeLensSelection({ handle: 2741040 }), null, 'a handle alone names no lens');
  const block = c.sanitizeLensCorrection({ enabled: true, selectedLens: { handle: 2741040 }, params: { focal: 24 } }, null);
  assert.equal(block.selectedLens, null);
  assert.equal(c.lensCorrectionActive({ lensCorrection: block }), false, 'nothing to correct with');
  // Sources travel with their values.
  const sourced = c.sanitizeLensCorrection({ params: { focal: 24, focalSource: 'metadata', aperture: 8, apertureSource: 'guess' } }, null);
  assert.deepEqual([sourced.params.focalSource, sourced.params.apertureSource ?? null], ['metadata', null]);
  const fromFallback = c.sanitizeLensCorrection({ params: {} }, { params: { focal: 35, focalSource: 'user' } });
  assert.deepEqual(plain([fromFallback.params.focal, fromFallback.params.focalSource]), [35, 'user'], 'a fallback\'s value with its source');
  assert.equal(c.sanitizeLensCorrection({ params: { focal: 50 } }, { params: { focal: 35, focalSource: 'user' } }).params.focalSource, undefined, 'not with another value');
  // The display-proxy key: the identity, not the handle, nor the sources.
  const a = c.sanitizeLensCorrection({ enabled: true, selectedLens: legacy, params: { focal: 24, focalSource: 'metadata' } }, null);
  const b = c.sanitizeLensCorrection({ enabled: true, selectedLens: { ...legacy, handle: 917504 }, params: { focal: 24, focalSource: 'user' } }, null);
  assert.equal(c.lensSignatureOf(a), c.lensSignatureOf(b));
  assert.ok(!c.lensSignatureOf(a).includes('2741040'));
}

// ---- A saved recipe reopens with the same correction; an old one without
// the lens's name, or with a name this build lacks, asks for the profile
// again and the frame converts uncorrected ----
{
  const frame = (width = 120, height = 80) => {
    const data16 = new Uint16Array(width * height * 4);
    for (let i = 0; i < data16.length; i += 4) {
      data16[i] = (i * 7) % 65536; data16[i + 1] = (i * 13) % 65536; data16[i + 2] = (i * 31) % 65536; data16[i + 3] = 65535;
    }
    const image = new ImageData(Uint8ClampedArray.from(data16, v => v >>> 8), width, height);
    image.__image16 = { width, height, data: data16 };
    return image;
  };
  const bytes = image => Buffer.from(image.__image16.data.buffer, image.__image16.data.byteOffset, image.__image16.data.byteLength);

  // The recipe a profile choice leaves, saved as JSON.
  const chose = editor();
  chose.c.state.loadedFile = shotFile('IMG_0002.CR2');
  chose.c.rememberShotMetadata(chose.c.state.loadedFile, { focal: 24, aperture: 8 });
  chose.c.applyShotMetadata(chose.c.state.lensCorrection.params, chose.c.shotMetadataFor(chose.c.state.loadedFile), { replaceUser: true });
  chose.c.applyLensProfileSelection(search(chose.c, CANON_24_105, ZOOM));
  const saved = JSON.parse(JSON.stringify({ lensCorrection: chose.c.sanitizeLensCorrection(chose.c.state.lensCorrection, null) }));
  const input = frame();
  const original = await chose.c.applyLensCorrectionWithSettings(input, chose.c.state, { updateUi: true });

  // Reopened: after a restart (another module of the same build), and in a
  // build whose handles differ.
  const restarted = editor((await lensfunNodeClient()).client);
  const elsewhere = editor(relocated((await lensfunNodeClient()).client));
  for (const [label, { c, statuses }] of [['after a restart', restarted], ['in another build', elsewhere]]) {
    const output = await c.applyLensCorrectionWithSettings(input, saved, { updateUi: true });
    if (makesMaps) {
      assert.notEqual(output, input, `${label}: corrected`);
      assert.ok(bytes(output).equals(bytes(original)), `${label}: the same correction, byte for byte`);
      assert.equal(statuses.at(-1), 'lensStatusApplied');
    } else {
      // lensfun-wasm 0.1.3 builds no maps: the lens is found, the maps fail.
      assert.equal(output, input, `${label}: uncorrected (0.1.3)`);
      assert.equal(statuses.at(-1), 'lensStatusApplyFailed', `${label}: the lens is found, its maps fail`);
    }
  }
  if (makesMaps) assert.notEqual(original, input, 'the original choice corrected the frame');

  // An older recipe: the handle of the build that saved it, and the name.
  const legacyLens = chose.c.state.lensCorrection.searchResults.find(result => ZOOM.test(result.model));
  const legacy = { lensCorrection: { ...saved.lensCorrection, selectedLens: { ...legacyLens, score: 87 } } };
  {
    const { c, statuses } = elsewhere;
    const output = await c.applyLensCorrectionWithSettings(input, legacy, { updateUi: true });
    if (makesMaps) {
      assert.ok(bytes(output).equals(bytes(original)), 'an older recipe with the lens\'s name: found by it, the same correction');
      assert.equal(statuses.at(-1), 'lensStatusApplied', 'its lens is found by name');
    } else {
      // lensfun-wasm 0.1.3 searches one camera's mount when no camera is
      // named, and older recipes name none: the profile is chosen again
      // (whose maps 0.1.3 cannot build either).
      assert.equal(output, input);
      assert.equal(statuses.at(-1), 'lensStatusNeedProfile', 'not found without a camera (0.1.3)');
    }
  }
  // A handle alone, or a lens this build has no entry for: "select a lens
  // profile", the frame as it is, a warning instead of silence.
  for (const [label, selectedLens] of [
    ['a handle alone', { handle: legacyLens.handle }],
    ['a lens this build lacks', { ...saved.lensCorrection.selectedLens, model: 'Canon EF 24-105mm f/4L IS USM III' }]
  ]) {
    const { c, statuses, warnings } = editor(relocated((await lensfunNodeClient()).client));
    const recipe = { lensCorrection: { ...saved.lensCorrection, selectedLens } };
    const output = await c.applyLensCorrectionWithSettings(input, recipe, { updateUi: true });
    assert.equal(output, input, `${label}: uncorrected`);
    assert.equal(statuses.at(-1), 'lensStatusNeedProfile', `${label}: the panel asks for the profile again`);
    if (label === 'a lens this build lacks') {
      assert.match(warnings.join('\n'), /Lens correction skipped: lensfun has no profile Canon Canon EF 24-105mm f\/4L IS USM III/);
      assert.match(c.state.lensCorrection.lastError, /no profile/);
      // Looked up once: the next frame does not search again.
      const searches = [];
      const counting = c.lensfunRuntime.client.searchLenses;
      c.lensfunRuntime.client.searchLenses = query => { searches.push(query); return counting(query); };
      await c.applyLensCorrectionWithSettings(input, recipe, { updateUi: false });
      assert.equal(searches.length, 0, 'resolved once a session');
      assert.equal(warnings.filter(line => /no profile/.test(line)).length, 1, 'and reported once');
    }
  }
}

console.log(`lensProfiles: lensfun-wasm ${version}: a profile choice keeps the photo's focal length and aperture (metadata or typed), recipes keep the profile's identity, a saved recipe reopens with ${makesMaps ? 'the same correction' : 'its lens found (0.1.3 builds no maps)'} after a restart and in a build with other handles, and older recipes without a findable name ask for the profile again`);
