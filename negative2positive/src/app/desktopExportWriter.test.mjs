import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeDesktopBlob, EXPORT_CHUNK_BYTES } from './desktopExportWriter.js';

// JS と Rust のチャンク上限は同じリリースで一致していなければならない。
{
  const rust = readFileSync(new URL('../../../src-tauri/src/export_stream.rs', import.meta.url), 'utf8');
  const match = /const CHUNK_LIMIT: usize = ([\d\s*]+);/.exec(rust);
  assert.ok(match, 'CHUNK_LIMIT is declared in export_stream.rs');
  const limit = match[1].split('*').reduce((product, factor) => product * Number(factor.trim()), 1);
  assert.equal(limit, EXPORT_CHUNK_BYTES, 'EXPORT_CHUNK_BYTES must equal the Rust CHUNK_LIMIT');
  assert.equal(EXPORT_CHUNK_BYTES, 8 * 1024 * 1024);
}

// A Blob whose slice reads are observable (and deferred, like a real read).
function instrumentedBlob(bytes, events) {
  const blob = new Blob([bytes]);
  blob.arrayBuffer = () => { throw new Error('Blob全体の読込は禁止'); };
  const slice = blob.slice.bind(blob);
  blob.slice = (start, end) => {
    const part = slice(start, end);
    return {
      arrayBuffer: async () => {
        events.push(`read ${start}`);
        await new Promise((resolve) => setTimeout(resolve, 1));
        return part.arrayBuffer();
      }
    };
  };
  return blob;
}

{
  const bytes = new Uint8Array(EXPORT_CHUNK_BYTES * 2 + 17);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const events = [];
  const blob = instrumentedBlob(bytes, events);
  const chunks = [];
  const progress = [];
  let active = false;
  const result = await writeDesktopBlob(blob, { path: '/chosen/scan.tiff' }, async (command, args, options) => {
    assert.equal(active, false, 'チャンクは同時送信しない');
    active = true;
    try {
      if (command === 'begin_export_write') {
        assert.equal(args.expectedBytes, bytes.length);
        return 'session';
      }
      if (command === 'append_export_chunk') {
        assert.ok(args instanceof Uint8Array && args.length <= EXPORT_CHUNK_BYTES);
        assert.equal(options.headers['x-export-id'], 'session');
        events.push(`append ${chunks.reduce((n, c) => n + c.length, 0)} start`);
        // Keep the append pending long enough for the read-ahead to start.
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push('append end');
        chunks.push(args);
        return;
      }
      assert.equal(command, 'finish_export_write');
      return { saved: true, path: '/chosen/scan.tiff' };
    } finally {
      active = false;
    }
  }, { onProgress: (written, total) => progress.push([written, total]) });
  assert.equal(result.saved, true);
  // Chunks arrive in order and make up the Blob.
  assert.deepEqual(new Uint8Array(await new Blob(chunks).arrayBuffer()), bytes);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((c) => c.length), [EXPORT_CHUNK_BYTES, EXPORT_CHUNK_BYTES, 17]);
  // The next slice is read while the previous append is pending, and only
  // one slice ahead: it starts after the previous slice was read.
  for (const offset of [EXPORT_CHUNK_BYTES, EXPORT_CHUNK_BYTES * 2]) {
    const read = events.indexOf(`read ${offset}`);
    const previousAppend = events.indexOf(`append ${offset - EXPORT_CHUNK_BYTES} start`);
    const previousAppendEnd = events.indexOf('append end', previousAppend);
    assert.ok(read > events.indexOf(`read ${offset - EXPORT_CHUNK_BYTES}`), `one read at a time: ${events.join(', ')}`);
    assert.ok(read < previousAppendEnd, `read ahead at ${offset}: ${events.join(', ')}`);
    if (offset > EXPORT_CHUNK_BYTES) assert.ok(read > events.indexOf('append end', events.indexOf(`append ${offset - 2 * EXPORT_CHUNK_BYTES} start`)));
  }
  // Progress rises monotonically to blob.size.
  assert.deepEqual(progress.map(([, total]) => total), Array(progress.length).fill(bytes.length));
  assert.deepEqual(progress.map(([written]) => written), [0, EXPORT_CHUNK_BYTES, EXPORT_CHUNK_BYTES * 2, bytes.length]);
}

for (const failAt of ['append_export_chunk', 'finish_export_write']) {
  const calls = [];
  await assert.rejects(writeDesktopBlob(new Blob(['abc']), { directory: '/chosen', suggestedName: 'x' }, async command => {
    calls.push(command);
    if (command === failAt) throw new Error('intentional failure');
    return 'id';
  }), /intentional failure/);
  assert.equal(calls.at(-1), 'abort_export_write');
}

// Cancel while saving: the in-flight append finishes, no further chunk is
// sent, the stream is aborted (the staging file goes, the target stays) and
// finish is never called.
{
  const bytes = new Uint8Array(EXPORT_CHUNK_BYTES * 3);
  const controller = new AbortController();
  const calls = [];
  await assert.rejects(writeDesktopBlob(new Blob([bytes]), { path: '/chosen/a.png' }, async (command) => {
    calls.push(command);
    if (command === 'append_export_chunk') controller.abort();
    return 'id';
  }, { signal: controller.signal }), (err) => err.name === 'AbortError');
  assert.deepEqual(calls, ['begin_export_write', 'append_export_chunk', 'abort_export_write']);
  // Already cancelled: nothing starts.
  const none = [];
  await assert.rejects(writeDesktopBlob(new Blob([bytes]), { path: '/chosen/a.png' }, async (command) => { none.push(command); return 'id'; }, { signal: controller.signal }), (err) => err.name === 'AbortError');
  assert.deepEqual(none, []);
}

// A short slice read is an error, not a silent truncation.
{
  const blob = new Blob([new Uint8Array(100)]);
  blob.slice = () => ({ arrayBuffer: async () => new ArrayBuffer(10) });
  const calls = [];
  await assert.rejects(writeDesktopBlob(blob, { path: '/chosen/b.png' }, async (command) => { calls.push(command); return 'id'; }), /Incomplete export chunk/);
  assert.deepEqual(calls, ['begin_export_write', 'abort_export_write']);
}

const emptyCalls = [];
const emptyProgress = [];
await writeDesktopBlob(new Blob([]), { path: '/chosen/empty' }, async command => { emptyCalls.push(command); return 'id'; }, { onProgress: (w, t) => emptyProgress.push([w, t]) });
assert.deepEqual(emptyCalls, ['begin_export_write', 'finish_export_write']);
assert.deepEqual(emptyProgress, [[0, 0]]);
console.log('desktopExportWriter tests passed');
