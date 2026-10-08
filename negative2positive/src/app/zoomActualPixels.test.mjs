import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { computeZoomGeometry, clampPanValues } from './zoomGeometry.js';
import { step3FrameReference, upscaleReference } from './displayCanvas.js';

// #248 part 1: a true 1:1 in the app itself. The fit, zoom and settle-hook
// functions of main.js (extracted with vm) against stand-in elements.
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `runtime function exists: ${name}`);
  const end = source.indexOf('\n    }', match.index);
  return source.slice(match.index, end + '\n    }'.length);
}
function constSource(name) {
  const match = new RegExp(`^    const ${name} = [^\\n]*\\n`, 'm').exec(source);
  assert.ok(match, `runtime constant exists: ${name}`);
  return match[0];
}

function element() {
  return { style: {}, classList: { add() {}, remove() {} }, textContent: '' };
}

function fixture({ source: size = { width: 9536, height: 6336 }, container = { width: 1110, height: 700 }, dpr = 2 } = {}) {
  let nextTimer = 1;
  const timers = new Map();
  const conversionSource = { ...size, name: 'conversion source' };
  const state = {
    zoomLevel: 1, panX: 0, panY: 0, isPanning: false, cropping: false, currentStep: 3,
    processedImageData: { width: 1809, height: 1202 }, processedImageDataIsPreview: true,
    conversionSourceImageData: conversionSource, sprocketPreviewEnabled: false
  };
  const refreshed = [];
  const detailDelays = [];
  const wrapper = element();
  const context = vm.createContext({
    state, window: { devicePixelRatio: dpr }, Math, Number, parseFloat,
    canvas: element(), glCanvas: element(), cropCanvas: element(), canvasTransformWrapper: wrapper, zoomIndicator: element(),
    canvasContainer: {
      ...element(),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: container.width, height: container.height })
    },
    uiDebugCounters: { adjustCanvasDisplay: 0 },
    getCanvasContainerSize: () => container,
    getSprocketFrameMetrics: () => null, getSprocketFrameComposeOptions: () => ({}),
    // The Step-3 box reference of #242.
    step3FrameReference, upscaleReference,
    computeZoomGeometry, clampPanValues, interimGeometryCss: () => '',
    postponeFullResolutionRenderForInteraction: () => {},
    // The detail layer (#248 part 5) follows zoom and pan on its own; a
    // discrete step asks for its region at once (#270).
    noteDetailViewChanged: (delay) => detailDelays.push(delay), dropDetailLayer: () => {},
    DETAIL_SETTLE_MS: 100, DETAIL_STEP_SETTLE_MS: 0,
    // A brush stroke follows zoom and pan on the overlay (#254).
    brushFeedback: { drawing: false }, remapBrushStroke: () => {},
    refreshDisplayPreviewForViewport: () => refreshed.push(state.conversionSourceImageData),
    setTimeout: (callback, delay) => { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext([
    constSource('ZOOM_MIN'), constSource('ZOOM_MAX_FIT'), constSource('ZOOM_DOUBLE_CLICK_FACTOR'),
    'const canvasDisplayFit = { w: 0, h: 0, containerW: 0, containerH: 0, zoom: 0, dpr: 0, scale: 0 };',
    'let displayPreviewResizeTimer = null;',
    ...['getFullResDisplayReference', 'displayFrameReference', 'conversionSourceSize', 'adjustCanvasDisplay', 'actualPixelsZoom', 'zoomMax', 'zoomIndicatorText',
      'applyZoomPanTransform', 'getZoomGeometry', 'clampPan', 'resetZoomPan', 'resetUserZoom',
      'toggleActualPixels', 'zoomAtPoint', 'scheduleDisplayPreviewResize'].map(functionSource)
  ].join('\n'), context);
  const runTimers = () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); } };
  // The first draw fits the stand-in texture against the full-resolution reference.
  context.adjustCanvasDisplay(1809, 1202);
  return { context, state, wrapper, refreshed, timers, runTimers, container, conversionSource, detailDelays };
}

const cssWidth = f => parseFloat(f.wrapper.style.width);

