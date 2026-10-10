// Interrupted jobs (#241) end to end through main.js's own functions: a batch
// export writes its marker, the page "dies" after the first frame, the next
// page names the job once and, after the restore, resumes it with the format,
// options, names and positions the job started with (R1-125), never with the
// controls a reload reset, which it leaves alone. A job another tab still
// runs is not named (R1-056); a roll analysis is never named, only resumed
// (R1-146). The desktop folder resume runs here; the browser ZIP and
// downloads resumes also run in scripts/hidden-job-smoke.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as jobMarker from './jobMarker.js';
import { i18n } from './i18n.js';
import { interpolateText, summarizePathForUi } from './textUtils.js';
import { createZipNameDeduper } from './zipStoreWriter.js';
import { normalizeSprocketEdgeMarkings, DEFAULT_SPROCKET_EDGE_MARKINGS } from './sprocketFrame.js';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source)?.index;
  assert.notEqual(start, undefined, `${name} exists`);
  const end = source.indexOf('\n    }', start);
  return source.slice(start, end + '\n    }'.length);
}
const runtime = [
  'rgbaToHex', 'createSprocketEdgeSettings', 'getEffectiveExportBitDepth', 'getExportInfo',
  'captureExportJobOptions', 'exportJobOptionsFor', 'legacyResumeNote', 'beginExportJobMarker', 'beginResumedJobMarker',
  'interruptedJobKey', 'describeInterruptedJob', 'checkInterruptedJobs', 'interruptedRollFrames', 'runResumedJob',
  'offerInterruptedJobResume', 'resumedExportJobs', 'resumeInterruptedExport', 'createBatchExportJobs',
  'exportBatchIndividuallyDesktop', 'runDesktopFolderExport', 'exportBatchIndividuallyBrowser', 'runBrowserDownloadsExport',
  'exportBatchAsZipBrowser', 'getLocalizedText', 'getInterpolatedText'
].map(functionSource).join('\n');

function memoryStorage() {
  const map = new Map();
  return { get: key => (map.has(key) ? map.get(key) : null), set: (key, value) => { map.set(key, String(value)); }, remove: key => { map.delete(key); }, map };
}
function fakeLocks() {
  const held = new Set();
  return {
    held,
    request(name, callback) {
      held.add(name);
      return Promise.resolve().then(() => callback({ name })).finally(() => held.delete(name));
    },
    async query() { return { held: [...held].map(name => ({ name })), pending: [] }; }
  };
}

const defaults = () => ({
  jpegQuality: 92, exportSprocketHolesEnabled: false, exportFormat: 'png', exportBitDepth: 8,
  sprocketEdge: null, dustRemoval: { enabled: false, strength: 3, maxParticleSize: 40, ai: true }, fileQueue: []
});
const customEdge = { textEnabled: true, text: 'SMOKE 400', frameNumberEnabled: true, frameNumber: 7, dxEnabled: true, dx1: 17, dx2: 4,
  letteringColor: '#ffaa00' };

