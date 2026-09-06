// Roll project file: the whole roll state in one JSON document. File
// references (name, size, content hash), per-frame sanitised settings, the
// roll reference and analysis, lens parameters, roll metadata and frame
// order. Reopening matches the originals by hash, then by name, and reports
// what is missing or changed. A recovery copy lives in IndexedDB.

export const PROJECT_VERSION = 1;
export const PROJECT_KIND = 'neoanaloglab-roll';
export const PROJECT_EXTENSION = '.ncroll.json';
export const HASH_HEAD_BYTES = 1024 * 1024;

const RECOVERY_DB = 'nc_project_recovery';
const RECOVERY_STORE = 'rolls';
const RECOVERY_KEY = 'latest';

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Content hash for matching originals: SHA-256 over the first megabyte plus
 * the byte size, which is fast on large RAW files and still tells two scans
 * apart. Returns '' when no digest implementation is available.
 */
export async function hashFileForProject(file) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || !file || typeof file.slice !== 'function') return '';
  const head = new Uint8Array(await file.slice(0, HASH_HEAD_BYTES).arrayBuffer());
  const sizeBytes = new TextEncoder().encode(`|${file.size}`);
  const input = new Uint8Array(head.length + sizeBytes.length);
  input.set(head); input.set(sizeBytes, head.length);
  return toHex(await subtle.digest('SHA-256', input));
}

// Typed arrays (curve LUTs, look curves) become plain arrays in JSON; the
// app's sanitisers accept arrays back.
function jsonReplacer(_key, value) {
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return Array.from(value);
  return value;
}

/**
 * @param {object} input
 * @param {Array<{name:string,size:number,lastModified?:number,path?:string,hash?:string,settings?:object,studioColors?:object,selected?:boolean}>} input.files in roll order
 */
export function buildRollProject({ files = [], rollMetadata = {}, rollReference = null, rollAnalysis = null, lensCorrection = null, app = 'NeoAnalogLab Negative Converter', appVersion = '' } = {}) {
  return {
    kind: PROJECT_KIND,
    version: PROJECT_VERSION,
    app,
    appVersion,
    savedAt: new Date().toISOString(),
    roll: {
      metadata: rollMetadata || {},
      reference: rollReference || null,
      analysis: rollAnalysis || null
    },
    lensCorrection: lensCorrection || null,
    files: files.map((entry, index) => ({
      order: index,
      name: String(entry.name || ''),
      size: Number(entry.size) || 0,
      lastModified: Number(entry.lastModified) || 0,
      path: entry.path ? String(entry.path) : '',
      hash: entry.hash ? String(entry.hash) : '',
      selected: entry.selected !== false,
      settings: entry.settings || null,
      studioColors: entry.studioColors || null
    }))
  };
}

export function serializeRollProject(project) {
  return JSON.stringify(project, jsonReplacer, 1);
}

// ---- migrations ----
// Each step upgrades one version; keep them in order and cover every bump
// with a case in rollProject.test.mjs.
const MIGRATIONS = {
  // 0 -> 1: the unversioned prototype stored files under `frames` and the
  // metadata at the top level.
  0: (project) => ({
    ...project,
    version: 1,
    kind: PROJECT_KIND,
    roll: { metadata: project.metadata || {}, reference: project.rollReference || null, analysis: null },
    files: (project.frames || project.files || []).map((entry, index) => ({ order: index, selected: true, hash: '', path: '', lastModified: 0, ...entry }))
  })
};

export function migrateRollProject(project) {
  let current = { ...project };
  let version = Number.isInteger(current.version) ? current.version : 0;
  while (version < PROJECT_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) throw new Error(`No migration from project version ${version}`);
    current = step(current);
    version = current.version;
  }
  return current;
}

/** Parses and validates a project file's text. Throws with a readable message. */
export function parseRollProject(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('not-json');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not-a-project');
  if (raw.kind && raw.kind !== PROJECT_KIND) throw new Error('not-a-project');
  if (!raw.kind && !Array.isArray(raw.files) && !Array.isArray(raw.frames)) throw new Error('not-a-project');
  const version = Number.isInteger(raw.version) ? raw.version : 0;
  if (version > PROJECT_VERSION) throw new Error('newer-version');
  const project = migrateRollProject(raw);
  if (!Array.isArray(project.files)) throw new Error('not-a-project');
  project.files = project.files
    .filter((entry) => entry && typeof entry === 'object' && entry.name)
    .map((entry, index) => ({ ...entry, order: Number.isInteger(entry.order) ? entry.order : index }))
    .sort((a, b) => a.order - b.order);
  project.roll = project.roll && typeof project.roll === 'object' ? project.roll : { metadata: {}, reference: null, analysis: null };
  return project;
}

/**
 * Matches project entries to the files the user dropped: by hash first, then
 * by name and size, then by name alone (reported as changed). Entries with
 * no file are missing; files that belong to no entry are extra.
 */
export function matchProjectFiles(project, files, hashes = new Map()) {
  const remaining = new Set(files);
  const matched = []; const changed = []; const missing = [];
  const byHash = new Map();
  const byName = new Map();
  for (const file of files) {
    const hash = hashes.get(file);
    if (hash) byHash.set(hash, file);
    if (!byName.has(file.name)) byName.set(file.name, []);
    byName.get(file.name).push(file);
  }
  for (const entry of project.files) {
    let file = entry.hash ? byHash.get(entry.hash) : null;
    if (file && !remaining.has(file)) file = null;
    if (file) {
      matched.push({ entry, file });
      remaining.delete(file);
      continue;
    }
    const candidates = (byName.get(entry.name) || []).filter((f) => remaining.has(f));
    const exact = candidates.find((f) => f.size === entry.size);
    if (exact && (!entry.hash || !hashes.get(exact))) {
      matched.push({ entry, file: exact });
      remaining.delete(exact);
    } else if (candidates.length) {
      changed.push({ entry, file: candidates[0] });
      remaining.delete(candidates[0]);
    } else {
      missing.push(entry);
    }
  }
  return { matched, changed, missing, extra: Array.from(remaining) };
}

export function projectFileName(rollMetadata = {}) {
  const stem = (rollMetadata.rollName || rollMetadata.stock || rollMetadata.date || 'roll').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'roll';
  return `${stem}${PROJECT_EXTENSION}`;
}

export function isProjectFileName(name) {
  return /\.ncroll\.json$/i.test(name || '');
}

// ---- recovery copy (IndexedDB) ----
function openRecoveryDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    const request = indexedDB.open(RECOVERY_DB, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(RECOVERY_STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveProjectRecovery(text) {
  const db = await openRecoveryDb();
  if (!db) return false;
  try {
    const tx = db.transaction(RECOVERY_STORE, 'readwrite');
    await requestToPromise(tx.objectStore(RECOVERY_STORE).put({ text, savedAt: Date.now() }, RECOVERY_KEY));
    return true;
  } finally {
    db.close();
  }
}

export async function loadProjectRecovery() {
  const db = await openRecoveryDb();
  if (!db) return null;
  try {
    const tx = db.transaction(RECOVERY_STORE, 'readonly');
    const record = await requestToPromise(tx.objectStore(RECOVERY_STORE).get(RECOVERY_KEY));
    return record && typeof record.text === 'string' ? record : null;
  } finally {
    db.close();
  }
}

export async function clearProjectRecovery() {
  const db = await openRecoveryDb();
  if (!db) return;
  try {
    const tx = db.transaction(RECOVERY_STORE, 'readwrite');
    await requestToPromise(tx.objectStore(RECOVERY_STORE).delete(RECOVERY_KEY));
  } finally {
    db.close();
  }
}
