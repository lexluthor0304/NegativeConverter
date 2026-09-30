import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { getSprocketFrameLayout } from './sprocketFrame.js';
import { photoRectPercent, step3FrameReference } from './displayCanvas.js';
import { photoViewport } from '../render/borderUnderlay.js';

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
  const context = vm.createContext({ state, webglState });
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
    displayDebugCounters: { glBorderComposes: 0 },
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
    'releaseGlBorder', 'displayFrameReference', 'conversionSourceSize'].map(functionSource).join('\n'), context);
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
  context.glBorder.smearToken++;
  context.drawGlBorder({}, 900, 600, framed.layout);
  assert.equal(composeCalls.length, 3);
  assert.equal(composeCalls[2].photo, adjusted, 'the smear samples the settled adjusted frame');
  // Fonts loading compose again; a frame without the border drops it all.
  context.glBorder.generation++;
  context.drawGlBorder({}, 900, 600, framed.layout);
  assert.equal(composeCalls.length, 4);
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
}

// ---- the overlay layer ----
{
  const shown = new TestImageData(1200, 800);
  const style = {};
  const overlay = { width: 1, height: 1, style, paints: 0, getContext: () => ({ clearRect: () => { overlay.paints++; }, drawImage: () => {}, save() {}, restore() {}, beginPath() {}, arc() {}, fill() {}, moveTo() {}, lineTo() {}, stroke() {} }) };
  const state = {
    cropping: false, currentStep: 3, processedImageData: { width: 4800, height: 3200 }, sprocketPreviewEnabled: false,
    dustRemoval: { showMask: true, mask: new Uint8Array(4), revision: 1, brushSize: 5 }, dodgeBurn: { active: false, showOverlay: true, mode: 'dodge', size: 12 },
    localExposure: null
  };
  const ids = new WeakMap(); let next = 1;
  const tint = { width: 0, height: 0 };
  const context = vm.createContext({
    state, JSON, displayOverlay: overlay, displayOverlayState: { key: null, frame: 0, placed: '' },
    dodgeBurnDrawing: false, dodgeBurnPoints: [], dustDrawing: false, dustBrushPoints: [], dustBrushMode: 'intelligent',
    displayDebugCounters: { overlayPaints: 0 }, displaySourceImageData: () => shown,
    getSprocketFrameLayout, getSprocketFrameComposeOptions: () => ({ edgeMarkings: {} }), photoRectPercent,
    gpuObjectId: object => { if (!ids.has(object)) ids.set(object, next++); return ids.get(object); },
    dodgeBurnGeometry: () => ({ rotation: 0 }), basePointToWorking: p => p,
    getDustMaskOverlayCanvas: (w, h) => { Object.assign(tint, { width: w, height: h }); return {}; },
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
  });
  vm.runInContext(['displayOverlayPlan', 'displayOverlayKey', 'paintDisplayOverlay', 'syncDisplayOverlay', 'releaseDisplayOverlay',
    'drawDustBrushDots', 'drawDodgeBurnPath', 'renderDodgeBurnOverlay'].map(functionSource).join('\n'), context);
  context.syncDisplayOverlay();
  assert.deepEqual([overlay.width, overlay.height], [1200, 800], 'the backing is the display photo, never the image');
  assert.deepEqual([tint.width, tint.height], [1200, 800], 'and so is the tint layer');
  assert.equal(style.display, 'block');
  assert.deepEqual([style.left, style.top, style.width, style.height], ['0px', '0px', '100%', '100%']);
  const paints = context.displayDebugCounters.overlayPaints;
  for (let i = 0; i < 5; i++) context.syncDisplayOverlay();
  assert.equal(context.displayDebugCounters.overlayPaints, paints, 'an unchanged overlay is not repainted on every photo frame');
  state.dustRemoval.revision++;
  context.syncDisplayOverlay();
  assert.equal(context.displayDebugCounters.overlayPaints, paints + 1, 'a patched mask repaints it');
  // The border: over the photo's rectangle.
  state.sprocketPreviewEnabled = true;
  context.syncDisplayOverlay();
  const box = photoRectPercent(getSprocketFrameLayout(1200, 800, { edgeMarkings: {} }));
  assert.deepEqual([style.left, style.top, style.width, style.height], [box.left, box.top, box.width, box.height]);
  // A live stroke repaints every time and leaves no key behind.
  context.dustDrawing = true;
  context.dustBrushPoints = [{ x: 10, y: 10 }];
  const before = context.displayDebugCounters.overlayPaints;
  context.syncDisplayOverlay();
  context.syncDisplayOverlay();
  assert.equal(context.displayDebugCounters.overlayPaints, before + 2);
  context.dustDrawing = false;
  context.syncDisplayOverlay();
  assert.equal(context.displayDebugCounters.overlayPaints, before + 3, 'the stroke end repaints without it');
  // Nothing to show: hidden, and the backing goes.
  state.dustRemoval.showMask = false;
  context.syncDisplayOverlay();
  assert.equal(style.display, 'none');
  assert.deepEqual([overlay.width, overlay.height], [1, 1]);
  // Cropping hides it.
  state.dustRemoval.showMask = true;
  state.cropping = true;
  assert.equal(context.displayOverlayPlan(), null);
}

console.log('displayModesWiring: the GL gate keeps only its three exclusions and the mode readiness, the border underlay composes once per key and lags the smear by a settle, the overlay is display-sized over the photo and repaints only on change');