// One page of the app: its storage persists across "reloads" (a new page on
// the same storage); its live controls start at the defaults.
function page({ storage, desktop = false, folderFiles = new Map() }) {
  const log = { alerts: [], confirms: [], toasts: [], batches: [], rolls: [], answers: [] };
  const state = defaults();
  const context = vm.createContext({
    state, console, Promise, Error, Object, Array, Number, Boolean, Math, JSON, Map, Set, String, structuredClone, setTimeout, AbortController,
    i18n, currentLang: 'en', interpolateText, summarizePathForUi, createZipNameDeduper,
    normalizeSprocketEdgeMarkings, DEFAULT_SPROCKET_EDGE_MARKINGS,
    ...jobMarker,
    jobMarkerStorage: storage,
    interruptedJobs: [],
    window: desktop ? { __TAURI__: { core: { invoke: async (command, args) => {
      if (command === 'take_web_content_termination') return null;
      if (command === 'exported_files_exist') return args.paths.map(path => folderFiles.has(path));
      throw new Error('unexpected ' + command);
    } } } } : {},
    isTauriDesktop: () => desktop,
    appAlert: async (message) => { log.alerts.push(message); },
    appConfirm: async (message) => { log.confirms.push(message); return log.answers.length ? log.answers.shift() : true; },
    showToast: (message) => { log.toasts.push(message); },
    getSelectedFiles: () => state.fileQueue.map((item, index) => ({ item, index })),
    getSettingsForExport: (index, item) => item.settings,
    cloneSettings: settings => structuredClone(settings),
    buildExportFileName: (name, info, { sprocket, settings }) => `${name.replace(/\.\w+$/, '')}_converted${sprocket ? '_sprocket' : ''}`
      + `${info.bitDepth === 16 && info.format !== 'jpeg' && settings ? '_16bit' : ''}${info.extension}`,
    pickDesktopExportDirectory: async () => '/Users/me/Scans',
    // The pipeline: every frame of the job goes to its sink, in order. A
    // `kill` option stops the page after that many frames.
    runBatchExport: async (jobs, { exportInfo, options, sink }) => {
      const call = { jobs: jobs.map(job => ({ name: job.outputName, markerIndex: job.markerIndex, auto: Boolean(job.item.automaticSettings) })),
        exportInfo, options: structuredClone(options) };
      log.batches.push(call);
      for (const job of jobs) {
        if (context.killAfter !== null && call.written === context.killAfter) throw new Error('page died');
        await sink(job, { size: 1 });
        call.written = (call.written || 0) + 1;
        if (context.killAfter !== null && call.written === context.killAfter) context.markerAtKill = storage.get(jobMarker.JOB_MARKER_KEYS.export);
      }
      return { successCount: jobs.length, failCount: 0, cancelled: false };
    },
    killAfter: null, markerAtKill: null,
    writeBlobToDesktopDirectory: async (blob, directory, name) => { folderFiles.set(`${directory}/${name}`, true); return { saved: true, path: `${directory}/${name}` }; },
    saveBlob: async () => ({ saved: true }),
    learnFromExport: async () => {}, scheduleProjectRecovery: () => {},
    desktopBatchCancelController: null, desktopBatchExportState: { fileName: '' },
    setDesktopBatchExportState: () => {}, resetDesktopBatchExportState: () => {}, yieldForJob: async () => {},
    resetBatchExportStatuses: () => {}, showBatchExportOverlay: async () => {}, notifyBatchCancelled: () => {},
    showDesktopBatchExportSummary: () => {}, updateBatchOverlayProgress: () => {}, batchProgressLabel: () => '', batchOverlayProgress: null,
    getLoadingOverlay: () => ({ updateProgress: () => {}, hide: () => {} }),
    canUseBrowserZipStreaming: () => true,
    createBrowserZipWritable: async (name) => ({ fileName: name, writable: {} }),
    ZipStoreWriter: class { async addBlob() {} async close() {} async abort() {} },
    batchPipelineDiagnostics: { lastZip: null },
    isBrowserSavePickerCancel: () => false, showBrowserZipStreamSummary: () => {},
    isDesktopBatchExportLocked: () => false, singleExportActive: false,
    hiddenJobs: { setSafeMode: () => {} }, photoSessions: { clear() {} }, photoPreviews: { clear() {} }, photoPrefetch: { clear() {} }, thumbnailSources: { clear() {} },
    automaticRollRevision: 0,
    scheduleAutomaticRollImport: (frames, options) => { log.rolls.push({ frames: frames.length, options }); }
  });
  vm.runInContext(runtime, context);
  state.sprocketEdge = context.createSprocketEdgeSettings();
  return { context, state, log };
}

// Values made inside the page's realm compare by their JSON.
const plain = value => JSON.parse(JSON.stringify(value));
const file = (name, size) => ({ name, size, lastModified: 1_700_000_000_000 });
const queue = () => ['A1.DNG', 'A2.DNG', 'A3.DNG', 'A4.DNG'].map((name, i) => ({
  file: file(name, 1000 + i), settings: { id: i }, automaticSettings: i === 2, selected: true
}));
// The job's settings: TIFF 16-bit, quality 77, sprocket border with custom
// edge markings, dust removal on with AI repair off.
function setUpJob(state) {
  state.fileQueue = queue();
  Object.assign(state, { exportFormat: 'tiff', exportBitDepth: 16, jpegQuality: 77, exportSprocketHolesEnabled: true });
  state.sprocketEdge = { ...state.sprocketEdge, ...customEdge };
  state.dustRemoval = { ...state.dustRemoval, enabled: true, strength: 6, maxParticleSize: 28, ai: false };
}
// The originals added again after the reload; the recovery copy restores
// their recipes but not how they were made.
const reAdded = () => queue().map(item => ({ ...item, automaticSettings: false }));

