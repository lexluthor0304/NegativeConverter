import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as filmType from './filmTypeOverride.js';
import { sanitizeSemanticMap } from './semanticAnchors.js';
import { analyzeExpiredFilm, defaultExpiredRescueParams, EXPIRED_RESCUE_DEFAULTS } from '../pipeline/expiredRescue.js';

// Execute the production listeners and rescue measurement with a completed,
// valid map. NC229_CALLER_SOURCE also runs the same regression at the old head.
const source = readFileSync(process.env.NC229_CALLER_SOURCE || new URL('./main.js', import.meta.url), 'utf8');
const fn = name => {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source)?.index;
  assert.notEqual(start, undefined, name);
  return source.slice(start, source.indexOf('\n    }', start) + 6);
};
const start = source.indexOf("    document.querySelectorAll('.film-type-btn').forEach(btn => {\n      btn.addEventListener('click'");
const end = source.indexOf('\n    // The open photo', start);
const positiveStart = source.indexOf("    document.getElementById('positiveModeSelect').addEventListener('change', event => {");
const positiveEnd = source.indexOf('\n    });', positiveStart) + 8;
assert.ok(start > 0 && end > start && positiveEnd > positiveStart);
const map = sanitizeSemanticMap({ width: 2, height: 1, labels: [0, 4], confidence: 0.95 });
assert.ok(map);
const width = 64, height = 48;
const data16 = new Uint16Array(width * height * 4);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const at = (y * width + x) * 4, value = 9000 + ((x * 71 + y * 157) % 35000);
  for (let c = 0; c < 3; c++) data16[at + c] = Math.min(65535, Math.round(value * (x < width / 2 ? [1.25, 1, 0.8] : [0.7, 1.15, 0.85])[c]));
  data16[at + 3] = 65535;
}
const image = { width, height, data: Uint8ClampedArray.from(data16, v => v >>> 8), __image16: { width, height, data: data16 } };
function fixture(type, mode, { manualWb = false } = {}) {
  const state = { ...EXPIRED_RESCUE_DEFAULTS, expiredEnabled: true, expiredBrightness: 17, expiredContrast: 23,
    expiredNeutralize: 61, filmType: type, positiveMode: mode, coreExposure: 19, cropRegion: { left: 2, top: 3, width: 40, height: 30 },
    semanticMap: structuredClone(map), autoFrame: { lastDiagnostics: null }, processedImageData: image,
    wbR: 1.17, wbG: 1, wbB: 0.86, wbAutoConfidence: 'high', wbSemanticApplied: false,
    wbUserOverride: manualWb, grayPointSampled: false };
  state.expiredAnalysis = analyzeExpiredFilm(image, { anchors: map });
  const snapshots = [], listeners = {}, inputs = [];
  const buttons = ['color', 'bw', 'positive'].map(type => ({ dataset: { type }, addEventListener: (_, cb) => { listeners[type] = cb; } }));
  const target = { ...filmType, state, expiredAnalysisKey: null,
    document: { querySelectorAll: () => buttons, getElementById: () => ({ addEventListener: (_, cb) => { listeners.mode = cb; } }) },
    pushUndo: label => snapshots.push({ label, settings: structuredClone(state) }),
    requiresFilmBase: () => false, usesSilverCoreConversion: () => true,
    expiredAnalysisSample: processed => ({ image: processed, options: {}, placement: { left: 0, top: 0, width: 1, height: 1 } }),
    baseSizeSource: () => image,
    analyzeExpiredFilm: (processed, options) => { inputs.push(options.anchors); return analyzeExpiredFilm(processed, options); },
    defaultExpiredRescueParams, EXPIRED_RESCUE_DEFAULTS, expiredSourceKey: () => 'new-frame',
    runExpiredSpatialAnalysis: () => Promise.resolve(false) };
  const context = vm.createContext(new Proxy(target, { has: () => true, get: (t, key) => key in t ? t[key] : key in globalThis ? globalThis[key] : () => {} }));
  vm.runInContext(source.slice(start, end) + '\n' + source.slice(positiveStart, positiveEnd) + '\n'
    + ['runExpiredAnalysis', 'applyExpiredAnalysisDefaults'].map(fn).join('\n'), context);
  return { state, snapshots, listeners, inputs, context };
}

let cases = 0;
for (const [before, after, mode] of [['positive', 'color', 'correct'], ['color', 'positive', 'correct'], ['positive', 'bw', 'correct'],
  ['bw', 'color', 'correct'], ['positive', 'positive', 'edit'], ['positive', 'positive', 'correct']]) {
  for (const manualWb of [false, true]) {
    const oldMode = before === after ? (mode === 'edit' ? 'correct' : 'edit') : 'correct';
    const f = fixture(before, oldMode, { manualWb });
    if (before === after) f.listeners.mode({ target: { value: mode } });
    else f.listeners[after]();
    assert.equal(f.state.semanticMap, null, `${before}/${oldMode} -> ${after}/${mode}: completed anchors invalidated`);
    assert.equal(f.state.expiredAnalysis, null, 'old rescue measurement invalidated');
    assert.deepEqual([f.state.expiredBrightness, f.state.expiredContrast, f.state.expiredNeutralize, f.state.coreExposure], [17, 23, 61, 19], 'user strengths/settings kept');
    assert.deepEqual(f.state.cropRegion, { left: 2, top: 3, width: 40, height: 30 });
    assert.deepEqual(f.snapshots[0].settings.semanticMap, map, 'undo retains the old interpretation and anchors');
    if (manualWb) assert.deepEqual([f.state.wbR, f.state.wbG, f.state.wbB], [1.17, 1, 0.86]);
    f.context.runExpiredAnalysis(image);
    assert.deepEqual(f.inputs, [null], 'new measurement receives no old anchors');
    const fresh = analyzeExpiredFilm(image, { anchors: null, placement: { left: 0, top: 0, width: 1, height: 1 } });
    assert.deepEqual(f.state.expiredAnalysis, fresh, 'equals a fresh new-interpretation measurement');
    assert.notDeepEqual(analyzeExpiredFilm(image, { anchors: map, placement: { left: 0, top: 0, width: 1, height: 1 } }), fresh, 'valid old anchors change this fixture');
    cases++;
  }
}
for (const type of ['color', 'bw', 'positive']) {
  const f = fixture(type, 'correct');
  f.listeners[type]();
  assert.deepEqual(f.state.semanticMap, map, 'same interpretation retains completed anchors');
}
console.log(`liveFilmTypeAnalysis: ${cases} real listener/measurement crossings; user strengths, manual WB and old undo anchors preserved; same type keeps anchors`);
