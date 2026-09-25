// #242 in main.js itself: the real display and export functions, extracted
// with vm as restartRender.test.mjs does, against counting stand-ins.
// node negative2positive/src/app/displayPath.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `runtime function exists: ${name}`);
  const end = source.indexOf('\n    }', match.index);
  assert.ok(end > match.index, `runtime function closes: ${name}`);
  return source.slice(match.index, end + '\n    }'.length);
}
const noop = () => {};
const settle = () => new Promise(setImmediate);

class TestImageData {
  constructor(data, width, height) {
    if (!(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) throw new TypeError('bad ImageData');
    Object.assign(this, { data, width, height });
  }
}
function image(width, height, fill = 0) {
  const data = new Uint8ClampedArray(width * height * 4).fill(fill);
  return new TestImageData(data, width, height);
}

// ---- B2: Steps 1-2 export the negative that was painted, not a readback ----
{
  const negative = image(6, 4, 90);
  negative.__image16 = { width: 6, height: 4, data: new Uint16Array(6 * 4 * 4) };
  const state = { currentStep: 2, processedImageData: null, croppedImageData: null, originalImageData: negative,
    sprocketPreviewEnabled: false, exportSprocketHolesEnabled: false };
  const reads = [];
  const context = vm.createContext({
    state, ImageData: TestImageData,
    ensureFullResolutionReadyForExport: async () => {}, ensureRepairsReadyForExport: async () => {},
    applyAdjustmentsWithSettings: () => assert.fail('Steps 1-2 run no adjustment'),
    isDisplayImageDataFullResolution: () => false,
    noteGeometryPixelRead: reader => reads.push(reader),
    canvas: { get width() { return assert.fail('#canvas is never read back'); } },
    ctx: { getImageData: () => assert.fail('#canvas is never read back') },
  });
  vm.runInContext(functionSource('getCurrentExportImageData'), context);
  for (const bitDepth of [8, 16]) {
    const exported = await context.getCurrentExportImageData({ bitDepth });
    assert.notEqual(exported, negative, 'a wrapper, so nothing set on it reaches the editor plane');
    assert.equal(exported.data, negative.data, 'the painted pixels, shared rather than copied');
    assert.deepEqual([exported.width, exported.height], [6, 4]);
    assert.equal(exported.__image16, undefined, 'the 8-bit pixels #canvas held, as before: no 16-bit plane');
  }
  const cropped = image(3, 2, 40);
  state.croppedImageData = cropped;
  assert.equal((await context.getCurrentExportImageData()).data, cropped.data, 'the crop when there is one');
  state.sprocketPreviewEnabled = true;
  assert.equal(await context.getCurrentExportImageData(), cropped, 'the border export frames the plane itself, as before');
  state.croppedImageData = null; state.originalImageData = null; state.sprocketPreviewEnabled = false;
  assert.equal(await context.getCurrentExportImageData(), null);
  assert.deepEqual(reads, ['currentExportImageData', 'currentExportImageData', 'currentExportImageData', 'currentExportImageData']);
}

// ---- B1: a failed conversion shows the framed negative ----
{
  const state = { processedImageData: null, croppedImageData: null, originalImageData: image(4, 4) };
  const painted = [];
  const context = vm.createContext({ state, displayNegative: imageData => painted.push(imageData) });
  vm.runInContext(functionSource('showNegativeAfterFailedConversion'), context);
  context.showNegativeAfterFailedConversion();
  assert.deepEqual(painted, [state.originalImageData]);
  state.croppedImageData = image(2, 2);
  context.showNegativeAfterFailedConversion();
  assert.equal(painted.at(-1), state.croppedImageData, 'the framed negative');
  state.processedImageData = image(2, 2);
  context.showNegativeAfterFailedConversion();
  assert.equal(painted.length, 2, 'a positive already on screen stays');
}

for (const failure of ['null', 'throw']) {
  const negative = image(4, 4);
  const state = { croppedImageData: null, originalImageData: negative, processedImageData: null,
    conversionSourceImageData: null, conversionPreviewImageData: null, beforeAfterActive: false };
  const painted = [];
  const alerts = [];
  const context = vm.createContext({
    state, console: { error: noop }, loadGeneration: 1, coreReprocessGeneration: 0, processNegativeInFlight: null,
    whenGeometrySettled: async () => true, isCurrentLoad: generation => generation === 1,
    createPerfTrace: () => ({ mark: noop, end: noop }), getImageDataPixelCount: () => 16,
    quietLoadingOverlay: { show: async () => {}, updateProgress: noop, hide: noop },
    getLoadingOverlay: () => ({ show: async () => {}, updateProgress: noop, hide: noop }),
    i18n: { en: {} }, currentLang: 'en',
    applyLensCorrectionWithSettings: async imageData => imageData, invalidateSilverCoreCache: noop,
    gpuPreviewScheduler: { cancel: noop }, releaseBeforeAfterCanvas: noop, refreshCanvasContainerSize: noop,
    buildPreviewSourceImageData: imageData => imageData, usesSilverCoreConversion: () => true,
    hasSeparateConversionPreview: () => false,
    convertFromCurrentSource: async () => { if (failure === 'throw') throw new Error('decoder'); return null; },
    applyProcessedImageToState: () => assert.fail('nothing to apply'),
    displayNegative: imageData => painted.push(imageData),
    appAlert: message => { alerts.push(message); }, getLocalizedText: (key, fallback) => fallback,
  });
  vm.runInContext(['showNegativeAfterFailedConversion', 'processNegative'].map(functionSource).join('\n'), context);
  await context.processNegative({ quiet: true });
  await settle();
  assert.deepEqual(painted, [negative], `${failure}: the framed negative is painted once`);
  assert.equal(alerts.length, failure === 'throw' ? 1 : 0);
}

console.log('displayPath: Steps 1-2 export without a readback and failed conversions show the framed negative passed');
