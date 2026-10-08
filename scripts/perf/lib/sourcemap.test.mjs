import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createSourceMapper, charPositionToLineColumn, normalizeSourcePath } from './sourcemap.mjs';
import { createTraceAnalyzer, createTraceFileWriter } from './trace.mjs';

// Minimal VLQ encoder for a hand-written source map.
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function vlq(value) {
  let v = value < 0 ? ((-value) << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v) digit |= 32;
    out += BASE64[digit];
  } while (v);
  return out;
}
const segment = values => values.map(vlq).join('');

const dist = mkdtempSync(join(tmpdir(), 'nc-perf-map-'));
try {
  mkdirSync(join(dist, 'assets'));
  // Line 0: "function a(){x()}" from src/app/main.js:10 (name "createStudioThumbnail")
  // Line 1: "function b(){y()}" from src/app/imageDataOps.js:62
  writeFileSync(join(dist, 'assets', 'main-abc.js'), 'function a(){x()}\nfunction b(){y()}\n');
  writeFileSync(join(dist, 'assets', 'main-abc.js.map'), JSON.stringify({
    version: 3,
    sources: ['../../src/app/main.js', '../../src/app/imageDataOps.js'],
    names: ['createStudioThumbnail'],
    mappings: `${segment([0, 0, 9, 4, 0])};${segment([0, 1, 52, -4])}`
  }));
  const mapper = createSourceMapper({ distDir: dist, origin: 'http://127.0.0.1:5297' });
  const url = 'http://127.0.0.1:5297/assets/main-abc.js';
  assert.deepEqual(mapper.map(url, 0, 3), { source: 'src/app/main.js', line: 10, column: 4, name: 'createStudioThumbnail' });
  assert.equal(mapper.label(url, 1, 2), 'src/app/imageDataOps.js:62');
  assert.equal(mapper.label('http://elsewhere/x.js', 4, 0), 'x.js:5', 'other origins stay unmapped');
  assert.equal(mapper.map('http://127.0.0.1:5297/../../etc/passwd', 0, 0), null, 'paths cannot escape the dist dir');
  // LoAF gives a character position: line 1 starts at offset 18.
  assert.equal(mapper.mapCharPosition(url, 20).source, 'src/app/imageDataOps.js');
  assert.deepEqual(charPositionToLineColumn('ab\ncd\nef', 4), { line: 1, column: 1 });
  assert.equal(normalizeSourcePath('../../node_modules/libraw-wasm/dist/index.js'), 'node_modules/libraw-wasm/dist/index.js');
  assert.equal(normalizeSourcePath('webpack://app/./src/app/x.js'), 'src/app/x.js');

  // Trace analysis: busy = union of top-level slices, hot functions mapped.
  const analyzer = createTraceAnalyzer({ mapper });
  analyzer.add([
    { ph: 'M', name: 'thread_name', pid: 1, tid: 10, args: { name: 'CrRendererMain' } },
    { ph: 'M', name: 'thread_name', pid: 1, tid: 20, args: { name: 'DedicatedWorker thread' } },
    { ph: 'X', name: 'RunTask', pid: 1, tid: 10, ts: 1000, dur: 5000 },
    { ph: 'X', name: 'RunTask', pid: 1, tid: 10, ts: 3000, dur: 4000 },
    { ph: 'X', name: 'ThreadControllerImpl::RunTask', pid: 1, tid: 20, ts: 0, dur: 2000 },
    { ph: 'P', name: 'Profile', pid: 1, tid: 10, id: '0x1', ts: 1000, args: { data: { startTime: 1000 } } }
  ]);
  analyzer.add([
    { ph: 'P', name: 'ProfileChunk', pid: 1, tid: 10, id: '0x1', ts: 1100, args: { data: {
      cpuProfile: {
        nodes: [
          { id: 1, callFrame: { functionName: '(root)', url: '' } },
          { id: 2, callFrame: { functionName: 'a', url, lineNumber: 0, columnNumber: 3 }, parent: 1 },
          { id: 3, callFrame: { functionName: '(idle)', url: '' }, parent: 1 },
          { id: 4, callFrame: { functionName: 'texImage2D', url: '' }, parent: 2 }
        ],
        samples: [2, 2, 2, 4, 3]
      },
      timeDeltas: [0, 1000, 1000, 1000, 1000]
    } } }
  ]);
  const report = analyzer.finalize();
  const main = report.threads.find(entry => entry.name === 'CrRendererMain');
  assert.equal(main.busyMs, 6, 'overlapping top-level slices count once');
  assert.deepEqual(main.hot[0], { label: 'createStudioThumbnail src/app/main.js:10', selfMs: 3 });
  assert.deepEqual(main.hot[1], { label: 'texImage2D (native)', selfMs: 1 });
  assert.equal(main.hot.length, 2, '(idle) and (root) are not hot functions');
  assert.equal(report.wallMs, 7);
  assert.equal(report.coresUsed, round2((6 + 2) / 7));

  // Gzipped trace output is valid Chrome trace JSON.
  const path = join(dist, 'trace.json.gz');
  const writer = createTraceFileWriter(path);
  writer.write([{ ph: 'X', name: 'RunTask', ts: 1, dur: 2 }]);
  writer.write([{ ph: 'X', name: 'RunTask', ts: 3, dur: 4 }]);
  await writer.close();
  assert.equal(JSON.parse(gunzipSync(readFileSync(path)).toString()).traceEvents.length, 2);
} finally {
  rmSync(dist, { recursive: true, force: true });
}

function round2(value) { return Math.round(value * 100) / 100; }

console.log('sourcemap and trace: mapping, LoAF positions, busy time, hot functions and trace file tests passed');
