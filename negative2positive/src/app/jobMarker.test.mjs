import assert from 'node:assert/strict';
import {
  createJobMarker, readJobMarker, readJobMarkers, clearJobMarker, sanitizeJobMarker, matchJobFiles, planResumedExport,
  resumedJobMarker, jobNeedsSafeMode, interruptedJobMessage, JOB_MARKER_KEY, JOB_MARKER_KEYS, JOB_MARKER_MAX_AGE_MS, JOB_KINDS
} from './jobMarker.js';
import { i18n } from './i18n.js';
import { interpolateText } from './textUtils.js';

function memoryStorage() {
  const map = new Map();
  let writes = 0;
  return {
    get: key => (map.has(key) ? map.get(key) : null),
    set: (key, value) => { writes++; map.set(key, String(value)); },
    remove: key => { map.delete(key); },
    get writes() { return writes; },
    map
  };
}

const file = (name, size, lastModified = 1_700_000_000_000) => ({ name, size, lastModified });
const roll = Array.from({ length: 116 }, (_, i) => ({
  ...file(`L10${String(i).padStart(5, '0')}.DNG`, 60_000_000 + i),
  output: `L10${String(i).padStart(5, '0')}_converted_16bit.tiff`
}));
let clock = 1_800_000_000_000;
const now = () => clock;

// A job writes the marker up front, records each finished frame and deletes it at the end.
{
  const storage = memoryStorage();
  const marker = createJobMarker(storage, { now });
  const begun = marker.begin({
    kind: 'export-folder', files: roll, destination: '/Users/me/Scans',
    exportInfo: { format: 'tiff', bitDepth: 16, extension: '.tiff', mimeType: 'image/tiff' },
    options: { jpegQuality: 92, sprocket: false, dustRemoval: null }
  });
  assert.equal(begun.files.length, 116);
  const stored = storage.get(JOB_MARKER_KEY);
  assert.ok(stored.length < 16 * 1024, `a 116-frame marker stays a few KB (${stored.length} B)`);
  for (let i = 0; i < 47; i++) marker.record(i, `/Users/me/Scans/${roll[i].output}`);
  marker.record(3, '/dup');
  marker.record(999, '/out-of-range');
  const read = readJobMarker(storage, { now: clock });
  assert.equal(read.kind, 'export-folder');
  assert.equal(read.written.length, 47, 'every recorded frame, once');
  assert.deepEqual(read.written[3], [3, `/Users/me/Scans/${roll[3].output}`]);
  assert.equal(read.destination, '/Users/me/Scans');
  assert.equal(read.exportInfo.bitDepth, 16);
  assert.equal(read.attempt, 0);
  marker.finish();
  assert.equal(storage.get(JOB_MARKER_KEY), null);
  assert.equal(readJobMarker(storage), null);
}

// Garbage, other versions and stale markers are dropped.
{
  const storage = memoryStorage();
  storage.set(JOB_MARKER_KEY, '{not json');
  assert.equal(readJobMarker(storage), null);
  assert.equal(storage.get(JOB_MARKER_KEY), null, 'an unreadable marker is removed');
  storage.set(JOB_MARKER_KEY, JSON.stringify({ v: 99, kind: 'export-folder', startedAt: clock, files: roll }));
  assert.equal(readJobMarker(storage, { now: clock }), null);
  storage.set(JOB_MARKER_KEY, JSON.stringify({ v: 1, kind: 'mystery', startedAt: clock, files: roll }));
  assert.equal(readJobMarker(storage, { now: clock }), null);
  storage.set(JOB_MARKER_KEY, JSON.stringify({ v: 1, kind: 'export-zip', startedAt: clock - JOB_MARKER_MAX_AGE_MS - 1, files: roll }));
  assert.equal(readJobMarker(storage, { now: clock }), null, 'older than the recovery copy');
  assert.equal(sanitizeJobMarker({ v: 1, kind: 'export-zip', startedAt: clock, files: [] }, { now: clock }), null);
  const flagged = sanitizeJobMarker({ v: 1, kind: 'export-folder', startedAt: clock, files: [{ ...roll[0], auto: true }, roll[1]] }, { now: clock });
  assert.deepEqual(flagged.files.map(entry => entry.auto), [true, false], 'automatic recipes are remembered per frame');
  const throwing = { get() { throw new Error('blocked'); }, set() { throw new Error('blocked'); }, remove() { throw new Error('blocked'); } };
  assert.equal(readJobMarker(throwing), null, 'blocked storage reads as no marker');
  const marker = createJobMarker(throwing, { now });
  assert.ok(marker.begin({ kind: 'export-zip', files: roll }), 'a job still runs when storage is blocked');
  marker.record(0); marker.finish();
}

