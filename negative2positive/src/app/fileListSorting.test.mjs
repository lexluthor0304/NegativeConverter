import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeFileListSort, orderedFileIndices, selectionRangeIndices } from './fileListOrder.js';

// Run actual application handlers: sorted presentation must not renumber queue
// ownership, schedule a photo activation, or associate edits with another File.
const source = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
function functionSource(name) {
  const start = new RegExp(`^    function ${name}\\(`, 'm').exec(source)?.index;
  assert.notEqual(start, undefined, name);
  const end = source.indexOf('\n    }', start);
  return source.slice(start, end + '\n    }'.length);
}
const files = [
  ['frame10.png', 300], ['frame2.png', 100], ['frame1.png', 200], ['frame20.png', 400],
].map(([name, lastModified], index) => ({
  id: String(index), file: Object.freeze({ name, lastModified }),
  selected: false, settings: { exposure: index * 10 }, status: 'done', needs: index !== 0,
}));
const state = { fileQueue: [...files], currentFileIndex: 1, loadedFile: files[1].file, fileListSort: 'modified-desc' };
const storage = new Map();
let sorts = 0, ui = null, syncs = 0, locked = false;
const noop = () => {};
const context = vm.createContext({
  state, normalizeFileListSort, selectionRangeIndices,
  orderedFileIndices: (...args) => { sorts++; return orderedFileIndices(...args); },
  singleExportActive: false, isDesktopBatchExportLocked: () => locked,
  safeStorageSet: (key, value) => storage.set(key, value),
  studioWorkspace: { sync: () => syncs++ },
  photoSessions: { retainKeys: noop }, photoPreviews: { retainKeys: noop },
  document: { getElementById: id => ({ id }), body: { dataset: {} } },
  updateReviewFilter: noop, renderFileList: options => { ui = options; },
  reviewForItem: item => ({ needs: item.needs }),
  getLocalizedText: (_key, fallback) => fallback, getInterpolatedText: (_key, _values, fallback) => fallback,
  currentLang: 'en', i18n: { en: {} },
  updateAutoFrameButtons: noop, syncBatchUIState: noop, refreshThumbnailStates: noop,
  loadStudioThumbnails: noop, updateExportButtons: noop,
});
vm.runInContext('let fileOrderCache = null, fileSelectionAnchor = null, reviewFilter = false;\n'
  + ['getFileListOrder', 'getSelectedFiles', 'setFileListSort', 'updateFileListUI'].map(functionSource).join('\n'), context);
const order = () => [...context.getFileListOrder()];
const selected = () => files.map((item, index) => item.selected ? index : -1).filter(index => index >= 0);
assert.deepEqual(order(), [3, 0, 2, 1]);
assert.equal(sorts, 1);
context.updateFileListUI();
files[1].settings.exposure = 25;
context.updateFileListUI();
assert.equal(sorts, 1, 'status/thumbnail/adjustment redraws reuse the cached order');

const settings = files.map(item => item.settings);
const queue = state.fileQueue;
context.setFileListSort('name-asc');
assert.deepEqual(order(), [2, 1, 0, 3]);
assert.strictEqual(state.fileQueue, queue);
assert.equal(state.currentFileIndex, 1);
assert.strictEqual(state.loadedFile, files[1].file);
files.forEach((item, index) => assert.strictEqual(item.settings, settings[index]));
assert.deepEqual([...ui.order], [2, 1, 0, 3]);
assert.equal(syncs, 1);
assert.equal(storage.get('nc_photo_sort_v1'), 'name-asc');

ui.onToggleSelected(2, true);
ui.onToggleSelected(0, true, { range: true });
assert.deepEqual(selected(), [0, 1, 2], 'Shift selects contiguous displayed rows, not original indices 0..2 by coincidence');
files.forEach(item => { item.selected = false; });
ui.onToggleSelected(1, true);
ui.onToggleSelected(3, true, { range: true });
assert.deepEqual(selected(), [0, 1, 3], 'visual middle-to-end range excludes an original-index neighbor');
assert.deepEqual(Array.from(context.getSelectedFiles(), ({ item, index }) => [index, item.settings.exposure]),
  [[1, 25], [0, 0], [3, 30]], 'export order follows display while each setting retains its original owner');

files.forEach(item => { item.selected = false; });
vm.runInContext('reviewFilter = true', context);
context.updateFileListUI();
ui.onToggleSelected(2, true);
ui.onToggleSelected(3, true, { range: true });
assert.deepEqual(selected(), [1, 2, 3], 'hidden review-filtered rows are not selected by Shift');

// A pending cold activation remains keyed to the same object when reordered.
state.photoSwitchTarget = files[3];
state.photoSwitchPhase = 'loading';
context.setFileListSort('modified-asc');
assert.strictEqual(state.photoSwitchTarget, files[3]);
assert.equal(state.photoSwitchPhase, 'loading');
assert.equal(state.currentFileIndex, 1);
assert.deepEqual(order(), [1, 2, 0, 3]);
const previousSorts = sorts;
state.fileQueue.push({ id: '4', file: { name: 'frame0.png', lastModified: 50 }, selected: false });
assert.deepEqual(order(), [4, 1, 2, 0, 3]);
assert.equal(sorts, previousSorts + 1, 'appending files invalidates the display-order cache');
state.fileQueue = [...files];
assert.deepEqual(order(), [1, 2, 0, 3]);
assert.equal(sorts, previousSorts + 2, 'queue replacement also invalidates the cache');

locked = true;
context.setFileListSort('name-desc');
assert.equal(state.fileListSort, 'modified-asc', 'export locks freeze the captured output order');
locked = false;
context.singleExportActive = true;
context.setFileListSort('name-desc');
assert.equal(state.fileListSort, 'modified-asc');
context.singleExportActive = false;
context.setFileListSort('invalid');
assert.equal(state.fileListSort, 'modified-desc');
assert.equal(storage.get('nc_photo_sort_v1'), 'modified-desc');
assert.match(source, /fileListSort: normalizeFileListSort\(safeStorageGet\('nc_photo_sort_v1'\)\)/);
assert.match(source, /const selected = getSelectedFiles\(\);/, 'contact sheets share displayed selected order');
console.log('fileListSorting: actual sort/selection/export handlers preserve ownership, pending activation and cached order');
