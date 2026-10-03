import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { getSprocketFrameLayout } from './sprocketFrame.js';
import { photoRectPercent, step3FrameReference } from './displayCanvas.js';
import { photoViewport } from '../render/borderUnderlay.js';
import { displayModesSupported } from '../render/previewTables.js';

// #253 in main.js (extracted with vm): the GL gate keeps only cropping, WebGL
// off, a missing or failed context and a look or rescue before the mode
// programs are ready; the border is a GL underlay composed once per key; the
// overlay layer is display-sized, placed over the photo and repainted only
// when what it shows changed.
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `runtime function exists: ${name}`);
  const end = source.indexOf('\n    }', match.index);
  return source.slice(match.index, end + '\n    }'.length);
}
class TestImageData {
  constructor(a, b, c) {
    if (typeof a === 'number') Object.assign(this, { width: a, height: b, data: new Uint8ClampedArray(a * b * 4) });
    else Object.assign(this, { data: a, width: b, height: c });
  }
}

// ---- the gate ----
{
  const state = { cropping: false, coreUseWebGL: true, currentStep: 3, processedImageData: {}, look: null, expiredEnabled: false,
    expiredAnalysis: null, sprocketPreviewEnabled: false, dodgeBurn: { active: false }, dustRemoval: { enabled: false, showMask: false } };
  const webglState = { gl: {}, disabledByError: false, modesReady: false };
  const context = vm.createContext({ state, webglState, displayModesSupported });
  vm.runInContext(['displayModesNeeded', 'isWebGLActive'].map(functionSource).join('\n'), context);
  const active = () => context.isWebGLActive();
  assert.equal(active(), true);
  // The border, the dodge tool and a shown mask no longer leave the GPU.
  Object.assign(state, { sprocketPreviewEnabled: true, dodgeBurn: { active: true }, dustRemoval: { enabled: true, showMask: true } });
  assert.equal(active(), true, 'border, dodge tool and shown mask stay on the GL display');
  // A look or a rescue with an analysis needs the mode programs.
  state.look = { matrix: [] };
  assert.equal(active(), false, 'a look waits for the mode programs');
  webglState.modesReady = true;
  assert.equal(active(), true, 'and draws on the GPU once they are ready');
  Object.assign(state, { vibrance: 35, wbR: 1, wbG: 1, wbB: 1 });
  assert.equal(active(), false, 'identity WB plus vibrance uses the exact CPU display even with linked modes');
  state.wbR = 1.06;
  assert.equal(active(), true, 'supported modes keep their GL path');
  state.vibrance = 0;
  state.wbR = 1;
  state.look = null;
  webglState.modesReady = false;
  state.expiredEnabled = true;
  assert.equal(active(), true, 'a rescue without an analysis needs nothing');
  state.expiredAnalysis = {};
  assert.equal(active(), false);
  webglState.modesReady = true;
  assert.equal(active(), true);
  // The three remaining exclusions.
  state.cropping = true;
  assert.equal(active(), false);
  state.cropping = false;
  state.coreUseWebGL = false;
  assert.equal(active(), false);
  state.coreUseWebGL = true;
  webglState.disabledByError = true;
  assert.equal(active(), false);
  webglState.disabledByError = false;
  webglState.gl = null;
  assert.equal(active(), false);
}

