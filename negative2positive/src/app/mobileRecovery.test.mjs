import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { createMobileRecovery, RECOVERY_CHUNK_BYTES, RECOVERY_FILE_LIMIT, RECOVERY_SOURCE_LIMIT } from './mobileRecovery.js';
import { buildRollProject, serializeRollProject, parseRollProject } from './rollProject.js';

function bridge() {
  const disk = new Map(), partial = new Map(), calls = [], statuses = [];
  let serial = 0, revision = 0, session = '', checkpoint = null, failure = null;
  let pause = null;
  const invoke = async (command, args = {}, options) => {
    calls.push({ command, args, options });
    if (pause?.command === command) { const p = pause; pause = null; p.started(); await p.wait; }
    if (failure === command) { failure = null; throw new Error('disk full'); }
    if (command === 'mobile_recovery_open') {
      session = `page-${++serial}`; partial.clear();
      return structuredClone({ session, revision, checkpoint, sources: checkpoint?.sourceIds.map(id => disk.get(id).info) || [] });
    }
    const lease = command === 'mobile_recovery_append' ? options.headers['x-recovery-session'] : args.session;
    assert.equal(lease, session, 'every operation uses the active native lease');
    switch (command) {
      case 'mobile_recovery_begin': { const id = `source-${++serial}`; partial.set(id, { info: args.info, chunks: [], size: 0 }); return id; }
      case 'mobile_recovery_append': {
        assert.ok(args instanceof Uint8Array, 'no base64 or whole-file JSON transfer');
        assert.ok(args.length <= RECOVERY_CHUNK_BYTES);
        const p = partial.get(options.headers['x-source-id']);
        assert.equal(Number(options.headers['x-source-offset']), p.size);
        p.size += args.length; p.chunks.push(args.slice()); return;
      }
      case 'mobile_recovery_finish': {
        const p = partial.get(args.id); assert.equal(p.size, p.info.size);
        disk.set(args.id, { info: p.info, file: new File(p.chunks, p.info.name, { type: p.info.mimeType, lastModified: p.info.lastModified }) });
        partial.delete(args.id); return;
      }
      case 'mobile_recovery_abort': partial.delete(args.id); return;
      case 'mobile_recovery_commit': {
        assert.equal(args.expectedRevision, revision);
        for (const id of args.sourceIds) assert.ok(disk.has(id));
        checkpoint = { ...args, revision: ++revision, savedAt: Date.now() };
        delete checkpoint.session; delete checkpoint.expectedRevision;
        return structuredClone(checkpoint);
      }
      case 'mobile_recovery_clear': {
        assert.equal(args.expectedRevision, revision);
        disk.clear(); partial.clear();
        checkpoint = { revision: revision += 2, savedAt: Date.now(), project: serializeRollProject(buildRollProject()), sourceIds: [], queueIds: [], activeIndex: 0 };
        return structuredClone(checkpoint);
      }
      case 'mobile_recovery_read': return disk.get(args.id).file.slice(args.offset, args.offset + args.length).arrayBuffer();
      case 'mobile_recovery_verify': assert.ok(disk.has(args.id)); return;
      default: throw new Error(command);
    }
  };
  return {
    invoke, calls, disk, partial, statuses,
    controller(options = {}) { return createMobileRecovery({ invoke, FileCtor: File, onStatus: (...args) => statuses.push(args), uuid: () => `queue-${++serial}`, ...options }); },
    fail(command) { failure = command; },
    pause(command) {
      let release, started;
      const wait = new Promise(resolve => { release = resolve; });
      const ready = new Promise(resolve => { started = resolve; });
      pause = { command, wait, started }; return { release, ready };
    },
    get checkpoint() { return checkpoint; }
  };
}
const source = (text = 'original', name = 'same.png') => new File([text], name, { type: 'image/png', lastModified: 12 });
function saveInput(controller, files, exposure = 1) {
  return {
    project: serializeRollProject(buildRollProject({ files: files.map(file => ({ name: file.name, size: file.size, settings: { exposure } })) })),
    items: files.map(file => ({ file, id: controller.itemId(file) })), activeIndex: files.length - 1
  };
}

// Persist, throw the whole JS controller away (an app/WebContent restart),
// restore exact bytes, same-name identities, selected frame and edits.
{
  const b = bridge(), first = b.controller();
  const files = [source('first'), source('other')];
  const input = saveInput(first, files, 7);
  assert.notEqual(input.items[0].id, input.items[1].id);
  await first.save(input);
  assert.equal(first.status, 'saved');
  const restarted = b.controller(), record = await restarted.open();
  const restored = await restarted.restore(record);
  assert.equal(restored.activeIndex, 1);
  assert.deepEqual(await Promise.all(restored.files.map(file => file.text())), ['first', 'other']);
  assert.deepEqual(restored.files.map(file => restarted.itemId(file)), input.items.map(item => item.id));
  assert.equal(parseRollProject(restored.project).files[0].settings.exposure, 7);
  const begins = b.calls.filter(call => call.command === 'mobile_recovery_begin').length;
  await restarted.save(saveInput(restarted, restored.files, 8));
  assert.equal(b.calls.filter(call => call.command === 'mobile_recovery_begin').length, begins, 'restored sources are reused');
}