// ---- Desktop folder: killed after frame 1, resumed with the job's options.
{
  const storage = Object.assign(memoryStorage(), { locks: fakeLocks() });
  const folderFiles = new Map();
  const first = page({ storage, desktop: true, folderFiles });
  setUpJob(first.state);
  first.context.killAfter = 1;
  await assert.rejects(first.context.exportBatchIndividuallyDesktop(), /page died/);
  const original = first.log.batches[0];
  assert.deepEqual(plain(original.options), plain({
    jpegQuality: 77, sprocket: true, sprocketEdge: first.context.createSprocketEdgeSettings({ ...DEFAULT_SPROCKET_EDGE_MARKINGS, ...customEdge }),
    dustRemoval: { enabled: true, strength: 6, maxParticleSize: 28, ai: false }
  }), 'the job captures every option it writes with');
  assert.equal(original.exportInfo.bitDepth, 16);
  // The page died after its first frame: its marker stays, its lock goes.
  storage.set(jobMarker.JOB_MARKER_KEYS.export, first.context.markerAtKill);
  storage.locks.held.clear();
  const killed = JSON.parse(first.context.markerAtKill);
  assert.equal(killed.v, 2);
  assert.deepEqual(killed.options.dustRemoval, { enabled: true, strength: 6, maxParticleSize: 28, ai: false }, 'the desktop marker keeps the AI switch');

  // The reloaded page: defaults on every control.
  const second = page({ storage, desktop: true, folderFiles });
  await second.context.checkInterruptedJobs();
  assert.equal(second.log.alerts.length, 1);
  assert.match(second.log.alerts[0], /^Export of 4 photos to .*Scans stopped after 1\. Add the original photos again/);
  // A later launch does not name it again, and it stays resumable.
  const third = page({ storage, desktop: true, folderFiles });
  await third.context.checkInterruptedJobs();
  assert.deepEqual(third.log.alerts, [], 'an interrupted job is named once');
  third.state.fileQueue = reAdded();
  await third.context.offerInterruptedJobResume({ rollFrames: [] });
  assert.equal(third.log.confirms.length, 1);
  assert.match(third.log.confirms[0], /^Resume the export of 4 photos to .*Scans\? 1 already written are skipped, and the rest keep their names\.$/,
    'a version-2 marker needs no note about its options');
  const resumed = third.log.batches[0];
  assert.deepEqual(plain(resumed.options), plain(original.options), 'the resume writes with the job\'s options, not the reloaded defaults');
  assert.deepEqual(plain(resumed.exportInfo), plain(original.exportInfo));
  assert.deepEqual(plain(resumed.jobs), plain(original.jobs.slice(1)), 'only the missing frames, same names, positions and automatic flags');
  assert.equal(third.state.jpegQuality, 92, 'the controls stay as the user has them');
  assert.equal(third.state.exportSprocketHolesEnabled, false);
  assert.equal(third.state.dustRemoval.enabled, false);
  assert.equal(third.state.dustRemoval.ai, true);
  assert.equal(third.state.sprocketEdge.text, DEFAULT_SPROCKET_EDGE_MARKINGS.text);
  assert.equal(storage.get(jobMarker.JOB_MARKER_KEYS.export), null, 'the resumed job ends and deletes its marker');
}

// ---- Browser ZIP: written again whole, with its format and options.
{
  const storage = Object.assign(memoryStorage(), { locks: fakeLocks() });
  const first = page({ storage });
  setUpJob(first.state);
  first.context.killAfter = 2;
  await assert.rejects(first.context.exportBatchAsZipBrowser(first.context.getSelectedFiles(), 'roll.zip'), /page died/);
  const original = first.log.batches[0];
  storage.set(jobMarker.JOB_MARKER_KEYS.export, first.context.markerAtKill);
  storage.locks.held.clear();
  const second = page({ storage });
  await second.context.checkInterruptedJobs();
  assert.match(second.log.alerts[0], /^ZIP export of 4 photos stopped after 2\. A partial ZIP cannot be resumed\./);
  second.state.fileQueue = reAdded().reverse();
  await second.context.offerInterruptedJobResume({ rollFrames: [] });
  assert.match(second.log.confirms[0], /^The ZIP export of 4 photos was interrupted and cannot be resumed\. Export the ZIP again\?$/);
  const restarted = second.log.batches[0];
  assert.equal(restarted.exportInfo.format, 'tiff', 'not the reloaded PNG default');
  assert.equal(restarted.exportInfo.bitDepth, 16);
  assert.deepEqual(plain(restarted.options), plain(original.options));
  assert.deepEqual(plain(restarted.jobs), plain(original.jobs), 'every frame, with its name, position and automatic flag');
  assert.ok(restarted.jobs.every(job => /_sprocket_16bit\.tiff$/.test(job.name)));
  assert.equal(second.state.exportFormat, 'png', 'the controls stay as the user has them');
}

