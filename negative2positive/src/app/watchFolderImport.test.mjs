// Watch-folder arrivals through the normal import path (#247 part 4), with the
// app's own handlers: batched, deduplicated before any read, never converted
// on arrival, and trickled captures counted across the session.
// Run with: node negative2positive/src/app/watchFolderImport.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const match = new RegExp(`^    (?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  return source.slice(match.index, source.indexOf('\n    }', match.index) + '\n    }'.length);
}
const runtime = ['receiveHotFolderArrival', 'hotFolderHas', 'queueHotFolderBatch', 'scheduleHotFolderRoll'].map(functionSource).join('\n');
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };

function fixture({ open = true } = {}) {
  const timers = new Map();
  let timerId = 0;
  const reads = [], queued = [], rolls = [], toasts = [], switched = [];
  const state = { fileQueue: [], originalImageData: open ? {} : null };
  const context = vm.createContext({
    state, console,
    hotFolder: { session: 'S' }, hotFolderEpoch: 1, hotFolderImports: Promise.resolve(), hotFolderFiles: [], hotFolderQuiet: null,
    hotFolderBatch: [], hotFolderBatchTimer: null, HOT_FOLDER_BATCH_MS: 1000,
    automaticRollPendingItems: new Set(),
    window: { __TAURI__: { core: { invoke: () => { throw new Error('reads go through readDesktopImportFile'); } } } },
    readDesktopImportFile: async payload => { reads.push(payload.name); return { name: payload.name, size: payload.size }; },
    addFilesToQueue: (files, options) => {
      queued.push({ names: Array.from(files, file => file.name), importId: options?.importId });
      const items = files.map(file => ({ file, importId: options?.importId, settings: null }));
      state.fileQueue.push(...items);
      return items;
    },
    scheduleAutomaticRollImport: (items, options) => rolls.push({ names: Array.from(items, item => item.file.name), options: { ...options } }),
    switchToFile: async index => { switched.push(index); state.originalImageData = {}; },
    showToast: text => toasts.push(text),
    getInterpolatedText: (key, values, fallback) => fallback,
    getLocalizedText: (key, fallback) => fallback,
    processFileWithSettings: () => { throw new Error('arrivals are not converted on arrival'); },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id)
  });
  vm.runInContext(runtime, context);
  const fire = async ms => {
    const entry = [...timers].find(([, timer]) => timer.ms === ms);
    assert.ok(entry, `timer ${ms} scheduled`);
    timers.delete(entry[0]); entry[1].fn(); await flush();
  };
  const arrive = async (name, size = 100) => { context.receiveHotFolderArrival({ name, size, session: 'S' }, 1); await flush(); };
  return { context, state, timers, reads, queued, rolls, toasts, switched, fire, arrive };
}

// "Import existing files too": one scan's arrivals reach addFilesToQueue in
// one call, whose own roll trigger takes them; a name and size already
// queued (or read for this batch) is never read again.
{
  const f = fixture();
  for (const name of ['a.dng', 'b.dng', 'c.dng', 'b.dng']) await f.arrive(name);
  assert.deepEqual(f.reads, ['a.dng', 'b.dng', 'c.dng'], 'a duplicate within the batch is not read');
  assert.equal(f.queued.length, 0, 'nothing is queued before the batch window closes');
  await f.fire(1000);
  assert.deepEqual(f.queued, [{ names: ['a.dng', 'b.dng', 'c.dng'], importId: 'watch:S' }]);
  assert.deepEqual(f.toasts, ['Imported 3 files']);
  assert.equal(f.context.hotFolderFiles.length, 0, 'a batch of three is already a scheduled roll import');
  assert.equal(f.timers.size, 0, 'no quiet timer for it');
  await f.arrive('a.dng');
  assert.equal(f.reads.length, 3, 'an arrival whose name and size are queued makes no read');
  await f.arrive('a.dng', 101);
  assert.equal(f.reads.length, 4, 'a changed size is a new file');
}

// Trickled captures: each is queued alone; the quiet timer forms a roll from
// the session's unanalysed watch frames once there are three, and keeps
// fewer for the next capture.
{
  const f = fixture({ open: false });
  await f.arrive('1.dng'); await f.fire(1000);
  assert.deepEqual(f.switched, [0], 'the first arrival opens when nothing is open');
  await f.arrive('2.dng'); await f.fire(1000);
  await f.fire(2500);
  assert.equal(f.rolls.length, 0, 'two frames are not a roll');
  assert.equal(f.context.hotFolderFiles.length, 2, 'and stay counted');
  await f.arrive('3.dng'); await f.fire(1000);
  assert.deepEqual(f.queued.map(entry => entry.names), [['1.dng'], ['2.dng'], ['3.dng']]);
  await f.fire(2500);
  assert.deepEqual(f.rolls, [{ names: ['1.dng', '2.dng', '3.dng'], options: { prepared: true } }]);
  assert.equal(f.context.hotFolderFiles.length, 0);
  assert.deepEqual(f.switched, [0], 'later arrivals do not take the editor');
}
{
  // Frames a roll analysis covered, or a roll import owns, are not counted.
  const f = fixture();
  for (const name of ['1.dng', '2.dng', '3.dng', '4.dng']) { await f.arrive(name); await f.fire(1000); }
  f.state.fileQueue[0].settings = { rollFrame: { rollId: 'r' } };
  f.context.automaticRollPendingItems.add(f.state.fileQueue[1]);
  await f.fire(2500);
  assert.equal(f.rolls.length, 0);
  assert.deepEqual(Array.from(f.context.hotFolderFiles, item => item.file.name), ['3.dng', '4.dng']);
}
{
  // A stopped watch (new epoch) queues nothing it read before.
  const f = fixture();
  await f.arrive('late.dng');
  f.context.hotFolderEpoch = 2;
  await f.fire(1000);
  assert.equal(f.queued.length, 0);
}

console.log('watchFolderImport: batched arrivals, reads skipped for queued files, no conversion on arrival, trickled rolls');