// ---- the border underlay ----
{
  const composeCalls = [];
  const underlayState = { key: null, draws: [] };
  const state = { sprocketPreviewEnabled: true, webglSourceImageData: new TestImageData(900, 600),
    processedImageData: { width: 3600, height: 2400 }, processedImageDataIsPreview: false };
  const edge = { overexposedSprockets: false, text: 'KODAK' };
  const context = vm.createContext({
    state, ImageData: TestImageData, JSON, glCanvas: { width: 0, height: 0 },
    glBorder: { photo: null, generation: 0, smear: null, smearToken: 0, smearFlight: 0 },
    webglState: { borderUnderlay: null },
    displayDebugCounters: { glBorderComposes: 0 }, displaySourceImageData: () => state.webglSourceImageData,
    liveHistoryRoots: () => [], settledAdjustedBuffer: null, previewAdjustedBuffer: null, parkedPhoto: null,
    getSprocketFrameLayout, photoViewport, step3FrameReference,
    getSprocketFrameComposeOptions: () => ({ edgeMarkings: { ...edge } }),
    prepareSprocketPreviewFont: () => {}, areSprocketFrameFontsReady: () => true,
    composeSprocketFrameBackground: (photo, options) => {
      composeCalls.push({ photo, smear: options.edgeMarkings.overexposedSprockets });
      const layout = getSprocketFrameLayout(photo.width, photo.height, options);
      return new TestImageData(layout.frameWidth, layout.frameHeight);
    },
    createBorderUnderlay: () => ({
      key: () => underlayState.key, size: () => ({ width: 1, height: 1 }),
      upload: (image, key) => { underlayState.key = key; underlayState.image = image; },
      draw: (width, height) => underlayState.draws.push([width, height]),
      release: () => { underlayState.key = null; }
    }),
  });
  vm.runInContext(['sprocketFrameSize', 'sprocketFrameReference', 'glFrameSize', 'glBorderSmearSource', 'drawGlBorder', 'dropGlBorder',
    'releaseGlBorder', 'displayFrameReference', 'conversionSourceSize', 'openPhotoMemoryRoots'].map(functionSource).join('\n'), context);
  const framed = context.glFrameSize(900, 600);
  const layout = getSprocketFrameLayout(900, 600, { edgeMarkings: edge });
  assert.deepEqual([framed.width, framed.height], [layout.frameWidth, layout.frameHeight], 'the buffer is the framed display size');
  // The CSS box fits the drawn frame scaled by full / display, as fitStep3CanvasBox
  // fits the 2D display: the same aspect as the buffer, so no letterbox.
  assert.deepEqual([framed.reference.width, framed.reference.height], [layout.frameWidth * 4, layout.frameHeight * 4]);
  Object.assign(context.glCanvas, { width: framed.width, height: framed.height });
  const viewport = context.drawGlBorder({}, 900, 600, framed.layout);
  assert.deepEqual(viewport, photoViewport(layout, framed.width, framed.height), 'pass 2 draws into the photo rectangle');
  assert.equal(composeCalls.length, 1);
  assert.equal(composeCalls[0].photo, state.webglSourceImageData, 'no blank frame is allocated when one of the size is at hand');
  // A drag (the same key) composes nothing and draws the kept background.
  for (let i = 0; i < 5; i++) context.drawGlBorder({}, 900, 600, framed.layout);
  assert.equal(composeCalls.length, 1);
  assert.equal(underlayState.draws.length, 6);
  // Overexposed sprockets: the smear keeps the last background until a settle
  // brings an adjusted frame (smearToken), then composes from that frame.
  edge.overexposedSprockets = true;
  context.drawGlBorder({}, 900, 600, framed.layout);
  assert.equal(composeCalls.length, 2);
  for (let i = 0; i < 3; i++) context.drawGlBorder({}, 900, 600, framed.layout);
  assert.equal(composeCalls.length, 2, 'the smear lags a drag');
  const adjusted = new TestImageData(900, 600);
  context.glBorder.smear = adjusted;
  context.glBorder.smearSource = state.webglSourceImageData;
  context.glBorder.smearToken++;
  context.drawGlBorder({}, 900, 600, framed.layout);
  assert.equal(composeCalls.length, 3);
  assert.equal(composeCalls[2].photo, adjusted, 'the smear samples the settled adjusted frame');
  assert.ok(context.openPhotoMemoryRoots().includes(adjusted), 'the retained smear is counted by the open photo ledger');
  assert.ok(context.openPhotoMemoryRoots().includes(state.webglSourceImageData), 'the smear source identity also holds pixels');
  // Fonts loading compose again; a frame without the border drops it all.
  context.glBorder.generation++;
  context.drawGlBorder({}, 900, 600, framed.layout);
  assert.equal(composeCalls.length, 4);
  const previousToken = context.glBorder.smearToken;
  state.webglSourceImageData = new TestImageData(900, 600);
  assert.equal(context.glBorderSmearSource(900, 600), null, 'a same-size photo never borrows the previous smear');
  assert.equal(context.glBorder.smear, null, 'previous photo pixels are released');
  assert.ok(context.glBorder.smearToken > previousToken);
  state.sprocketPreviewEnabled = false;
  assert.equal(context.glFrameSize(900, 600).layout, null);
  context.dropGlBorder();
  assert.equal(context.glBorder.photo, null);
  assert.equal(context.glBorder.smear, null);
  assert.equal(underlayState.key, null, 'the background texture is released');
  // Portrait: the frame is taller than wide, the photo inset from the sides.
  state.sprocketPreviewEnabled = true;
  const portrait = context.glFrameSize(600, 900);
  assert.ok(portrait.height > portrait.width && portrait.layout.x > 0 && portrait.layout.width === 600);
  // Between activation and the incoming texture upload, the old GL source
  // can have the new photo's dimensions. It cannot supply even a raw smear.
  const outgoingTexture = state.webglSourceImageData;
  const incoming = new TestImageData(900, 600);
  context.displaySourceImageData = () => incoming;
  context.drawGlBorder({}, 900, 600, framed.layout);
  assert.notEqual(composeCalls.at(-1).photo, outgoingTexture, 'old texture pixels cannot smear the incoming photo');
}