// Queue matching: exact first, then name + size; each item used once.
{
  const items = [
    { file: file('b.nef', 20) }, { file: file('a.nef', 10, 5) }, { file: file('a.nef', 10, 7) }, { file: file('c.nef', 30) }
  ];
  const marker = { files: [{ ...file('a.nef', 10, 7) }, { ...file('a.nef', 10, 9) }, { ...file('b.nef', 20) }, { ...file('d.nef', 40) }] };
  const matched = matchJobFiles(marker, items);
  assert.equal(matched[0], items[2], 'exact timestamp wins');
  assert.equal(matched[1], items[1], 'a re-added copy with a new timestamp matches by name and size');
  assert.equal(matched[2], items[0]);
  assert.equal(matched[3], null, 'a missing original');
}

// Resume plan: the full list in order and the original names, minus recorded
// frames whose file exists. A recorded frame whose file is gone is written again.
{
  const storage = memoryStorage();
  const marker = createJobMarker(storage, { now });
  marker.begin({ kind: 'export-folder', files: roll.slice(0, 20), destination: '/out' });
  for (let i = 0; i < 8; i++) marker.record(i, `/out/${roll[i].output}`);
  const interrupted = readJobMarker(storage, { now: clock });
  const items = roll.slice(0, 20).reverse().map(entry => ({ file: file(entry.name, entry.size) }));
  const asked = [];
  const plan = await planResumedExport(interrupted, items, {
    exists: async (index, path) => { asked.push(index); return index !== 5 && path.startsWith('/out/'); }
  });
  assert.deepEqual(asked, [0, 1, 2, 3, 4, 5, 6, 7], 'only recorded frames are checked');
  assert.deepEqual(plan.skipped, [0, 1, 2, 3, 4, 6, 7]);
  assert.deepEqual(plan.jobs.map(job => job.markerIndex), [5, ...Array.from({ length: 12 }, (_, i) => i + 8)]);
  assert.deepEqual(plan.jobs.map(job => job.outputName), [roll[5].output, ...roll.slice(8, 20).map(entry => entry.output)],
    'resumed frames keep the names of the original job list');
  assert.equal(plan.jobs[0].item.file.name, roll[5].name);
  assert.deepEqual(plan.missing, []);
  // Browser downloads cannot be checked: every recorded frame counts as written.
  const downloads = await planResumedExport(interrupted, items);
  assert.equal(downloads.jobs.length, 12);
  // A missing original is reported and left out.
  const fewer = await planResumedExport(interrupted, items.slice(1));
  assert.equal(fewer.missing.length, 1);
  assert.equal(fewer.jobs.length, 11);

  // The resumed job keeps the records and counts the attempt.
  const next = createJobMarker(storage, { now });
  next.begin(resumedJobMarker(interrupted));
  const again = readJobMarker(storage, { now: clock });
  assert.equal(again.attempt, 1);
  assert.equal(again.written.length, 8);
  assert.equal(jobNeedsSafeMode(interrupted), false);
  assert.equal(jobNeedsSafeMode(again), true, 'a resumed job that stopped again resumes with the hidden limits');
}

// Roll analysis records analysed frames and the frames the user edited.
{
  const storage = memoryStorage();
  const marker = createJobMarker(storage, { now });
  marker.begin({ kind: 'roll-analysis', files: roll.slice(0, 40) });
  for (let i = 0; i < 20; i++) marker.record(i);
  marker.setEdited([7, 3, 3, 99]);
  const writes = storage.writes;
  marker.setEdited([3, 7]);
  assert.equal(storage.writes, writes, 'an unchanged edit set is not rewritten');
  assert.equal(readJobMarker(storage, { now: clock }), null, 'roll analysis has its own key');
  const read = readJobMarker(storage, { key: JOB_MARKER_KEYS.roll, now: clock });
  assert.equal(read.written.length, 20);
  assert.deepEqual(read.edited, [3, 7]);
  // An export can run at the same time; both are found at boot, export first.
  const exporting = createJobMarker(storage, { now });
  exporting.begin({ kind: 'export-downloads', files: roll.slice(0, 3) });
  assert.deepEqual(readJobMarkers(storage, { now: clock }).map(m => m.kind), ['export-downloads', 'roll-analysis']);
  exporting.finish();
  marker.finish();
  assert.deepEqual(readJobMarkers(storage, { now: clock }), []);
}

