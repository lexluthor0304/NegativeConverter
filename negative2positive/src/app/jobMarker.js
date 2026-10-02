/**
 * Job marker (#241): a few KB in localStorage that says a long job was
 * running, so the page that loads after a kill (WebKit's memory limit on
 * macOS, a renderer crash in Chrome, a discarded tab) can name what stopped
 * and resume it.
 *
 * A job writes the marker before it starts, records each frame once its sink
 * has returned (for a desktop folder that is after the native rename or copy
 * and sync, so a recorded file is complete) and deletes the marker when it
 * ends or is cancelled. A marker that is still there at boot belongs to a job
 * that was interrupted.
 *
 * Pure: storage is injected ({ get, set, remove }).
 */

// One key per job family: a batch export and a roll analysis can run together.
export const JOB_MARKER_KEYS = Object.freeze({ export: 'nc_job_marker_export_v1', roll: 'nc_job_marker_roll_v1' });
export const JOB_MARKER_KEY = JOB_MARKER_KEYS.export;
export const JOB_MARKER_VERSION = 1;
export const JOB_KINDS = Object.freeze(['export-folder', 'export-downloads', 'export-zip', 'roll-analysis']);
export const jobMarkerKeyFor = kind => (kind === 'roll-analysis' ? JOB_MARKER_KEYS.roll : JOB_MARKER_KEYS.export);
// Like the project recovery copy: older markers are not offered.
export const JOB_MARKER_MAX_AGE_MS = 14 * 24 * 3600 * 1000;

const isIndex = (value, total) => Number.isInteger(value) && value >= 0 && value < total;

function sanitizeFile(entry) {
  return {
    name: String(entry?.name || ''),
    size: Math.max(0, Number(entry?.size) || 0),
    lastModified: Math.max(0, Number(entry?.lastModified) || 0),
    output: entry?.output ? String(entry.output) : '',
    auto: Boolean(entry?.auto)
  };
}

function sanitizeExportInfo(info) {
  if (!info || typeof info !== 'object') return null;
  return {
    format: String(info.format || ''),
    bitDepth: Number(info.bitDepth) === 16 ? 16 : 8,
    extension: String(info.extension || ''),
    mimeType: String(info.mimeType || '')
  };
}

/** A marker as stored, or null when it is not one this version can resume. */
export function sanitizeJobMarker(value, { now = Date.now() } = {}) {
  if (!value || typeof value !== 'object' || value.v !== JOB_MARKER_VERSION) return null;
  if (!JOB_KINDS.includes(value.kind)) return null;
  const files = Array.isArray(value.files) ? value.files.map(sanitizeFile) : [];
  const total = files.length;
  if (!total) return null;
  const startedAt = Number(value.startedAt) || 0;
  if (!startedAt || now - startedAt > JOB_MARKER_MAX_AGE_MS) return null;
  const seen = new Set();
  const written = [];
  for (const record of Array.isArray(value.written) ? value.written : []) {
    const [index, path] = Array.isArray(record) ? record : [];
    if (!isIndex(index, total) || seen.has(index)) continue;
    seen.add(index);
    written.push([index, path ? String(path) : '']);
  }
  const indices = (list) => [...new Set((Array.isArray(list) ? list : []).filter(index => isIndex(index, total)))];
  return {
    v: JOB_MARKER_VERSION,
    id: value.id ? String(value.id) : '',
    kind: value.kind,
    startedAt,
    attempt: Math.max(0, Math.floor(Number(value.attempt) || 0)),
    destination: value.destination ? String(value.destination) : '',
    exportInfo: sanitizeExportInfo(value.exportInfo),
    options: value.options && typeof value.options === 'object' ? structuredClone(value.options) : {},
    files,
    written,
    edited: indices(value.edited)
  };
}

export function readJobMarker(storage, { key = JOB_MARKER_KEY, now = Date.now() } = {}) {
  let text = null;
  try { text = storage.get(key); } catch { return null; }
  if (!text) return null;
  let parsed = null;
  try { parsed = sanitizeJobMarker(JSON.parse(text), { now }); } catch { parsed = null; }
  if (!parsed) {
    try { storage.remove(key); } catch { /* storage unavailable */ }
  }
  return parsed;
}

let nextMarkerId = 0;

/**
 * One job's marker. begin() writes it, record() adds a finished frame by its
 * index in `files`, finish() deletes it. A newer job of the same family takes
 * the key over; the older one then stops writing and never deletes it.
 */
