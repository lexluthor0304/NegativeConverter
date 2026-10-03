// Every RAW uses Studio's viewer-local opening card. A non-TIFF container
// needs no embedded JPEG for the veil, and a later activation owns the UI.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const fn = name => {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, name);
  return source.slice(match.index, source.indexOf('\n    }', match.index) + 6);
};
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
function fixture() {
  const rawLoads = [], overlays = [], embedded = [], prepares = [];
  const state = { fileQueue: [], autoFrame: { enabled: false }, dustRemoval: {}, loadedFile: null };
  const target = { state, loadGeneration: 0, photoActivation: null,
    document: { body: { dataset: {} } }, i18n: { en: {} }, currentLang: 'en',
    studioWorkspace: { sync() {}, flush() {}, photoSwitchPresentation: {} },
    quietLoadingOverlay: { async show() {}, updateProgress() {}, hide() {} },
    getLoadingOverlay: () => { overlays.push('fullscreen'); return { async show() {}, updateProgress() {}, hide() {} }; },
    isRawLikeFileName: name => /\.(cr3|raf|orf|x3f|mrw|dng)$/.test(name),
    isTiffContainerRawName: name => /\.dng$/i.test(name),
    getEmbeddedPreviewPool: () => ({ request: job => { embedded.push(job); return Promise.resolve(null); } }),
    cancelProvisionalFrame() {}, invalidatePhotoActivation() {}, cancelCropDetection() {},
    lensMapCache: new Map(), convertPreviewFrameInWorker: { async warmUp() {} },
    claimForActivation: () => ({ async atDecode() {} }), settleActivationClaim() {},
    sharedDecodes: { inFlight: () => false }, adoptSharedDecode: () => null,
    rawDecodePlan: async () => ({ stages: 1 }), memoryRuntime: {},
    loadRawImageData: (buffer, name, options) => new Promise((resolve, reject) => {
      rawLoads.push({ name, options, resolve, reject });
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }), prepareStudioPhoto: async (generation, item, options) => prepares.push({ generation, options }),
    DEFAULT_FILM_BASE: {}, webglState: {}, console: { error: (...args) => assert.fail(args.map(String).join(' ')), warn() {} },
    lowMemoryPhotoDevice: () => false,
  };
  const context = vm.createContext(new Proxy(target, { has: () => true, get(t, key) {
    if (key in t) return t[key]; if (key in globalThis) return globalThis[key];
    if (typeof key === 'string' && /^[a-z]/.test(key)) return () => {};
  } }));
  vm.runInContext(['supersedeActivation', 'beginActivation', 'isCurrentLoad', 'beginImportOpening', 'endImportOpening', 'requestProvisionalFrame', 'loadFile'].map(fn).join('\n'), context);
  const file = name => { const file = { name, async arrayBuffer() { return new ArrayBuffer(8); } }; state.fileQueue.push({ file }); return file; };
  return { context, target, state, rawLoads, overlays, embedded, prepares, file };
}
for (const extension of ['cr3', 'raf', 'orf', 'x3f', 'mrw']) {
  const f = fixture(), file = f.file(`first.${extension}`);
  const pending = f.context.loadFile(file);
  await tick();
  assert.equal(f.state.photoSwitchTarget.file, file);
  assert.equal(f.state.photoSwitchPhase, 'loading');
  assert.equal(f.target.document.body.dataset.photoSwitching, 'true');
  assert.equal(f.target.document.body.dataset.studioBusy, 'true');
  assert.equal(f.overlays.length, 0, `${extension}: no full-screen overlay`);
  assert.equal(f.embedded.length, 0, 'non-TIFF stays on the veil text card');
  assert.equal(f.rawLoads.length, 1);
  f.rawLoads[0].resolve({ width: 9, height: 7, data: new Uint8ClampedArray(9 * 7 * 4) });
  assert.equal((await pending).status, 'loaded');
  assert.equal(f.prepares[0].options.quiet, true, 'conversion keeps the viewer-local surface');
  assert.equal(f.state.loadedFile, file);
  assert.equal(f.state.photoSwitchTarget, null);
  assert.equal(f.target.document.body.dataset.photoSwitching, undefined);
}
for (const extension of ['cr3', 'raf']) {
  const f = fixture(), first = f.file(`old.${extension}`), next = f.file(`new.${extension}`);
  const old = f.context.loadFile(first);
  await tick();
  const current = f.context.loadFile(next);
  await tick();
  assert.equal(f.rawLoads[0].options.signal.aborted, true, 'switch aborts the first decode');
  assert.equal((await old).status, 'stale');
  assert.equal(f.state.photoSwitchTarget.file, next, 'old finally cannot hide the new veil');
  assert.equal(f.target.document.body.dataset.photoSwitching, 'true');
  f.rawLoads[1].resolve({ width: 9, height: 7, data: new Uint8ClampedArray(9 * 7 * 4) });
  assert.equal((await current).status, 'loaded');
  assert.equal(f.state.loadedFile, next);
  assert.equal(f.overlays.length, 0);
}
console.log('rawImportVeil: all RAW containers use the viewer card; CR3/RAF switches abort safely');