// A newer job of the same family takes the key over; the older one stops
// writing and never deletes the newer marker.
{
  const storage = memoryStorage();
  const older = createJobMarker(storage, { now });
  older.begin({ kind: 'roll-analysis', files: roll.slice(0, 5) });
  const newer = createJobMarker(storage, { now });
  newer.begin({ kind: 'roll-analysis', files: roll.slice(5, 9) });
  older.record(0);
  older.finish();
  const read = readJobMarker(storage, { key: JOB_MARKER_KEYS.roll, now: clock });
  assert.equal(read.files.length, 4, 'the newer marker survives');
  assert.equal(read.written.length, 0);
  newer.record(1);
  assert.equal(readJobMarker(storage, { key: JOB_MARKER_KEYS.roll, now: clock }).written.length, 1);
  newer.finish();
  assert.equal(storage.get(JOB_MARKER_KEYS.roll), null);
}

// Dismissing an interrupted job never deletes a newer job's marker.
{
  const storage = memoryStorage();
  createJobMarker(storage, { now }).begin({ kind: 'export-zip', files: roll.slice(0, 2) });
  const interrupted = readJobMarker(storage, { now: clock });
  createJobMarker(storage, { now }).begin({ kind: 'export-folder', files: roll.slice(0, 3), destination: '/x' });
  assert.equal(clearJobMarker(storage, interrupted), false);
  assert.equal(readJobMarker(storage, { now: clock }).kind, 'export-folder');
  assert.equal(clearJobMarker(storage, readJobMarker(storage, { now: clock })), true);
  assert.equal(storage.get(JOB_MARKER_KEY), null);
}

// A resume keeps only the records of the frames it skips.
{
  const storage = memoryStorage();
  const marker = createJobMarker(storage, { now });
  marker.begin({ kind: 'export-folder', files: roll.slice(0, 6), destination: '/out' });
  for (let i = 0; i < 4; i++) marker.record(i, `/out/${i}`);
  const interrupted = readJobMarker(storage, { now: clock });
  const next = resumedJobMarker(interrupted, { keep: [0, 1, 3] });
  assert.deepEqual(next.written, [[0, '/out/0'], [1, '/out/1'], [3, '/out/3']]);
  assert.equal(next.attempt, 1);
}

// The boot sentence counts finished frames (R1-150): never a frame position,
// and its own sentence when none finished, in every language.
{
  const render = (lang, marker) => {
    const { key, values } = interruptedJobMessage(marker, { folder: 'Scans' });
    assert.ok(i18n[lang][key], `${lang}.${key} exists`);
    return interpolateText(i18n[lang][key], values);
  };
  const markerOf = (kind, done) => ({ kind, files: roll, written: Array.from({ length: done }, (_, i) => [i, '']) });
  for (const kind of JOB_KINDS) {
    for (const lang of ['zh', 'en', 'ja']) {
      const none = render(lang, markerOf(kind, 0));
      const some = render(lang, markerOf(kind, 47));
      assert.ok(none.includes('116') && some.includes('116'), `${lang} ${kind}: names the total`);
      assert.ok(!/(^|[^0-9])0([^0-9]|$)/.test(none), `${lang} ${kind}: no "0" when none finished: ${none}`);
      assert.ok(some.includes('47'), `${lang} ${kind}: names the count`);
      assert.ok(!/第\s*47|47\s*枚目|47(st|nd|rd|th)/.test(some), `${lang} ${kind}: a count, not a position: ${some}`);
      if (kind === 'export-folder') assert.ok(none.includes('Scans') && some.includes('Scans'));
    }
  }
  assert.equal(render('en', markerOf('export-folder', 47)), 'Export of 116 photos to Scans stopped after 47.');
  assert.equal(render('en', markerOf('export-folder', 0)), 'Export of 116 photos to Scans stopped before any was written.');
  assert.equal(render('zh', markerOf('export-folder', 47)), '导出 116 张照片到 Scans 时，已完成 47 张后中断。');
  assert.equal(render('zh', markerOf('export-zip', 0)), '116 张照片的 ZIP 导出尚未写入任何一张就中断了。不完整的 ZIP 无法续传。');
  assert.equal(render('ja', markerOf('export-folder', 47)), 'Scans への 116 枚の書き出しは、47 枚を書き出した後に止まりました。');
  assert.equal(render('ja', markerOf('roll-analysis', 0)), '116 枚のロール解析は、1 枚も解析しないうちに止まりました。');
  // The English fallbacks (a missing key) read the same way.
  assert.equal(interruptedJobMessage(markerOf('export-downloads', 0)).fallback, 'Export of 116 photos stopped before any was saved.');
  assert.equal(interruptedJobMessage(markerOf('export-downloads', 47)).fallback, 'Export of 116 photos stopped after 47.');
}

console.log('jobMarker tests passed');