// A large original crosses the bridge in bounded, ordered raw chunks.
{
  const b = bridge(), c = b.controller();
  const bytes = new Uint8Array(RECOVERY_CHUNK_BYTES * 2 + 17).fill(93);
  await c.save(saveInput(c, [source(bytes)]));
  assert.deepEqual(b.calls.filter(c => c.command === 'mobile_recovery_append').map(c => c.args.length), [RECOVERY_CHUNK_BYTES, RECOVERY_CHUNK_BYTES, 17]);
}

// A newer edit arriving while originals are copied wins; older work cannot
// overwrite it later, and only the complete snapshot is acknowledged saved.
{
  const b = bridge(), c = b.controller(), file = source();
  const p = b.pause('mobile_recovery_append');
  const old = c.save(saveInput(c, [file], 1)); await p.ready;
  const newer = c.save(saveInput(c, [file], 2)); p.release();
  assert.equal(await old, false); assert.equal(await newer, true);
  assert.equal(parseRollProject(b.checkpoint.project).files[0].settings.exposure, 2);
  assert.equal(b.calls.filter(c => c.command === 'mobile_recovery_commit').length, 1);
}

// Clear while a copy is in flight aborts it and cannot resurrect the roll.
{
  const b = bridge(), c = b.controller(), file = source();
  const p = b.pause('mobile_recovery_commit');
  const saved = c.save(saveInput(c, [file], 1)); await p.ready;
  // A drag may still be in its debounce period. The previous write's ack
  // must not mark that newer, unsubmitted edit as saved.
  c.dirty(); p.release(); await saved;
  assert.equal(c.status, 'saving');
  await c.save(saveInput(c, [file], 2)); assert.equal(c.status, 'saved');
}

// Clear while a copy is in flight aborts it and cannot resurrect the roll.
{
  const b = bridge(), c = b.controller();
  const p = b.pause('mobile_recovery_append');
  const saved = c.save(saveInput(c, [source(new Uint8Array(RECOVERY_CHUNK_BYTES + 1))])); await p.ready;
  const cleared = c.clear(); p.release();
  assert.equal(await saved, false); await cleared;
  assert.equal(b.disk.size, 0); assert.equal(b.partial.size, 0);
  assert.equal(b.checkpoint.sourceIds.length, 0); assert.equal(c.status, 'idle');
}

// Disk/IPC failure does not acknowledge a save or replace the last good
// record; retry first reacquires the durable revision and recopies safely.
for (const failed of ['mobile_recovery_append', 'mobile_recovery_commit']) {
  const b = bridge(), c = b.controller();
  await c.save(saveInput(c, [source('old')]));
  const previous = b.checkpoint.project;
  b.fail(failed);
  const input = saveInput(c, [source('new')], 2);
  await assert.rejects(c.save(input), /disk full/);
  assert.equal(c.status, 'error'); assert.equal(b.checkpoint.project, previous);
  assert.equal(b.partial.size, 0);
  await c.save(input); assert.equal(c.status, 'saved');
}

// Memory refusal precedes even the first source read and preserves storage.
{
  const b = bridge(), c = b.controller(); await c.save(saveInput(c, [source('too much')]));
  const limited = b.controller({ maxRestoreBytes: 3 }), record = await limited.open();
  await assert.rejects(limited.restore(record), error => error.code === 'restore-too-large');
  assert.equal(b.calls.filter(c => c.command === 'mobile_recovery_read').length, 0);
  assert.equal(b.disk.size, 1);
}

const rust = readFileSync(new URL('../../../src-tauri/src/mobile_recovery.rs', import.meta.url), 'utf8');
// Refuse an impossible checkpoint before the first source is copied.
for (const files of [Array.from({ length: RECOVERY_FILE_LIMIT + 1 }, () => source()),
  [{ name: 'huge.dng', size: RECOVERY_SOURCE_LIMIT + 1, type: '', lastModified: 0 }]]) {
  const b = bridge(), c = b.controller();
  await assert.rejects(c.save(saveInput(c, files)), error => error.code === 'recovery-limits');
  assert.equal(b.calls.length, 0);
}
assert.match(rust, /pub const CHUNK_LIMIT: usize = 1024 \* 1024;/);
assert.equal(RECOVERY_CHUNK_BYTES, 1024 * 1024);
console.log('Mobile recovery: restart, binary copies, ordering, clear, failure and memory admission passed');