export function createJobMarker(storage, { key = null, now = () => Date.now() } = {}) {
  let current = null;
  let storageKey = key;
  const owned = () => {
    let stored = null;
    try { stored = storage.get(storageKey); } catch { return true; }
    if (!stored) return true;
    try { return JSON.parse(stored)?.id === current.id; } catch { return true; }
  };
  const save = () => {
    if (!owned()) { current = null; return; }
    try { storage.set(storageKey, JSON.stringify(current)); } catch { /* storage full or blocked */ }
  };
  return {
    begin({ kind, files, destination = '', exportInfo = null, options = {}, attempt = 0, written = [] }) {
      storageKey = key || jobMarkerKeyFor(kind);
      const id = `${now().toString(36)}-${(nextMarkerId++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      current = sanitizeJobMarker({
        v: JOB_MARKER_VERSION, id, kind, startedAt: now(), attempt, destination, exportInfo, options, files, written
      }, { now: now() });
      if (current) {
        try { storage.set(storageKey, JSON.stringify(current)); } catch { /* storage full or blocked */ }
      }
      return current;
    },
    record(index, path = '') {
      if (!current || !isIndex(index, current.files.length)) return;
      if (current.written.some(([done]) => done === index)) return;
      current.written.push([index, path ? String(path) : '']);
      save();
    },
    /** Frames the user edited while the job ran keep their saved recipe on resume. */
    setEdited(indices) {
      if (!current) return;
      const next = [...new Set(indices.filter(index => isIndex(index, current.files.length)))].sort((a, b) => a - b);
      if (next.join() === current.edited.join()) return;
      current.edited = next;
      save();
    },
    finish() {
      if (current && owned()) {
        try { storage.remove(storageKey); } catch { /* storage unavailable */ }
      }
      current = null;
    },
    get current() { return current; }
  };
}

function fileKey(entry) {
  return `${entry.name}\u0000${entry.size}\u0000${entry.lastModified || 0}`;
}

/**
 * The queue item for each marker file, in marker order (null when missing):
 * name, size and modification time first, then name and size (a re-added
 * copy can carry a new timestamp).
 */
export function matchJobFiles(marker, items) {
  const exact = new Map();
  const loose = new Map();
  for (const item of items) {
    const file = item?.file;
    if (!file) continue;
    const entry = { name: file.name, size: file.size, lastModified: file.lastModified || 0 };
    if (!exact.has(fileKey(entry))) exact.set(fileKey(entry), item);
    const looseKey = `${entry.name}\u0000${entry.size}`;
    if (!loose.has(looseKey)) loose.set(looseKey, []);
    loose.get(looseKey).push(item);
  }
  const used = new Set();
  return marker.files.map((entry) => {
    let item = exact.get(fileKey(entry));
    if (!item || used.has(item)) item = (loose.get(`${entry.name}\u0000${entry.size}`) || []).find(candidate => !used.has(candidate));
    if (!item) return null;
    used.add(item);
    return item;
  });
}

/**
 * What a resumed per-file export writes: the full original job list (same
 * order, same names), minus the frames recorded as written whose file still
 * exists. `exists(index, path)` answers for recorded frames; without it every
 * recorded frame is taken as present (browser downloads cannot be checked).
 */
export async function planResumedExport(marker, items, { exists = null } = {}) {
  const matched = matchJobFiles(marker, items);
  const written = new Map(marker.written);
  const jobs = [];
  const skipped = [];
  const missing = [];
  for (let index = 0; index < marker.files.length; index++) {
    const item = matched[index];
    if (!item) { missing.push(marker.files[index]); continue; }
    if (written.has(index)) {
      const present = exists ? await exists(index, written.get(index)) : true;
      if (present) { skipped.push(index); continue; }
    }
    jobs.push({ markerIndex: index, item, outputName: marker.files[index].output });
  }
  return { jobs, skipped, missing };
}

/**
 * The next run of an interrupted job: one attempt later, keeping the records
 * of the frames it skips (by default all of them).
 */
export function resumedJobMarker(marker, { keep = null } = {}) {
  const kept = keep ? new Set(keep) : null;
  return {
    kind: marker.kind,
    files: marker.files,
    destination: marker.destination,
    exportInfo: marker.exportInfo,
    options: marker.options,
    attempt: marker.attempt + 1,
    written: kept ? marker.written.filter(([index]) => kept.has(index)) : marker.written
  };
}

/** Deletes an interrupted job's marker unless a newer job took its key. */
export function clearJobMarker(storage, marker) {
  const key = jobMarkerKeyFor(marker?.kind);
  try {
    const stored = storage.get(key);
    if (stored && JSON.parse(stored)?.id !== marker.id) return false;
    storage.remove(key);
    return true;
  } catch {
    return false;
  }
}

/** Every interrupted job, export first. */
export function readJobMarkers(storage, { now = Date.now() } = {}) {
  return [JOB_MARKER_KEYS.export, JOB_MARKER_KEYS.roll]
    .map(key => readJobMarker(storage, { key, now }))
    .filter(Boolean);
}

/**
 * The boot message's sentence for an interrupted job: `{ key, values,
 * fallback }` for the page's translator. `done` is a count of finished
 * frames, not a position (lanes finish frames out of order); none finished
 * has its own sentence.
 */
export function interruptedJobMessage(marker, { folder = '' } = {}) {
  const total = String(marker.files.length);
  const count = marker.written.length;
  const done = String(count);
  const none = count === 0;
  if (marker.kind === 'export-folder') {
    return {
      key: none ? 'interruptedExportFolderNone' : 'interruptedExportFolder',
      values: { total, done, folder },
      fallback: none ? `Export of ${total} photos to ${folder} stopped before any was written.` : `Export of ${total} photos to ${folder} stopped after ${done}.`
    };
  }
  if (marker.kind === 'export-zip') {
    return {
      key: none ? 'interruptedExportZipNone' : 'interruptedExportZip',
      values: { total, done },
      fallback: (none ? `ZIP export of ${total} photos stopped before any was added.` : `ZIP export of ${total} photos stopped after ${done}.`) + ' A partial ZIP cannot be resumed.'
    };
  }
  if (marker.kind === 'roll-analysis') {
    return {
      key: none ? 'interruptedRollAnalysisNone' : 'interruptedRollAnalysis',
      values: { total, done },
      fallback: none ? `Roll analysis of ${total} photos stopped before any was analysed.` : `Roll analysis of ${total} photos stopped after ${done}.`
    };
  }
  return {
    key: none ? 'interruptedExportDownloadsNone' : 'interruptedExportDownloads',
    values: { total, done },
    fallback: none ? `Export of ${total} photos stopped before any was saved.` : `Export of ${total} photos stopped after ${done}.`
  };
}

/**
 * A resumed job that was killed again runs its next attempt with the hidden
 * limits even while visible (one lane, caches off).
 */
export function jobNeedsSafeMode(marker) {
  return Boolean(marker && marker.attempt >= 1);
}
