// Display-only probe for #235: run main.js's actual provisional-frame, retained
// preview and embedded-tile functions against a `state` that throws on any
// write to an image field, and a photoSessions cache that throws on any use.
// Provisional ImageBitmaps/ImageData may only reach the veil presentation, and
// tile data URLs only the item's thumbnail fields.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { canPublishThumbnail } from './thumbnailRank.js';
import { sanitizeFilmTypeOverride } from './filmTypeOverride.js';
import { isTiffContainerRawName } from './rawEmbeddedPreview.js';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source)?.index;
  assert.notEqual(start, undefined, `${name} exists in main.js`);
  const end = source.indexOf('\n    }', start);
  return source.slice(start, end + '\n    }'.length);
}
const tick = () => new Promise(setImmediate);

const PROTECTED = ['loadedBaseImageData', 'originalImageData', 'croppedImageData', 'processedImageData',
  'displayImageData', 'conversionSourceImageData', 'conversionPreviewImageData', 'previewSourceImageData',
  'histogramSourceImageData', 'webglSourceImageData'];

function fixture() {
  const writes = [];
  const raw = { fileQueue: [], currentFileIndex: 0, photoSwitchTarget: null, importFilmTypeAuto: true, filmType: 'color' };
  const state = new Proxy(raw, {
    set(target, key, value) {
      if (PROTECTED.includes(key)) throw new Error(`provisional pixels written to state.${String(key)}`);
      writes.push(key); target[key] = value; return true;
    },
  });
  const forbidden = new Proxy({}, { get: (_t, key) => { throw new Error(`photoSessions.${String(key)} touched`); } });
  const shown = [], requests = [], flushed = [], frames = [];
  let refreshes = 0;
  const pool = {
    replies: [],
    request(job, options) {
      const reply = {};
      reply.promise = new Promise(resolve => { reply.resolve = resolve; });
      requests.push({ job, options, reply });
      return reply.promise;
    },
    setKeepWarm() {}, cancel() {}, clear() {}, reprioritize() {},
  };
  const presentation = {
    showBitmap: (item, bitmap, kind) => { shown.push({ item, bitmap, kind }); return true; },
    showImageData: (item, image, kind) => { shown.push({ item, image, kind }); return Boolean(image); },
    showUrl: (item, url, kind) => { shown.push({ item, url, kind }); return Boolean(url); },
  };
  const retained = new Map();
  const context = vm.createContext({
    state, photoSessions: forbidden, console,
    photoPreviews: { peek: item => retained.get(item) },
    photoSettingsKey: item => JSON.stringify(item.settings ?? null),
    studioWorkspace: { photoSwitchPresentation: presentation },
    document: { body: { dataset: {} }, getElementById: () => ({ getBoundingClientRect: () => ({ width: 1100, height: 700 }) }),
      querySelectorAll: () => [] },
    window: { devicePixelRatio: 2, innerWidth: 1440, innerHeight: 900 },
    performance: { mark() {} }, AbortController, IntersectionObserver: undefined,
    createEmbeddedPreviewPool: () => pool, renderEmbeddedPreview: () => null, createDocumentPreviewEnv: () => null,
    isTiffContainerRawName, sanitizeFilmTypeOverride, canPublishThumbnail,
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
    updateFileThumbnail: (item, options) => flushed.push({ item, refresh: options?.refresh }),
    refreshThumbnailStates: () => { refreshes++; },
  });
  vm.runInContext(`let embeddedPreviewPool = null, provisionalRequest = null, tileVisibility = null, tileFlushFrame = 0;
    const embeddedTileItems = new Set(), visibleTileItems = new Set(), tileFlushItems = new Set();\n`
    + ['getEmbeddedPreviewPool', 'viewerLongSidePx', 'provisionalToneFor', 'presentRetainedPreview', 'cancelProvisionalFrame',
      'requestProvisionalFrame', 'scheduleTileFlush', 'tilePriority', 'observeTileVisibility', 'queueEmbeddedTiles',
      'syncEmbeddedPreviewQueue'].map(functionSource).join('\n'), context);
  return { context, raw, state, writes, shown, requests, flushed, frames, retained, refreshes: () => refreshes };
}
const dng = (name, extra = {}) => ({ file: { name }, settings: null, ...extra });

// Viewer frame: posted with the target's recipe, drawn only on the veil.
{
  const f = fixture(), c = f.context;
  const item = dng('L1000617.DNG', {
    settings: { filmType: 'bw', rotationAngle: 1.5, mirrored: true, cropRegion: { left: 10, top: 20, width: 300, height: 200 } },
    thumbnail: 'data:processed', thumbnailKind: 'processed' });
  f.raw.fileQueue.push(item);
  f.raw.photoSwitchTarget = item;
  c.document.body.dataset.photoSwitching = 'true';
  c.requestProvisionalFrame(item);
  const [{ job, options, reply }] = f.requests;
  assert.equal(job.purpose, 'viewer');
  assert.equal(job.longSidePx, 2200, 'viewer long side in device pixels');
  assert.equal(JSON.stringify(job.geometry), JSON.stringify({ rotationAngle: 1.5, mirrored: true, cropRegion: { left: 10, top: 20, width: 300, height: 200 } }));
  assert.deepEqual([job.invert, job.monochrome, job.matchTo], [true, true, 'data:processed']);
  assert.equal(options.priority, -1, 'the viewer frame goes ahead of every tile');
  const bitmap = { width: 2112, height: 1408, close: () => assert.fail('a current frame is shown, not closed') };
  reply.resolve({ bitmap });
  await tick();
  assert.deepEqual(f.shown.map(entry => [entry.item, entry.bitmap, entry.kind]), [[item, bitmap, 'embedded']]);
  assert.deepEqual(f.writes, [], 'no state field is written by the provisional path');
}

