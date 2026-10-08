// Light-table tiles saved in and restored from roll projects (#247 part 5),
// through the app's own buildCurrentProject and applyPendingProject.
// Run with: node negative2positive/src/app/projectThumbnails.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  buildRollProject, serializeRollProject, parseRollProject, matchProjectFiles, projectThumbnailContext, restorableProjectThumbnail
} from './rollProject.js';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  return source.slice(match.index, source.indexOf('\n    }', match.index) + '\n    }'.length);
}
const runtime = ['buildCurrentProject', 'frameThumbnailContext', 'savedProjectThumbnail', 'applyPendingProject', 'sanitizeProjectSettings']
  .map(functionSource).join('\n');
const tile = n => 'data:image/jpeg;base64,' + Buffer.alloc(3000 + n, n).toString('base64');
const noop = () => {};

function session({ dust = false, automatic = false } = {}) {
  const files = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}.dng`, size: 100 + i, lastModified: i }));
  const items = files.map((file, i) => ({ id: i, file, hash: `h${i}`, selected: true, automaticSettings: automatic,
    settings: { id: i, filmType: i === 4 ? 'bw' : 'color', ...(i === 3 ? { repairStrokes: [{ size: 1, points: [] }] } : {}) } }));
  const state = {
    fileQueue: items, currentFileIndex: 0, originalImageData: {}, rollMetadata: {}, rollReference: {}, rollAnalysis: {},
    lensCorrection: {}, flatFields: {}, dustRemoval: { enabled: dust, strength: 3, maxParticleSize: 40, ai: false }
  };
  const switched = [];
  const context = vm.createContext({
    state, console, structuredClone,
    projectThumbnailContext, restorableProjectThumbnail, buildRollProject, matchProjectFiles,
    pendingProject: null,
    getCurrentQueueItem: () => state.fileQueue[state.currentFileIndex],
    persistCurrentFileSettings: noop, extractCurrentSettings: () => ({ live: true }),
    photoSettingsKey: item => JSON.stringify([item.settings, item.studioColors ?? null, state.dustRemoval.enabled]),
    sanitizeSettings: settings => structuredClone(settings), perPhotoSettingsFallback: () => ({}),
    frameWantsAutoWhiteBalance: settings => settings.filmType === 'color',
    sanitizeFilmTypeOverride: value => value || null, cloneSettings: value => structuredClone(value),
    queueItemHash: async item => item.hash, interruptedRollFrames: () => [],
    sanitizeRollMetadata: value => value || {}, sanitizeLensCorrection: value => value, createDefaultLensCorrectionSettings: () => ({}),
    updateFileListUI: noop, updateExportButtons: noop, updateMetadataUI: noop, updateRollReferenceUI: noop, updateRollAnalysisUI: noop,
    syncBatchUIState: noop, getInterpolatedText: (_key, _args, fallback) => fallback, showToast: noop, appAlert: noop,
    switchToFile: async index => { switched.push(index); }, scheduleProjectRecovery: noop,
    offerInterruptedJobResume: async () => {}, notifyExportError: noop
  });
  vm.runInContext(runtime, context);
  return { context, state, items, files, switched };
}

// Save: final tiles current for the saved recipe, with their context. Not
// the ones whose key holds this session's AI-repair revision (repair
// strokes, or dust removal on), and not the open photo's in the recovery copy.
const saved = session();
for (const item of saved.items) {
  item.thumbnail = tile(item.id);
  item.thumbnailKind = 'processed';
  item.thumbnailKey = saved.context.photoSettingsKey(item);
}
saved.items[2].thumbnailKey = 'stale';
{
  const project = saved.context.buildCurrentProject({ persist: true });
  assert.deepEqual(project.files.map(entry => Boolean(entry.thumbnail)), [true, true, false, false, true]);
  assert.deepEqual(project.files[0].thumbnailContext, projectThumbnailContext({ dust: [false, 3, 40, false], autoWhiteBalance: false }));
  const recovery = saved.context.buildCurrentProject();
  assert.equal(recovery.files[0].thumbnail, undefined, 'the open photo is left out of the recovery copy');
  assert.equal(recovery.files[1].thumbnail, tile(1));
  const dusty = session({ dust: true });
  for (const item of dusty.items) Object.assign(item, { thumbnail: tile(item.id), thumbnailKind: 'processed', thumbnailKey: dusty.context.photoSettingsKey(item) });
  assert.ok(dusty.context.buildCurrentProject({ persist: true }).files.every(entry => !entry.thumbnail), 'dust removal on: no tiles');
}
const text = serializeRollProject(saved.context.buildCurrentProject({ persist: true }));

// Restore: matched frames only, once their recipes are back; every one of
// them is ready with its restored recipe's key, so the lane decodes nothing.
{
  const reopened = session();
  for (const item of reopened.items) { item.settings = null; item.thumbnail = null; }
  // f4.dng changed on disk since the save: same name, other content.
  reopened.items[4].hash = 'changed';
  reopened.items[4].file = { ...reopened.items[4].file, size: 999 };
  reopened.context.pendingProject = parseRollProject(text);
  await reopened.context.applyPendingProject();
  const [f0, f1, f2, f3, f4] = reopened.state.fileQueue;
  for (const item of [f0, f1]) {
    assert.equal(item.thumbnail, tile(item.id));
    assert.equal(item.thumbnailKind, 'processed');
    assert.equal(item.thumbnailKey, reopened.context.photoSettingsKey(item), 'the key of the restored recipe');
  }
  assert.equal(f2.thumbnail, null, 'a stale tile was never saved');
  assert.equal(f3.thumbnail, null, 'repair strokes: rendered again');
  assert.equal(f4.thumbnail, null, 'a changed original is rendered again');
  assert.deepEqual(Array.from(reopened.switched), [0]);
  // After the reopen a recipe change still invalidates the tile.
  f1.settings = { ...f1.settings, coreExposure: 5 };
  assert.notEqual(f1.thumbnailKey, reopened.context.photoSettingsKey(f1));
}

// Frames whose tile had the automatic gray point reopen without it (their
// recipe is restored as saved), so those tiles are rendered again.
{
  const auto = session({ automatic: true });
  for (const item of auto.items) Object.assign(item, { thumbnail: tile(item.id), thumbnailKind: 'processed', thumbnailKey: auto.context.photoSettingsKey(item) });
  const project = parseRollProject(serializeRollProject(auto.context.buildCurrentProject({ persist: true })));
  assert.equal(project.files[0].thumbnailContext.autoWhiteBalance, true);
  assert.equal(project.files[4].thumbnailContext.autoWhiteBalance, false, 'B&W: no automatic gray point');
  const reopened = session();
  for (const item of reopened.items) { item.settings = null; item.thumbnail = null; }
  reopened.context.pendingProject = project;
  await reopened.context.applyPendingProject();
  assert.deepEqual(Array.from(reopened.state.fileQueue, item => Boolean(item.thumbnail)), [false, false, false, false, true]);
}

console.log('projectThumbnails: tiles saved with their context, restored for matched frames only, invalidated by recipe changes');
