// The import's geometry from sizes only (#251): the real analyzeStudioImportFrame
// and mergeImportFilmEdge of main.js on a 60 MP frame descriptor that has no
// pixels. The rotate-180 default and a mirrored edge-text read map the crop
// across rotatedDimensions; neither may read a pixel or rotate the frame.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { normalizeAngleDegrees, rotatedDimensions } from './imageGeometry.js';
import { canAutoApplyImportFrame } from './autoFrameFormats.js';
import { imageAreaFromDetection } from './analysisRegion.js';
import { sanitizeFilmEdgeForSettings } from './filmEdgeReader.js';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  // The closing brace alone on its line (a destructured parameter list also
  // starts a line with "    }").
  const end = source.indexOf('\n    }\n', match.index);
  return source.slice(match.index, end + 6);
}

// 9504 x 6320 with no planes: any pixel read throws.
const frame = Object.defineProperties({ width: 9504, height: 6320 }, {
  data: { get: () => assert.fail('the import read pixels of the full frame') },
  __image16: { get: () => assert.fail('the import read the 16-bit plane') }
});
// Objects made inside the vm context have its prototypes.
const plain = value => JSON.parse(JSON.stringify(value));
const perfStages = [];
const context = vm.createContext({
  state: { autoFrame: { enabled: true, onImport: true, highConfidence: 0.72, rotate180Default: false }, rollMetadata: {} },
  console, normalizeAngleDegrees, rotatedDimensions, canAutoApplyImportFrame, imageAreaFromDetection, sanitizeFilmEdgeForSettings,
  analyzeFrameInWorker: {}, runImportDetections: () => assert.fail('a given detection is not requested again'),
  applyRotationToImageData: () => assert.fail('no full-frame rotation for a size'),
  recordPerfStages: (...args) => perfStages.push(args),
  updateMetadataUI: () => {},
  getInterpolatedText: (_key, _values, fallback) => fallback,
});
vm.runInContext(['autoFrameEffectiveAngle', 'rotate180CropRegion', 'effectiveGeometryAngle', 'mirrorCropForRotatedFrame',
  'analyzeStudioImportFrame', 'mergeImportFilmEdge'].map(functionSource).join('\n'), context);

const detection = {
  result: {
    angle: 0.37, cropRegion: { left: 1400, top: 900, width: 6700, height: 4466 }, confidence: 0.9, confidenceLevel: 'high',
    detectedFormat: '135', rotatedWidth: 9545, rotatedHeight: 6382, rotatedIsSource: false,
    diagnostics: { method: 'opencv-line-window' }, stageMs: { preview: 80, window: 900, rotateFull: 0 }
  }
};
const settings = { filmType: 'color', cropRegion: null, rotationAngle: 0, mirrored: false, filmTypeSource: 'auto' };
const turned = rotatedDimensions(9504, 6320, 0.37);
assert.deepEqual(turned, { width: detection.result.rotatedWidth, height: detection.result.rotatedHeight }, 'the fixture uses the rule\'s size');

// Detection folded in: the crop as detected.
const framed = await context.analyzeStudioImportFrame(frame, settings, { detection });
assert.equal(framed.rotationAngle, 0.37);
assert.deepEqual(plain(framed.cropRegion), detection.result.cropRegion);
assert.equal(framed.autoFrameMeta.appliedMode, 'crop');
assert.equal(perfStages.length, 1);

// The rotate-180 default flips the crop across the frame's size.
context.state.autoFrame.rotate180Default = true;
const flipped = await context.analyzeStudioImportFrame(frame, settings, { detection, autoFrame: context.state.autoFrame });
context.state.autoFrame.rotate180Default = false;
assert.equal(flipped.rotationAngle, normalizeAngleDegrees(0.37 + 180));
const size180 = rotatedDimensions(9504, 6320, flipped.rotationAngle);
assert.deepEqual(plain(flipped.cropRegion), {
  left: size180.width - 1400 - 6700, top: size180.height - 900 - 4466, width: 6700, height: 4466
});

// A mirrored edge-text read flips the crop across the rotated width, in far
// less than 5 ms and without pixels.
const read = { result: { found: true, text: { text: 'KODAK 400', frameNumber: '12', mirrorDetected: true } } };
const started = performance.now();
const merged = await context.mergeImportFilmEdge(frame, framed, read, { applyDefaults: true });
const elapsed = performance.now() - started;
assert.equal(merged.settings.mirrored, true);
assert.deepEqual(plain(merged.settings.cropRegion), { left: turned.width - 1400 - 6700, top: 900, width: 6700, height: 4466 });
assert.ok(elapsed < 5, `the mirror branch took ${elapsed.toFixed(2)} ms`);

console.log(`importFrameSizes: rotate-180 and mirrored edge text map the crop from sizes only (${elapsed.toFixed(2)} ms at 60 MP)`);
