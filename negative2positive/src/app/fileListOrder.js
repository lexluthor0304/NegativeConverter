export const DEFAULT_FILE_LIST_SORT = 'modified-desc';

const sortModes = new Set(['modified-desc', 'modified-asc', 'name-asc', 'name-desc']);
// A fixed locale keeps the order independent of the application's language.
const filenameCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'accent' });

export function normalizeFileListSort(value) {
  return sortModes.has(value) ? value : DEFAULT_FILE_LIST_SORT;
}

function modificationTime(file) {
  const value = file?.lastModified;
  return Number.isFinite(value) && value > 0 && !Number.isNaN(new Date(value).getTime())
    ? value : null;
}

// Only the displayed indices change: caches, edits and in-flight work continue
// to refer to the original items and their original source indices.
export function orderedFileIndices(items, mode = DEFAULT_FILE_LIST_SORT) {
  const sort = normalizeFileListSort(mode);
  const byName = sort.startsWith('name-');
  const direction = sort.endsWith('-desc') ? -1 : 1;
  return items.map((item, index) => ({
    index,
    name: String(item.file?.name ?? ''),
    modified: modificationTime(item.file),
  })).sort((a, b) => {
    if (byName) return direction * filenameCollator.compare(a.name, b.name) || a.index - b.index;
    if (a.modified === null) return b.modified === null ? a.index - b.index : 1;
    if (b.modified === null) return -1;
    return direction * (a.modified - b.modified) || a.index - b.index;
  }).map(item => item.index);
}

// The caller supplies its displayed (and, if needed, filtered) order.
export function selectionRangeIndices(order, anchorIndex, targetIndex) {
  const target = order.indexOf(targetIndex);
  if (target === -1) return [];
  const anchor = order.indexOf(anchorIndex);
  if (anchor === -1) return [targetIndex];
  return order.slice(Math.min(anchor, target), Math.max(anchor, target) + 1);
}