// ---- Browser downloads from an earlier version: asks before it uses the
// current options for what its marker lacks.
{
  const storage = Object.assign(memoryStorage(), { locks: fakeLocks() });
  const files = queue().map(item => ({ ...item.file, output: `${item.file.name.replace('.DNG', '')}_converted_sprocket.png`, auto: false }));
  storage.set(jobMarker.JOB_MARKER_KEYS.export, JSON.stringify({
    v: 1, id: 'v1', kind: 'export-downloads', startedAt: Date.now() - 1000, files, written: [[0, ''], [1, '']],
    exportInfo: { format: 'png', bitDepth: 8, extension: '.png', mimeType: 'image/png' },
    options: { jpegQuality: 70, sprocket: true, dustRemoval: null }
  }));
  const next = page({ storage });
  next.state.dustRemoval = { ...next.state.dustRemoval, enabled: true, ai: false };
  await next.context.checkInterruptedJobs();
  assert.match(next.log.alerts[0], /^Export of 4 photos stopped after 2\./, 'a version-1 marker is read without a crash');
  next.state.fileQueue = reAdded();
  next.log.answers.push(false);
  await next.context.offerInterruptedJobResume({ rollFrames: [] });
  assert.match(next.log.confirms[0], /2 already downloaded are skipped\. It was started by an earlier version of the app, which did not record all of its settings: dust removal and the edge markings use the current ones\.$/);
  assert.deepEqual(next.log.batches, [], 'declined: nothing runs');
  assert.equal(storage.get(jobMarker.JOB_MARKER_KEYS.export), null, 'and the marker goes');
  // Accepted: the recorded fields, the current controls for the rest.
  storage.set(jobMarker.JOB_MARKER_KEYS.export, JSON.stringify({
    v: 1, id: 'v1b', kind: 'export-downloads', startedAt: Date.now() - 1000, files, written: [[0, '']],
    exportInfo: { format: 'png', bitDepth: 8, extension: '.png', mimeType: 'image/png' },
    options: { jpegQuality: 70, sprocket: true, dustRemoval: null }
  }));
  const accepted = page({ storage });
  accepted.state.dustRemoval = { ...accepted.state.dustRemoval, enabled: true, ai: false };
  await accepted.context.checkInterruptedJobs();
  accepted.state.fileQueue = reAdded();
  await accepted.context.offerInterruptedJobResume({ rollFrames: [] });
  const run = accepted.log.batches[0];
  assert.equal(run.options.jpegQuality, 70);
  assert.equal(run.options.sprocket, true);
  assert.deepEqual(plain(run.options.dustRemoval), { enabled: true, strength: 3, maxParticleSize: 40, ai: false });
  assert.deepEqual(plain(run.jobs.map(job => job.name)), files.slice(1).map(entry => entry.output));
}

// ---- Another tab's running job is not named; a roll analysis never is.
{
  const storage = Object.assign(memoryStorage(), { locks: fakeLocks() });
  const running = jobMarker.createJobMarker(storage);
  running.begin({ kind: 'export-downloads', files: queue().map(item => item.file) });
  const roll = jobMarker.createJobMarker(storage);
  roll.begin({ kind: 'roll-analysis', files: queue().map(item => item.file) });
  await new Promise(resolve => setImmediate(resolve));
  // The roll's page dies; the export's tab lives on.
  storage.locks.held.delete(jobMarker.jobOwnerLockName(roll.current.id));
  const other = page({ storage });
  await other.context.checkInterruptedJobs();
  assert.deepEqual(other.log.alerts, [], 'no message: the export still runs in its tab, and roll analysis is never named');
  assert.deepEqual(plain(other.context.interruptedJobs.map(marker => marker.kind)), ['roll-analysis']);
  // Restoring the roll resumes the analysis and says what stopped.
  other.state.fileQueue = reAdded();
  await other.context.offerInterruptedJobResume({ rollFrames: other.state.fileQueue });
  assert.equal(other.log.rolls.length, 1);
  assert.deepEqual(other.log.toasts, ['Roll analysis of 4 photos stopped before any was analysed. Resuming the roll analysis of 4 photos.']);
  assert.deepEqual(other.log.confirms, [], 'the running export is never offered');
  running.finish();
}

console.log('interruptedJobResume tests passed');
