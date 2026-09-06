import assert from 'node:assert/strict';
import { writeDesktopBlob, EXPORT_CHUNK_BYTES } from './desktopExportWriter.js';

const bytes = new Uint8Array(EXPORT_CHUNK_BYTES * 2 + 17);
for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
const blob = new Blob([bytes]);
blob.arrayBuffer = () => { throw new Error('Blob全体の読込は禁止'); };
const chunks = [];
let active = false;
const result = await writeDesktopBlob(blob, { path: '/chosen/scan.tiff' }, async (command, args, options) => {
  assert.equal(active, false, 'チャンクは同時送信しない');
  active = true;
  await Promise.resolve();
  active = false;
  if (command === 'begin_export_write') {
    assert.equal(args.expectedBytes, bytes.length);
    return 'session';
  }
  if (command === 'append_export_chunk') {
    assert.ok(args instanceof Uint8Array && args.length <= EXPORT_CHUNK_BYTES);
    assert.equal(options.headers['x-export-id'], 'session');
    chunks.push(args);
    return;
  }
  assert.equal(command, 'finish_export_write');
  return { saved: true, path: '/chosen/scan.tiff' };
});
assert.equal(result.saved, true);
assert.deepEqual(new Uint8Array(await new Blob(chunks).arrayBuffer()), bytes);
assert.equal(chunks.length, 3);
for (const failAt of ['append_export_chunk', 'finish_export_write']) {
  const calls = [];
  await assert.rejects(writeDesktopBlob(new Blob(['abc']), { directory: '/chosen', suggestedName: 'x' }, async command => {
    calls.push(command);
    if (command === failAt) throw new Error('intentional failure');
    return 'id';
  }), /intentional failure/);
  assert.equal(calls.at(-1), 'abort_export_write');
}
const emptyCalls = [];
await writeDesktopBlob(new Blob([]), { path: '/chosen/empty' }, async command => { emptyCalls.push(command); return 'id'; });
assert.deepEqual(emptyCalls, ['begin_export_write', 'finish_export_write']);
console.log('desktopExportWriter tests passed');