// ---- the overlay layer ----
{
  const { buildDustTint, buildDustTintRect, buildDustTintInBands } = await import('./dustTint.js');
  const { strokeBrush, basePointToWorking } = await import('./localExposure.js');
  const shown = new TestImageData(1200, 800);
  const style = {};
  const overlay = { width: 1, height: 1, style, getContext: () => ({ clearRect() {}, putImageData() {}, save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} }) };
  const mask = new Uint8Array(4800 * 3200);
  mask[1000 * 4800 + 2000] = 255;
  const state = {
    cropping: false, beforeAfterActive: false, currentStep: 3, processedImageData: { width: 4800, height: 3200 }, sprocketPreviewEnabled: false,
    dustRemoval: { showMask: true, mask, maskTag: 1, brushSize: 5 }, dodgeBurn: { active: false, showOverlay: true },
    localExposure: null
  };
  const ids = new WeakMap(); let next = 1;
  const geometry = { baseWidth: 4800, baseHeight: 3200, rotatedWidth: 4800, rotatedHeight: 3200, rotationAngle: 0, mirrored: false, cropRegion: null };
  const context = vm.createContext({
    state, JSON, Math, Boolean, console, ImageData: TestImageData, displayOverlay: overlay,
    displayOverlayState: { key: null, placed: '', plan: null, tint: null, counters: { tintRects: 0, bandedBuilds: 0, workerTints: 0 } },
    dustTint: { mask: null, tag: null, width: 0, height: 0, image: null, building: null },
    displayDebugCounters: { overlayPaints: 0 }, displaySourceImageData: () => shown, getDisplayPreviewSize: () => ({ width: 1200, height: 800 }),
    getSprocketFrameLayout, getSprocketFrameComposeOptions: () => ({ edgeMarkings: {} }), photoRectPercent,
    gpuObjectId: object => { if (!ids.has(object)) ids.set(object, next++); return ids.get(object); },
    dodgeBurnGeometry: () => ({ ...geometry, width: 4800, height: 3200 }), localExposureGeometryFor: () => geometry,
    strokeBrush, basePointToWorking, buildDustTintRect, buildDustTintInBands, yieldTaskForJob: async () => {},
  });
  vm.runInContext(['displayOverlaySize', 'dustTintWanted', 'dodgeStrokesWanted', 'dustTintCurrent', 'adoptDustTint', 'patchDustTint',
    'ensureDustTint', 'displayOverlayPlan', 'displayOverlayKey', 'paintDisplayOverlay', 'syncDisplayOverlay', 'releaseDisplayOverlay',
    'renderDodgeBurnOverlay'].map(functionSource).join('\n'), context);
  context.adoptDustTint(mask, 1, { width: 1200, height: 800, rgba: buildDustTint(mask, 4800, 3200, 1200, 800) });
  context.syncDisplayOverlay();
  assert.deepEqual([overlay.width, overlay.height], [1200, 800], 'the backing is the display photo, never the image');
  assert.deepEqual([context.dustTint.width, context.dustTint.height], [1200, 800], 'and so is the tint');
  assert.equal(style.display, 'block');
  assert.deepEqual([style.left, style.top, style.width, style.height], ['0px', '0px', '100%', '100%']);
  const paints = context.displayDebugCounters.overlayPaints;
  for (let i = 0; i < 5; i++) context.syncDisplayOverlay();
  assert.equal(context.displayDebugCounters.overlayPaints, paints, 'an unchanged overlay is not repainted on every photo frame');
  // A mask with a new tag: pooled in bands, then painted once.
  state.dustRemoval.maskTag = 2;
  context.syncDisplayOverlay();
  for (let i = 0; i < 50 && !context.dustTintCurrent({ width: 1200, height: 800 }); i++) await new Promise(resolve => setImmediate(resolve));
  context.syncDisplayOverlay();
  assert.equal(context.displayOverlayState.counters.bandedBuilds, 1);
  assert.ok(context.displayDebugCounters.overlayPaints >= paints + 1, 'a new mask repaints it');
  const settled = context.displayDebugCounters.overlayPaints;
  context.syncDisplayOverlay();
  assert.equal(context.displayDebugCounters.overlayPaints, settled);
  // The border: over the photo's rectangle.
  state.sprocketPreviewEnabled = true;
  context.syncDisplayOverlay();
  const box = photoRectPercent(getSprocketFrameLayout(1200, 800, { edgeMarkings: {} }));
  assert.deepEqual([style.left, style.top, style.width, style.height], [box.left, box.top, box.width, box.height]);
  // Nothing to show: hidden, and the backing goes.
  state.dustRemoval.showMask = false;
  context.syncDisplayOverlay();
  assert.equal(style.display, 'none');
  assert.deepEqual([overlay.width, overlay.height], [1, 1]);
  // Cropping and the comparison hide it.
  state.dustRemoval.showMask = true;
  state.cropping = true;
  assert.equal(context.displayOverlayPlan(), null);
  state.cropping = false;
  state.beforeAfterActive = true;
  assert.equal(context.displayOverlayPlan(), null);
}

console.log('displayModesWiring: the GL gate keeps only its three exclusions and the mode readiness, the border underlay composes once per key and lags the smear by a settle, the overlay is display-sized over the photo and repaints only on change');

// Software GL stays on the CPU unless deliberately forced in a driver test.
for (const forced of [false, true]) {
  let compiled = 0;
  const renderer = { gl: {}, startModesCompile: () => compiled++, modesStatus: () => 'pending' };
  const displayModes = { renderer, status: 'none' };
  const context = vm.createContext({ displayModes, webglState: { renderer2: renderer, renderer: { software: true } },
    GPU_PREVIEW_MODE: forced ? 'force' : 'auto', webgl2PrecisionOk: () => true,
    failDisplayModes: (reason, status) => { displayModes.status = status; },
    requestAnimationFrame() {}, scheduleDisplayModesWarmup() {}, resetDisplayModes() {} });
  vm.runInContext(functionSource('warmUpDisplayModes'), context);
  context.warmUpDisplayModes();
  assert.equal(displayModes.status, forced ? 'compiling' : 'unsupported');
  assert.equal(compiled, forced ? 1 : 0);
}