for (const container of [{ width: 1110 - 300, height: 700 - 100 }, { width: 1440 - 300, height: 900 - 100 }, { width: 1110, height: 700 }]) {
  for (const dpr of [1, 2]) {
    const f = fixture({ container, dpr });
    // CSS pixels per image pixel at zoom 1, against the full-resolution frame.
    const fit = Math.min((container.width - 20) / 9536, (container.height - 20) / 6336, 1);
    // #279: the box is the nearest whole CSS pixels, the size the compositor
    // shows a canvas at, so its client rect is where the photo is drawn.
    assert.deepEqual([f.wrapper.style.width, f.wrapper.style.height], [`${Math.round(9536 * fit)}px`, `${Math.round(6336 * fit)}px`]);
    assert.deepEqual([f.context.glCanvas.style.width, f.context.glCanvas.style.height], [f.wrapper.style.width, f.wrapper.style.height]);
    assert.ok(Number.isInteger(cssWidth(f)) && Math.abs(cssWidth(f) - 9536 * fit) <= 0.5);
    const zoom100 = Math.max(1, 1 / (fit * dpr));
    assert.ok(Math.abs(f.context.actualPixelsZoom() - zoom100) < 1e-9, 'zoom100 = max(1, 1 / (fit x DPR))');
    // 200 % of native is reachable.
    assert.ok(f.context.zoomMax() >= 2 * zoom100 - 1e-9);
    f.context.zoomAtPoint(1000, 100, 100);
    assert.equal(f.detailDelays.at(-1), 100, 'a wheel or pinch tick lets the detail layer settle');
    assert.ok(Math.abs(f.state.zoomLevel - 2 * zoom100) < 1e-9, `max zoom is 200 % of native (${JSON.stringify(container)} @${dpr})`);
    assert.equal(f.context.zoomIndicatorText(), '200%');
    f.context.resetZoomPan();

    // "1:1" from fit: one image pixel per device pixel, centred on the view.
    f.context.toggleActualPixels();
    assert.equal(f.detailDelays.at(-1), 0, '1:1 is a step: the detail layer asks at once (#270)');
    assert.ok(Math.abs(f.state.zoomLevel - zoom100) < 1e-9, '1:1 reaches true 100 %');
    assert.equal(f.context.zoomIndicatorText(), '100%', 'the indicator reads 100 % at true 100 %');
    const geometry = f.context.getZoomGeometry();
    const centreX = (container.width / 2 - geometry.baseX - f.state.panX) / f.state.zoomLevel;
    assert.ok(Math.abs(centreX - cssWidth(f) / 2) < 1e-6, 'the view centre stays on the image centre');
    // ...and back to fit, whose resize settles now (not in the next tick).
    f.context.toggleActualPixels();
    assert.equal(f.state.zoomLevel, 1, '1:1 toggles back to fit');
    assert.equal(f.timers.size, 1, 'the user reset re-arms the settle hook (debounced with the zooms)');
    f.runTimers();
    assert.equal(f.refreshed.length, 1, 'the settle hook runs once, after the reset');
  }
}

// A small image already at 1:1 when fitted: nothing to toggle, max stays 8x.
{
  const f = fixture({ source: { width: 600, height: 400 }, dpr: 1 });
  f.state.processedImageData = { width: 600, height: 400 };
  f.state.processedImageDataIsPreview = false;
  f.context.adjustCanvasDisplay(600, 400);
  assert.equal(f.context.actualPixelsZoom(), 1);
  assert.equal(f.context.zoomMax(), 8);
  f.context.toggleActualPixels();
  assert.equal(f.state.zoomLevel, 1);
}

// The settle hook records the source: a photo switch, rotate or crop right
// after a zoom reset resamples nothing of the outgoing source.
{
  const f = fixture();
  f.context.zoomAtPoint(3, 200, 200);
  f.context.resetUserZoom();
  f.state.conversionSourceImageData = { width: 6000, height: 4000, name: 'next photo' };
  f.runTimers();
  assert.equal(f.refreshed.length, 0, 'the outgoing source is never resampled');
  // resetZoomPan itself (photo switch, rotate, mirror, crop) schedules nothing.
  f.context.zoomAtPoint(3, 200, 200);
  f.timers.clear();
  f.context.resetZoomPan();
  assert.equal(f.timers.size, 0);
  // A reset at fit has nothing to settle.
  f.context.resetUserZoom();
  assert.equal(f.timers.size, 0);
}

console.log('zoomActualPixels: whole-pixel box, true 1:1 toggle, image-relative indicator, 200 % reachable, source-checked settle hook');