// Stale results: a newer activation or a changed target closes the bitmap.
for (const change of ['superseded', 'target', 'veil']) {
  const f = fixture(), c = f.context;
  const first = dng('a.dng'), second = dng('b.dng');
  f.raw.fileQueue.push(first, second);
  f.raw.photoSwitchTarget = first;
  c.document.body.dataset.photoSwitching = 'true';
  c.requestProvisionalFrame(first);
  if (change === 'superseded') { f.raw.photoSwitchTarget = second; c.requestProvisionalFrame(second); }
  if (change === 'target') f.raw.photoSwitchTarget = second;
  if (change === 'veil') delete c.document.body.dataset.photoSwitching;
  let closed = 0;
  f.requests[0].reply.resolve({ bitmap: { close: () => { closed++; } } });
  await tick();
  assert.equal(closed, 1, `${change}: a stale provisional bitmap is released`);
  assert.equal(f.shown.length, 0, `${change}: nothing stale reaches the veil`);
}

// Only TIFF-container RAWs have embedded previews to decode.
{
  const f = fixture(), c = f.context;
  for (const name of ['scan.tif', 'photo.jpg', 'IMG_1.CR3', 'frame.RAF']) c.requestProvisionalFrame(dng(name));
  assert.equal(f.requests.length, 0);
}

// Film type rules: never guess, follow the exact render's own inversion.
{
  const f = fixture(), c = f.context;
  const tone = item => JSON.stringify(c.provisionalToneFor(item));
  assert.equal(tone(dng('a.dng')), JSON.stringify({ invert: true, monochrome: false }), 'no settings: invert by default');
  assert.equal(tone(dng('a.dng', { settings: { filmType: 'positive' } })), JSON.stringify({ invert: false, monochrome: false }));
  assert.equal(tone(dng('a.dng', { filmTypeOverride: { filmType: 'positive' }, settings: { filmType: 'color' } })),
    JSON.stringify({ invert: false, monochrome: false }), 'an explicit override wins');
  f.raw.importFilmTypeAuto = false; f.raw.filmType = 'positive';
  assert.equal(tone(dng('a.dng')), JSON.stringify({ invert: false, monochrome: false }), 'automatic detection off: the import type');
  f.raw.importFilmTypeAuto = true;
  assert.equal(tone(dng('a.dng')), JSON.stringify({ invert: true, monochrome: false }), 'automatic detection is never pre-empted');
}

// Retained pixels: the exact 1200 px copy only when its recipe key matches.
{
  const f = fixture(), c = f.context;
  const item = dng('a.dng', { settings: { exposure: 1 }, thumbnail: 'data:thumb', thumbnailKind: 'embedded' });
  f.raw.photoSwitchTarget = item;
  const image = { width: 1200, height: 800 };
  f.retained.set(item, { key: JSON.stringify(item.settings), image });
  assert.equal(c.presentRetainedPreview(item), 'cached');
  f.retained.set(item, { key: 'stale', image });
  assert.equal(c.presentRetainedPreview(item), 'thumbnail', 'a stale recipe falls back to the tile thumbnail');
  f.retained.delete(item); item.thumbnail = null;
  assert.equal(c.presentRetainedPreview(item), null);
  f.raw.photoSwitchTarget = null;
  assert.equal(c.presentRetainedPreview(item), null, 'only the current target is presented');
  assert.deepEqual(f.shown.map(entry => entry.kind), ['cached', 'thumbnail']);
  assert.deepEqual(f.writes, []);
}

// Embedded tiles: TIFF RAWs only, rank-guarded, batched one flush per frame.
{
  const f = fixture(), c = f.context;
  const items = [dng('1.dng'), dng('2.nef'), dng('3.png'), dng('4.dng'), dng('5.dng')];
  f.raw.fileQueue.push(...items);
  f.raw.currentFileIndex = 3;
  c.queueEmbeddedTiles(items);
  assert.deepEqual(f.requests.map(r => r.job.file.name), ['1.dng', '2.nef', '4.dng', '5.dng']);
  assert.ok(f.requests.every(r => r.job.purpose === 'tile' && r.job.output === 'dataUrl' && !('geometry' in r.job)));
  assert.equal(f.requests.find(r => r.job.file.name === '4.dng').options.priority, 0, 'the first photo first');
  c.queueEmbeddedTiles(items);
  assert.equal(f.requests.length, 4, 'a queued tile is not requested twice');
  items[1].thumbnail = 'data:analysis'; items[1].thumbnailKind = 'analysis';
  f.raw.fileQueue.splice(f.raw.fileQueue.indexOf(items[4]), 1);
  for (const request of f.requests) request.reply.resolve({ dataUrl: 'data:embedded:' + request.job.file.name });
  await tick();
  assert.deepEqual([items[0].thumbnail, items[0].thumbnailKind, items[0].thumbnailKey], ['data:embedded:1.dng', 'embedded', null]);
  assert.equal(items[1].thumbnail, 'data:analysis', 'never replaces an analysis tile');
  assert.equal(items[4].thumbnail, undefined, 'a removed photo is never published');
  assert.equal(f.frames.length, 1, 'publishes coalesce into one animation frame');
  f.frames.shift()();
  assert.deepEqual(f.flushed.map(entry => [entry.item.file.name, entry.refresh]), [['1.dng', false], ['4.dng', false]]);
  assert.equal(f.refreshes(), 1, 'one refreshThumbnailStates per frame');
  assert.deepEqual(f.writes, [], 'tile publishing writes no state field');
}

console.log('provisionalPreview tests passed: display-only provisional frames, retained previews and embedded tiles');
