// Runs the Chrome scenarios end to end through the runner against a
// simulated browser session: every step, event query and metric computation
// the scenarios perform executes in Node, so a renamed field or a wrong
// metric key fails here instead of an hour into a real benchmark run. The
// simulation is deliberately simple (one conversion per two slider moves,
// instant roll analysis); the numbers it produces are not measurements.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import * as pako from 'pako';
import { encodePng16Blob, encodeTiffBlob } from '../../../negative2positive/src/workers/imageEncoders.js';
import { ZipStoreWriter } from '../../../negative2positive/src/app/zipStoreWriter.js';

const UPNG = createRequire(import.meta.url)('upng-js');

// Simulated sessions need no real waiting.
process.env.NC_PERF_TIME_SCALE = '0';
const { parseArgs } = await import('../lib/args.mjs');
const { runRepetition } = await import('../lib/runner.mjs');
const { SCENARIOS } = await import('./index.mjs');
const { ScenarioAbort } = await import('../lib/session.mjs');
const { findMetricDef } = await import('../lib/compare.mjs');
const { exportStageMetrics } = await import('./s9-export.mjs');
const { readFileSync } = await import('node:fs');
const budgets = JSON.parse(readFileSync(new URL('../budgets.json', import.meta.url)));

for (const id of ['s9', 's9-parallel', 'dust-brush', 'overlay-idle', 'loupe']) {
  assert.ok(SCENARIOS[id].steps.length, `${id} has reviewable step definitions`);
  for (const step of SCENARIOS[id].steps) assert.ok(step.action || (step.moves > 0 && step.x > 0 && step.x < 1));
}
assert.equal(SCENARIOS['dust-brush'].steps.length, 20);
assert.equal(SCENARIOS.loupe.fakeCamera, true);
assert.equal(SCENARIOS.s2.debugCounters, true);
assert.equal(SCENARIOS.s3.debugCounters, true);
for (const key of ['s9.single.png16.imported.encodeMs', 's9.zip.png16.lanes1.encodeMs', 's9.zip.png16.lanes3.msPerFile',
  's9.zip.dng.linearDngBuildMs', 's9.zip.dng.blobMs', 's9.single.tiff16.imported.desktopWriteMs',
  'dust-brush.releaseToRepairedP95Ms', 'dust-brush.maxLongTaskMs', 'dust-brush.postMessageMaxBytes',
  's2.coreExposure.dpr2.ui.flushes', 's3.curve.dpr2.ui.lastFlushWrites', 'overlay-idle.runningAnimations', 'loupe.mainBusyPct']) {
  assert.ok(findMetricDef(budgets, key), `budget for ${key}`);
}
const stageEvents = [
  { k: 'um', t: 12, n: 'nc:imageDataToBlob', d: 123, detail: { format: 'png', bitDepth: 16 } },
  { k: 'um', t: 13, n: 'nc:imageDataToBlob', d: 999, detail: { format: 'png', bitDepth: 8 } },
  { k: 'um', t: 14, n: 'nc:linearDngBatch', d: 450, detail: { stages: [{ stage: 'build', ms: 430 }], blobMs: 20 } },
  { k: 'um', t: 15, n: 'nc:batchExport', detail: { lanes: 3 } },
  { k: 'invoke.end', t: 20, rt: 19, cmd: 'finish_export_write', writeStart: 10, error: false },
  { k: 'invoke.end', t: 21, rt: 20, cmd: 'finish_export_write', writeStart: null, error: false },
  { k: 'invoke.end', t: 22, rt: 20, cmd: 'finish_export_write', writeStart: 2, error: true }
];
assert.deepEqual(exportStageMetrics(stageEvents, { start: 10, end: 22, spec: { format: 'png', bitDepth: 16 } }),
  { encodeMs: 123, linearDngBuildMs: 430, linearDngTotalMs: 450, blobMs: 20, lanes: 3, desktopWriteMs: 10 });

class FakeSession {
  constructor(options) {
    this.options = options;
    this.events = [];
    this.pending = [];
    this.t = 1000;
    this.status = 'ok';
    this.dpr = options.dpr || 2;
    this.files = [];
    this.focused = null;
    this.current = null;
    this.lastId = null;
    this.hash = 0;
    this.geometry = { rotationAngle: 0, mirrored: false, cropRegion: null };
    this.zoom = 1;
    this.selfMs = 0.5;
    this.counters = { 'worker.new': 3 };
    this.workerTiming = [];
    this.pageTimeOrigin = 1_700_000_000_000;
    this.sampler = { samples: [{ rendererBytes: 1.5 * 1024 ** 3, gpuBytes: 0.2 * 1024 ** 3, totalBytes: 2 * 1024 ** 3 }] };
    this.page = { send: async (method, params = {}) => this.pageCommand(method, params) };
    this.chrome = { version: { Browser: 'Chrome/153.0.0.0' } };
    this.exportsList = [];
    this.format = 'png';
    this.bitDepth = 8;
    this.uploadSeq = 0;
    this.batchLanes = 1;
    this.uiCounterRead = 0;
    // Tracing for the continuous ring buffer (H, the hang self-test).
    const listeners = new Map();
    this.connection = {
      on: (method, handler) => { listeners.set(method, handler); return () => listeners.delete(method); },
      waitFor: method => new Promise(resolve => listeners.set(method, resolve)),
      send: async method => {
        if (method === 'Tracing.end') setTimeout(() => { listeners.get('Tracing.dataCollected')?.({ value: [] }); listeners.get('Tracing.tracingComplete')?.({}); }, 0);
        return {};
      }
    };
  }
  async pageCommand(method, params) {
    if (method === 'Runtime.evaluate' && /ncInjectedHang/.test(params.expression || '')) {
      setTimeout(() => {
        this.status = 'hang';
        this.abortReason = 'page silent for 30 s';
        const sample = join(this.options.outDir, `hang-${this.options.label}-sample-1.txt`);
        writeFileSync(sample, 'Call graph: ncInjectedHang');
        const gpuSample = join(this.options.outDir, `hang-${this.options.label}-sample-2.txt`);
        writeFileSync(gpuSample, 'GPU sample');
        this.hangDump = {
          info: { silentMs: 30_500 }, file: join(this.options.outDir, `hang-${this.options.label}.json`), trace: 'trace.json.gz',
          stacks: [{ kind: 'page', frames: [{ function: 'ncInjectedHang' }] }, { kind: 'worker', url: 'conversionWorker.js', frames: [{ function: 'onmessage' }] }],
          ring: { ring: [{ k: 'input', t: 1 }] }, samples: [{ pid: 1, file: sample }, { pid: 2, file: gpuSample }], processes: [{ type: 'renderer', id: 1, cpuTime: 31 }, { type: 'GPU', id: 2 }]
        };
      }, 5);
    }
    return {};
  }
  static async open(options) { return new FakeSession(options); }
  emit(event) { this.pending.push(event); }
  step(ms) { this.t += ms; return this.t; }
  check() { if (this.status !== 'ok') throw new ScenarioAbort(this.status, 'fake'); }
  async close() {}
  async boot() { this.step(600); return 540; }
  async drain() {
    const n = this.pending.length;
    this.events.push(...this.pending);
    this.pending = [];
    this.events.sort((a, b) => a.t - b.t);
    return n;
  }
  convert(value, { cache = true, delay = 20, ft = 'color', paint = true } = {}) {
    const id = ++this.hash;
    const rt = this.step(1);
    this.emit({ k: 'req', t: rt, wid: 7, cls: 'convert', id, cache, ft, geometry: structuredClone(this.geometry) });
    const hash = `h${id}-${value}`;
    this.emit({ k: 'res', t: this.step(delay), wid: 7, cls: 'convert', id, rt, hash, cache, w: 1809, h: 1202 });
    if (!paint) return;
    this.emit({ k: 'gl.upload', t: this.step(1), c: 'glCanvas', w: 1809, h: 1202, hash });
    this.emit({ k: 'gl.draw', t: this.step(2), c: 'glCanvas', sig: `sig-${hash}` });
  }
  snapshot() {
    return {
      t: this.t, dpr: this.dpr, ready: true, busy: false, filename: this.current ? basename(this.current) : '', filmType: 'color', filmTypeStatus: 'Colour negative',
      glCanvas: { width: 1809, height: 1202, display: 'block', rect: { width: 904 * this.zoom, height: 601 * this.zoom } },
      transform: `matrix(${this.zoom}, 0, 0, ${this.zoom}, 0, 0)`, files: this.files.length, badges: this.files.length, thumbnails: this.files.length,
      detail: this.zoom > 5 ? { visible: true, sourcePxPerDevicePx: 1, current: true } : { visible: false, sourcePxPerDevicePx: 0.26 },
      transferBytes: 1024 * 900, decodedBytes: 1024 * 4000, memory: null
    };
  }
  async evaluate(expression) {
    this.check();
    this.step(1);
    if (expression.includes('__ncDebug.counters()')) {
      const n = ++this.uiCounterRead;
      return { sync: { flushes: n * 10, writes: n * 20, lastFlushWrites: 2 }, fileListRenders: n,
        loupe: { conversions: n * 30, grabs: n * 31, defaults: n, repeated: n * 2 } };
    }
    if (expression.includes('document.getAnimations()')) return [];
    if (expression.includes("? '#canvas' : '#glCanvas'")) return '#glCanvas';
    const lanes = /localStorage.setItem\('nc_batch_lanes_v1', "(\d+)"/.exec(expression);
    if (lanes) { this.batchLanes = Number(lanes[1]); return true; }
    if (expression === 'performance.now()') return this.t;
    if (expression.includes('? performance.now() : null')) return this.t;
    if (expression.includes('__ncPerf.snapshot()')) return this.snapshot();
    if (expression.includes('__ncPerfControl.stages')) return [{ key: 'librawDecodeMs', ms: 5000 }, { key: 'autoFrameMs', ms: 2700 }];
    const selectPhoto = /file-list-name\[data-index="(\d+)"\]'\)\?\.click/.exec(expression);
    if (selectPhoto) {
      this.current = this.files[Number(selectPhoto[1])];
      this.convert('route-photo');
      this.emit({ k: 'mut', t: this.t, what: 'filename', v: basename(this.current) });
      return true;
    }
    if (expression.includes('return { value: e.value')) return { value: '0', min: -100, max: 100 };
    if (expression.includes('sliderPressPoint: true')) return { sliderPressPoint: true, x: 208, y: 210, width: 216, value: '0', min: -100, max: 100, fraction: 0.5, hit: null };
    if (expression.includes(".file-list-name')].map")) return this.files.map((_, i) => i);
    const focus = /data-index="(\d+)"\]'\);\s*if \(!button\) return false;/.exec(expression);
    if (focus) { this.focused = Number(focus[1]); return true; }
    if (expression.includes("document.querySelectorAll('.file-list-settings-badge').length <")) return false;
    if (expression.includes('aria-current')) return '0';
    if (expression.includes('__ncPerf.selfMs()')) return this.selfMs;
    // S4's reset: the 1:1 toggle returns a zoomed view to fit (#248).
    if (expression.includes('zoom-pan-active')) { this.zoom = 1; return true; }
    const format = /\.format-btn\[data-format="(\w+)"\]'\)\.click\(\)/.exec(expression);
    if (format) { this.format = format[1]; return true; }
    const depth = /\.bitdepth-btn\[data-bitdepth="(\d+)"\]'\)\.click\(\)/.exec(expression);
    if (depth) { this.bitDepth = Number(depth[1]); return true; }
    if (expression.includes('__ncPerf.exports.list()')) return this.exportsList.map((entry, index) => ({ index, t: entry.t, end: entry.t, name: entry.name, size: 1000, kind: entry.kind, done: true }));
    if (expression.includes('__ncPerf.exports.clear()')) { this.exportsList = []; return true; }
    const upload = /exports\.upload\((\d+), '\/__perf\/export\?name=' \+ encodeURIComponent\("([^"]+)"\)\)/.exec(expression);
    if (upload) return this.writeExport(this.exportsList[Number(upload[1])], upload[2]);
    if (/exports.jpeg(Bytes)?Sha256/.test(expression)) return { width: 10, height: 10, sha256: 'jpeg-pixels' };
    return true;
  }
  async writeExport(entry, name) {
    const safe = basename(name).replace(/[^\w.-]+/g, '_');
    // The preview plugin writes uploads into the ref's export dir.
    const file = join(FakeSession.exportDir, `${++this.uploadSeq}-${safe}`);
    const rgba16 = new Uint16Array(4 * 4 * 4).fill(4097);
    const tiff = async () => new Uint8Array(await encodeTiffBlob(rgba16, 4, 4, entry.bitDepth).arrayBuffer());
    const png = async () => entry.bitDepth === 16
      ? new Uint8Array(await encodePng16Blob(rgba16, 4, 4, pako).arrayBuffer())
      : new Uint8Array(UPNG.encode([new Uint8Array(32 * 32 * 4).map((_, i) => (i * 37) & 255).buffer], 32, 32, 0));
    const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]);
    let bytes;
    // More than 256 colours, so UPNG keeps 8-bit truecolour like the app's PNG8.
    if (/\.png$/.test(name)) bytes = await png();
    else if (/\.(tiff?|dng)$/.test(name)) bytes = await tiff();
    else if (/\.jpe?g$/.test(name)) bytes = jpeg;
    else {
      const chunks = [];
      const writer = new ZipStoreWriter({ write: async chunk => { chunks.push(new Uint8Array(chunk)); } });
      const ext = entry.format === 'png' ? 'png' : entry.format === 'jpeg' ? 'jpg' : entry.format === 'dng' ? 'dng' : 'tif';
      for (let i = 0; i < 3; i++) await writer.addBlob(`f${i}.${ext}`, new Blob([entry.format === 'png' ? await png() : entry.format === 'jpeg' ? jpeg : await tiff()]));
      await writer.close();
      bytes = new Uint8Array(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))));
    }
    writeFileSync(file, bytes);
    return { ok: true, size: bytes.length };
  }
  async beginWindow(label) { this.windowLabel = label; this.windowStart = this.t; return this.t; }
  async endWindow() {
    this.step(100); // the scenario waited before closing the window
    const frames = [];
    for (let f = this.windowStart; f <= this.t; f += 1000 / 60) frames.push(f);
    const ticks = [];
    for (let f = this.windowStart; f <= this.t; f += 5) ticks.push(f);
    await this.drain();
    return { label: this.windowLabel, start: this.windowStart, end: this.t, frames, ticks, mainBusyPct: 22.5, scriptMs: 120, taskMs: 300, probeSelfMs: 1.2, probeSelfPct: 0.4 };
  }
  async setFiles(paths) {
    this.files = paths;
    this.current = paths[0];
    const changeT = this.step(5);
    this.emit({ k: 'input', type: 'change', id: 'fileInput', t: changeT, tr: true, files: paths.length });
    this.emit({ k: 'vis', t: this.step(5), ov: true, ready: false, busy: true });
    if (/\.dng$/i.test(paths[0])) {
      const openT = this.step(180);
      this.emit({ k: 'req', t: openT, wid: 3, cls: 'libraw', fn: 'open', id: 0 });
      this.emit({ k: 'res', t: this.step(100), wid: 3, cls: 'libraw', fn: 'open', id: 0, rt: openT });
      const decodeT = this.step(1);
      this.emit({ k: 'req', t: decodeT, wid: 3, cls: 'libraw', fn: 'imageData', id: 1 });
      this.emit({ k: 'res', t: this.step(5000), wid: 3, cls: 'libraw', fn: 'imageData', id: 1, rt: decodeT, w: 9536, h: 6336 });
    }
    this.emit({ k: 'c2d', t: this.step(300), c: 'canvas', fn: 'putImageData', w: 9536, h: 6336, hash: 'negative' });
    const frameT = this.step(1);
    this.emit({ k: 'req', t: frameT, wid: 4, cls: 'analyze-frame', id: 1 });
    this.emit({ k: 'res', t: this.step(2700), wid: 4, cls: 'analyze-frame', id: 1, rt: frameT, crop: { w: 9000, h: 6000 } });
    this.convert('import', { delay: 78 });
    this.emit({ k: 'vis', t: this.step(10), ov: false, ready: true, busy: false });
    this.emit({ k: 'mut', t: this.t, what: 'filename', v: basename(paths[0]) });
    this.emit({ k: 'um', t: changeT, n: 'nc:prepareStudioPhoto', s: changeT, d: this.t - changeT, detail: { stages: [] } });
    this.emit({ k: 'lt', t: changeT + 300, s: changeT + 300, d: 120 });
    this.step(3000);
  }
  async waitFor() { this.check(); this.step(100); return 100; }
  async waitForReady() { this.step(50); return 50; }
  async setDpr(dpr) { this.dpr = dpr; }
  async reveal(id) {
    this.lastId = id;
    // The curve canvas is tall enough for a distinct position on every move.
    return id === 'curveCanvas' ? { x: 100, y: 100, width: 1800, height: 1800, visible: true } : { x: 100, y: 200, width: 216, height: 20, visible: true };
  }
  async rect(selector) { this.lastId = selector.replace(/^#/, '').split(' ')[0]; return { x: 100, y: 200, width: 900, height: 600 }; }
  async installDialogAutoAccept() {}
  async cpuTimes() { return this.t / 1000 * 1.5; }
  async heapAfterGcMB() { return 4.2; }
  memoryMark() { return 0; }
  memorySummary() { return { samples: 4, rendererPeakMB: 2800, rendererLifetimePeakMB: 2900, rendererAfterMB: 1600, gpuPeakMB: 400, gpuLifetimePeakMB: 450, gpuAfterMB: 300, browserTotalPeakMB: 3500 }; }
  async click(x, y) {
    const id = this.lastId;
    const t = this.step(10);
    this.emit({ k: 'input', type: 'click', id, t, tr: true });
    if (id === 'zoomInBtn') { this.zoom *= 1.25; this.emit({ k: 'mut', t: this.step(12), what: 'transform', v: `matrix(${this.zoom}, 0, 0, ${this.zoom}, 0, 0)` }); }
    if (id === 'zoomResetBtn') {
      // "1:1" (#248): fit -> true 100 %, then the detail layer's region lands.
      this.zoom = this.zoom > 1 ? 1 : 5.3;
      this.emit({ k: 'mut', t: this.step(12), what: 'transform', v: `matrix(${this.zoom}, 0, 0, ${this.zoom}, 0, 0)` });
      if (this.zoom > 1) this.emit({ k: 'gl.upload', t: t + 190, c: 'glDetailCanvas', w: 2476, h: 1656, hash: `detail${t}` });
      // #270: the app's trace of that region (?perf=1).
      if (this.zoom > 1) this.emit({ k: 'um', t: t + 20, n: 'nc:detailRegion', s: t + 20, d: 172, detail: { bands: 4,
        stages: [{ stage: 'converted', ms: 150, totalMs: 150 }, { stage: 'shown', ms: 22, totalMs: 172 }],
        worker: [{ input: 12, convert: 96 }, { input: 11, convert: 101 }, { input: 9, convert: 99 }, { input: 10, convert: 98 }] } });
    }
    if (id === 'cropBtn') this.emit({ k: 'c2d', t: this.step(30), c: 'canvas', fn: 'putImageData', w: 953, h: 633, hash: `crop${t}` });
    if (id === 'applyCropBtn' || id === 'rotateRightBtn' || id === 'mirrorBtn') {
      if (id === 'rotateRightBtn') this.geometry.rotationAngle += 90;
      if (id === 'mirrorBtn') this.geometry.mirrored = !this.geometry.mirrored;
      if (id === 'applyCropBtn') this.geometry.cropRegion = { left: 10, top: 10, width: 1600, height: 1000 };
      this.emit({ k: 'lt', t: t + 1, s: t + 1, d: 2000 });
      this.step(2000);
      this.convert(id, { delay: 60 });
    }
    if (id === 'studioToggleLightTable') this.emit({ k: 'et', t, n: 'click', s: t, ps: t + 1, pe: t + 3, d: 16 });
    if (id === 'exportSingleBtn' || id === 'exportZipBtn') {
      const ext = this.format === 'jpeg' ? 'jpg' : this.format === 'tiff' ? 'tif' : this.format === 'dng' ? 'dng' : 'png';
      this.emit({ k: 'vis', t: this.step(1), ov: true, busy: true });
      this.step(1500);
      this.emit({ k: 'um', t: this.t, n: 'nc:imageDataToBlob', d: 600, detail: { format: this.format, bitDepth: this.bitDepth } });
      if (id === 'exportZipBtn') this.emit({ k: 'um', t: this.t, n: 'nc:batchExport', d: 1500, detail: { lanes: this.batchLanes } });
      if (this.format === 'dng' && id === 'exportZipBtn') this.emit({ k: 'um', t: this.t, n: 'nc:linearDngBatch', d: 370, detail: { stages: [{ stage: 'build', ms: 350 }], blobMs: 20 } });
      this.emit({ k: 'vis', t: this.step(1), ov: false, busy: false });
      this.exportsList.push({ t: this.t, name: id === 'exportZipBtn' ? 'converted_negatives.zip' : `L1000617_positive.${ext}`, kind: id === 'exportZipBtn' ? 'stream' : 'download', bitDepth: this.bitDepth, format: this.format });
    }
  }
  async dblclick() {
    const t = this.step(20);
    this.emit({ k: 'input', type: 'dblclick', id: 'canvas', t, tr: true });
    this.zoom = this.zoom > 1 ? 1 : 2;
    this.emit({ k: 'mut', t: t + 11, what: 'transform', v: `matrix(${this.zoom}, 0, 0, ${this.zoom}, 0, 0)` });
    this.emit({ k: 'lt', t: t + 200, s: t + 200, d: 90 });
    this.emit({ k: 'gl.upload', t: t + 476, c: 'glCanvas', w: 2453, h: 1630, hash: `zoom${t}` });
    this.emit({ k: 'gl.draw', t: t + 480, c: 'glCanvas', sig: `zoom${t}` });
    this.step(500);
  }
  async wheel(x, y, deltaY, { count = 1 } = {}) {
    for (let i = 0; i < count; i++) {
      const t = this.step(1000 / 60);
      this.emit({ k: 'input', type: 'wheel', t, dy: deltaY, tr: true });
      this.emit({ k: 'mut', t: t + 0.4, what: 'transform', v: `w${i}` });
    }
  }
  async drag({ from, to, steps = 180, modifiers = 0 }) {
    const target = this.lastId;
    this.emit({ k: 'input', type: 'mousedown', id: target, t: this.step(5), tr: true, b: 1, x: from.x, y: from.y });
    for (let i = 1; i <= steps; i++) {
      const t = this.step(1000 / 60);
      const x = Math.round(from.x + (to.x - from.x) * i / steps), y = Math.round(from.y + (to.y - from.y) * i / steps);
      this.emit({ k: 'input', type: 'mousemove', id: target, t, tr: true, b: 1, x, y });
      if (['coreExposure', 'coreContrast', 'coreTemperature', 'wbR', 'cyan'].includes(target)) {
        this.emit({ k: 'input', type: 'input', id: target, t: t + 0.3, tr: true, v: String(i) });
        if (target.startsWith('core')) { if (i % 2 === 0) { this.convert(i); this.t = t; } }
        else this.emit({ k: 'gl.draw', t: t + 12, c: 'glCanvas', sig: `u${target}${i}`, ut: t + 1 });
      } else if (target === 'curveCanvas') {
        if (i % 2 === 0) {
          this.emit({ k: 'gl.upload', t: t + 3, c: 'glCanvas', w: 256, h: 1, hash: `lut${i}` });
          this.emit({ k: 'gl.draw', t: t + 13, c: 'glCanvas', sig: `lut${i}` });
        }
      } else if (target === 'canvasContainer') {
        this.emit({ k: 'mut', t: t + 8, what: 'transform', v: `pan${i}` });
      } else if (target === 'cropOverlay') {
        this.emit({ k: 'mut', t: t + 6, what: 'cropOverlay' });
      }
    }
    const up = this.step(20);
    this.emit({ k: 'input', type: 'mouseup', id: target, t: up, tr: true, b: 0 });
    if (target === 'glCanvas' && modifiers === 1) {
      const rt = this.step(1), id = ++this.hash;
      this.emit({ k: 'req', t: rt, cls: 'dust', fn: 'stroke', id, bytes: 700 });
      this.emit({ k: 'res', t: this.step(12), rt, cls: 'dust', fn: 'stroke', id, bytes: 4096 });
      this.emit({ k: 'gl.draw', t: this.step(6), c: 'glCanvas', sig: `dust-${id}`, ut: this.t - 1 });
    }
    if (target === 'cropOverlay' && modifiers) this.emit({ k: 'c2d', t: this.step(35), c: 'canvas', fn: 'putImageData', w: 953, h: 633, hash: `straight${up}` });
  }
  async key(key) {
    const t = this.step(5);
    this.emit({ k: 'input', type: 'keydown', key, t, tr: true });
    if (key === 'ArrowRight') this.focused += 1;
    if (key === 'ArrowLeft') this.focused -= 1;
    if (key === 'Enter') {
      this.current = this.files[this.focused];
      this.emit({ k: 'mut', t: t + 3, what: 'filename', v: basename(this.current) });
      this.emit({ k: 'vis', t: t + 4, ov: false, ready: false, busy: true });
      this.step(60);
      this.convert(`switch${this.focused}`, { delay: 5 });
      this.emit({ k: 'vis', t: this.step(10), ov: false, ready: true, busy: false });
    }
  }
}

const dir = mkdtempSync(join(tmpdir(), 'nc-perf-scenarios-'));
FakeSession.exportDir = dir;
try {
  const single = { name: 'synthetic-60mp-cfa.dng', path: '/fixtures/synthetic-60mp-cfa.dng', width: 9536, height: 6336, synthetic: true };
  const roll = Array.from({ length: 12 }, (_, i) => ({ name: `synthetic-roll-${String(i + 1).padStart(2, '0')}.dng`, path: `/fixtures/synthetic-roll-${String(i + 1).padStart(2, '0')}.dng` }));
  const ref = { label: 'run', dist: dir, origin: 'http://127.0.0.1:1', cdpPort: 1, exportDir: dir };
  const collector = { groups: { roll, export: [single, ...roll.slice(0, 3)], 'export-parallel': roll.slice(0, 4), dust: [single] }, gpu: null };
  const run = (id, argv, overrides = {}) => runRepetition({
    scenario: SCENARIOS[id], fixture: SCENARIOS[id].fixtureGroup === 'roll' || SCENARIOS[id].fixtureGroup.startsWith('export') ? null : single,
    group: SCENARIOS[id].fixtureGroup, ref, rep: 0, args: parseArgs(argv, {}), profiled: false, outDir: dir,
    chromeBin: 'chrome', ceilingBytes: 1e12, swapAtStart: 0, collector, sessionFactory: FakeSession.open, ...overrides
  });
  const expectKeys = (result, keys) => {
    assert.equal(result.status, 'ok', `${result.label}: ${result.detail}`);
    for (const key of keys) assert.ok(key in result.metrics, `${result.label} records ${key} (has ${Object.keys(result.metrics).slice(0, 12).join(', ')}…)`);
  };
  const expectRoutes = (result, count = 1) => {
    const id = result.label.split('-')[1];
    for (let photo = 0; photo < count; photo++) {
      assert.ok(result.metrics[`${id}.photo${photo}.route`], `${id} photo ${photo} route`);
      assert.ok(result.metrics[`${id}.photo${photo}.filmType`], `${id} photo ${photo} film type`);
    }
  };

  const s1 = await run('s1', ['--quick']);
  expectKeys(s1, ['s1.bootMs', 's1.bootTransferKB', 's1.firstPixelsDrawnMs', 's1.firstPhotoVisibleMs', 's1.firstPositiveVisibleMs', 's1.readyMs',
    's1.librawDecodes', 's1.changeToLibrawOpenMs', 's1.longTaskCount', 's1.maxLongTaskMs', 's1.stage.librawDecodeMs', 's1.stage.autoFrameMs',
    's1.stage.previewConvertMs', 's1.photo0.route', 's1.photo0.filmType', 's1.memory.rendererPeakMB', 's1.memory.gpuAfterMB', 's1.memory.jsHeapAfterGcMB',
    's1.control.readyByPollMs', 's1.control.mainBusyPct']);
  assert.equal(s1.metrics['s1.librawDecodes'], 1);
  assert.equal(s1.metrics['s1.changeToLibrawOpenMs'], 185);
  assert.equal(s1.metrics['s1.photo0.route'], 'color');
  assert.ok(s1.metrics['s1.firstPositiveVisibleMs'] > s1.metrics['s1.firstPixelsDrawnMs'], 'the negative is drawn before the positive');
  assert.ok(!('s1.firstProvisionalPixelsMs' in s1.metrics), 'no veil, no provisional pixels (the 1703835 import)');

  // HEAD's RAW import (#235, #251): the photo-switch veil instead of the
  // full-screen overlay, the embedded preview on its bitmap surface, the
  // exact positive drawn under it, and one 'analyze-import' request whose
  // reply times the film-edge read and the frame detection (#273).
  class VeilSession extends FakeSession {
    static async open(options) { return new VeilSession(options); }
    async setFiles(paths) {
      this.files = paths;
      this.current = paths[0];
      const changeT = this.step(5);
      this.emit({ k: 'input', type: 'change', id: 'fileInput', t: changeT, tr: true, files: paths.length });
      this.emit({ k: 'veil', t: this.step(3), shown: true, kind: null, surface: null });
      this.emit({ k: 'vis', t: this.step(1), ov: false, ready: false, busy: true });
      this.emit({ k: 'bmp', t: this.step(80), fn: 'transfer', c: 'studioPhotoSwitchFeedback:bitmap', w: 2112, h: 1408 });
      this.emit({ k: 'veil', t: this.step(1), shown: true, kind: 'embedded', surface: 'bitmap' });
      const decodeT = this.step(100);
      this.emit({ k: 'req', t: decodeT, wid: 3, cls: 'libraw', fn: 'open', id: 0 });
      this.emit({ k: 'res', t: this.step(4000), wid: 3, cls: 'libraw', fn: 'open', id: 0, rt: decodeT });
      const frameT = this.step(1);
      this.emit({ k: 'req', t: frameT, wid: 4, cls: 'analyze-import', id: 1 });
      this.emit({ k: 'res', t: this.step(850), wid: 4, cls: 'analyze-import', id: 1, rt: frameT, frameMs: 690.2, filmEdgeMs: 148.6 });
      this.convert('import', { delay: 60 });
      const drawnT = this.t;
      this.emit({ k: 'bmp', t: this.step(250), fn: 'release', c: 'studioPhotoSwitchFeedback:bitmap', w: 0, h: 0 });
      this.emit({ k: 'veil', t: this.step(1), shown: false, kind: null, surface: null });
      this.emit({ k: 'vis', t: this.step(5), ov: false, ready: true, busy: false });
      this.emit({ k: 'mut', t: this.t, what: 'filename', v: basename(paths[0]) });
      this.veilHiddenAfterDrawMs = this.t - 5 - drawnT;
      this.step(3000);
    }
    async key(key) {
      if (key !== 'Enter') return super.key(key);
      // A cold target: its tile's thumbnail on the veil at once, then the
      // embedded preview, the exact frame under the veil, the veil gone.
      const t = this.step(5);
      this.emit({ k: 'input', type: 'keydown', key, t, tr: true });
      this.current = this.files[this.focused];
      this.emit({ k: 'veil', t: t + 2, shown: true, kind: 'thumbnail', surface: 'thumbnail' });
      this.emit({ k: 'mut', t: t + 3, what: 'filename', v: basename(this.current) });
      this.emit({ k: 'vis', t: t + 4, ov: false, ready: false, busy: true });
      this.emit({ k: 'veil.load', t: t + 20 + this.focused, surface: 'thumbnail', kind: 'thumbnail', shown: true, w: 320, h: 213 });
      this.emit({ k: 'bmp', t: t + 90, fn: 'transfer', c: 'studioPhotoSwitchFeedback:bitmap', w: 2112, h: 1408 });
      this.step(400);
      this.convert(`switch${this.focused}`, { delay: 5 });
      this.emit({ k: 'veil', t: this.step(5), shown: false, kind: null, surface: null });
      this.emit({ k: 'vis', t: this.step(5), ov: false, ready: true, busy: false });
    }
  }
  const veiled = await run('s1', ['--quick'], { sessionFactory: VeilSession.open });
  assert.equal(veiled.status, 'ok', veiled.detail);
  assert.equal(veiled.metrics['s1.firstProvisionalPixelsMs'], 84, 'provisional pixels from change');
  assert.equal(veiled.metrics['s1.provisionalKind'], 'embedded');
  assert.equal(veiled.metrics['s1.firstEmbeddedPreviewMs'], 84);
  assert.equal(veiled.metrics['s1.stage.filmEdgeMs'], 148.6, 'the film-edge read on its own');
  assert.equal(veiled.metrics['s1.stage.frameDetectMs'], 690.2);
  assert.equal(veiled.metrics['s1.stage.autoFrameMs'], 850, 'the whole request stays autoFrameMs');
  assert.equal(veiled.metrics['s1.control.stage.filmEdgeMs'], 148.6);
  assert.equal(veiled.metrics['s1.firstPhotoVisibleMs'] - veiled.metrics['s1.firstPixelsDrawnMs'], 251,
    'exact pixels drawn under the veil are visible when it hides');

  const s2 = await run('s2', ['--dpr', '2']);
  expectKeys(s2, ['s2.coreExposure.dpr2.updatesPerSecond', 's2.coreExposure.dpr2.framesCoveredPct', 's2.coreExposure.dpr2.inputToDrawP95Ms',
    's2.coreExposure.dpr2.workerRoundTripMs', 's2.coreExposure.dpr2.previewWidth', 's2.coreExposure.dpr2.probeSelfPct', 's2.cyan.dpr2.inputToDrawP50Ms',
    's2.wbR.dpr2.framesCoveredPct', 's2.coreExposure.cpu.dpr2.control.mainBusyPct', 's2.coreExposure.dpr2.control.scriptMs', 's2.coreExposure.dpr2.ui.flushes', 's2.coreExposure.dpr2.ui.lastFlushWrites', 's2.coreExposure.dpr2.ui.fileListRenders']);
  assert.equal(s2.metrics['s2.coreExposure.dpr2.framesCoveredPct'], 50, 'one conversion per two moves covers half the frames');
  assert.equal(s2.metrics['s2.cyan.dpr2.framesCoveredPct'], 100);
  assert.equal(s2.metrics['s2.cyan.dpr2.inputToDrawP50Ms'], 12);
  assert.equal(s2.metrics['s2.coreExposure.dpr2.workerRoundTripMs'], 20);
  assert.ok(!('s2.coreExposure.dpr1.updatesPerSecond' in s2.metrics), '--dpr 2 only');

  const control = await run('s2', ['--no-probe', '--scenarios', 's2', '--dpr', '2']);
  assert.equal(control.status, 'ok');
  assert.ok('s2.coreExposure.dpr2.control.mainBusyPct' in control.metrics);
  assert.ok(!('s2.coreExposure.dpr2.updatesPerSecond' in control.metrics), 'control runs record only probe-free metrics');

  const s3 = await run('s3', ['--dpr', '1,2']);
  expectKeys(s3, ['s3.curve.dpr1.inputToDrawP95Ms', 's3.curve.dpr2.updatesPerSecond', 's3.curve.dpr2.rafFps', 's3.curve.dpr2.longTaskCount', 's3.curve.dpr2.ui.flushes', 's3.curve.dpr2.ui.lastFlushWrites', 's3.curve.dpr2.ui.fileListRenders']);
  assert.equal(s3.metrics['s3.curve.dpr2.inputToDrawP50Ms'], 13);

  const s4 = await run('s4', ['--dpr', '2']);
  expectKeys(s4, ['s4.dpr2.fitTo2x.transformAppliedMs', 's4.dpr2.fitTo2x.textureRefinedAtMs', 's4.dpr2.fitTo2x.backingOverNeeded', 's4.dpr2.fitTo2x.nativeDetailMs',
    's4.dpr2.to2_5x.transformAppliedMs', 's4.dpr2.to7_6x.zoom', 's4.dpr2.fitTo100.nativeDetailMs', 's4.dpr2.fitTo100.longTaskCount', 's4.dpr2.wheel.transformAppliedMs', 's4.dpr2.pan.transformFramesPerSecond', 's4.dpr2.pan.moveToFrameP95Ms']);
  assert.equal(s4.metrics['s4.dpr2.fitTo2x.transformAppliedMs'], 11);
  assert.equal(s4.metrics['s4.dpr2.fitTo2x.textureRefinedAtMs'], 476);
  assert.equal(s4.metrics['s4.dpr2.fitTo100.detailReadyMs'], 190, 'true 100 %: the detail region lands');
  assert.equal(s4.metrics['s4.dpr2.fitTo100.nativeDetailReached'], true);
  assert.equal(s4.metrics['s4.dpr2.fitTo100.sourcePxPerDevicePx'], 1);
  // #270: where the region's time went, from the app's nc:detailRegion trace.
  assert.deepEqual(['detailRequestMs', 'detailConvertMs', 'detailDrawMs', 'detailBands', 'detailWorkerMs'].map(key => s4.metrics[`s4.dpr2.fitTo100.${key}`]),
    [20, 150, 22, 4, 112]);
  // Above true 100 % the best a view can show is below one source pixel per
  // device pixel: a native region already covering the view counts at the transform.
  assert.ok(s4.metrics['s4.dpr2.to7_6x.bestSourcePxPerDevicePx'] < 0.95);
  assert.equal(s4.metrics['s4.dpr2.to7_6x.nativeDetailReached'], true);
  assert.equal(s4.metrics['s4.dpr2.to7_6x.nativeDetailMs'], s4.metrics['s4.dpr2.to7_6x.transformAppliedMs']);
  assert.equal(s4.metrics['s4.dpr2.to3_9x.nativeDetailReached'], false, 'a soft view below 100 % is not native detail');
  assert.equal(s4.metrics['s4.dpr2.wheel.transformAppliedMs'], 0.4);
  assert.equal(s4.metrics['s4.dpr2.pan.moveToFrameP50Ms'], 8);

  const s6 = await run('s6', ['--scenarios', 's6']);
  expectRoutes(s6, roll.length);
  expectKeys(s6, ['s6.firstPositiveVisibleMs', 's6.roll.settingsAllMs', 's6.roll.thumbnailsAllMs', 's6.roll.coresUsed', 's6.roll.librawDecodes',
    's6.dragAfter.coreExposure.updatesPerSecond', 's6.dragAfter.cyan.maxLongTaskMs', 's6.memory.rendererPeakMB']);

  const s7 = await run('s7', ['--quick']);
  expectKeys(s7, ['s7.coldUnanalysed.firstPixelsMs', 's7.warm1Back.firstDisplayPositiveMs', 's7.coldAnalysed.readyMs', 's7.warm1Back.samples', 's7.coldAnalysed.longTaskCount']);
  assert.equal(s7.metrics['s7.warm1Back.samples'], 2);
  class MetadataStallSession extends FakeSession {
    static async open(options) { return new MetadataStallSession(options); }
    async endWindow() { const result = await super.endWindow(); this.switchCompleted = this.windowLabel === 's7-coldUnanalysed'; return result; }
    async evaluate(expression) {
      if (this.switchCompleted && expression.includes('__ncPerf.snapshot()')) {
        this.status = 'hang'; this.abortReason = 'stub metadata stall';
        throw new ScenarioAbort('hang', this.abortReason);
      }
      return super.evaluate(expression);
    }
  }
  const partialNavigation = await run('s7', ['--quick'], { sessionFactory: MetadataStallSession.open });
  assert.equal(partialNavigation.status, 'hang');
  assert.equal(partialNavigation.metrics['s7.coldUnanalysed.samples'], 1);
  assert.ok(Number.isFinite(partialNavigation.metrics['s7.coldUnanalysed.readyMs']), 'completed navigation survives a metadata stall');
  const s7full = await run('s7', ['--scenarios', 's7']);
  expectRoutes(s7full, roll.length);
  expectKeys(s7full, ['s7.twoBack.firstPixelsMs', 's7.rapid5.firstPixelsMs', 's7.rapid5.fromFirstPressMs', 's7.rapid5.librawDecodes']);
  assert.ok(!('s7.coldUnanalysed.firstProvisionalPixelsMs' in s7.metrics), 'no veil, no provisional pixels');
  assert.deepEqual(s7.samples['s7.cold.firstProvisionalPixelsP95Ms'], [s7.metrics['s7.coldUnanalysed.readyMs'], s7.metrics['s7.coldAnalysed.readyMs']],
    'without provisional pixels a cold sample is the uncovered exact frame (ready)');
  // HEAD's cold switch: the tile thumbnail on the veil, then the embedded
  // preview, then the exact frame; provisional and exact pixels apart.
  const s7veil = await run('s7', ['--quick'], { sessionFactory: VeilSession.open });
  assert.equal(s7veil.status, 'ok', s7veil.detail);
  assert.equal(s7veil.metrics['s7.coldUnanalysed.firstProvisionalPixelsMs'], 21);
  assert.equal(s7veil.metrics['s7.coldUnanalysed.provisionalKind'], 'thumbnail');
  assert.equal(s7veil.metrics['s7.coldUnanalysed.firstEmbeddedPreviewMs'], 90);
  assert.equal(s7veil.metrics['s7.coldAnalysed.firstProvisionalPixelsMs'], 22);
  assert.ok(s7veil.metrics['s7.coldAnalysed.firstPixelsMs'] > 400, 'the exact frame is reported on its own');
  assert.deepEqual(s7veil.samples['s7.cold.firstProvisionalPixelsP95Ms'], [21, 22], 'one pooled sample per cold switch');
  assert.ok(findMetricDef(budgets, 's7.cold.firstProvisionalPixelsP95Ms').target <= 200);

  // A press point that misses the slider fails the step (S2's wbR, #273)
  // instead of recording a drag that moved nothing.
  class CoveredSliderSession extends FakeSession {
    static async open(options) { return new CoveredSliderSession(options); }
    async evaluate(expression) {
      if (expression.includes('sliderPressPoint: true') && expression.includes('"wbR"')) {
        this.step(1);
        this.pressChecks = (this.pressChecks || 0) + 1;
        return { sliderPressPoint: true, x: 208, y: 210, width: 216, value: '1', min: 0.5, max: 2, fraction: 1 / 3, hit: 'additionalSectionContent' };
      }
      return super.evaluate(expression);
    }
  }
  let covered;
  const coveredRun = await run('s2', ['--dpr', '2'], { sessionFactory: async options => (covered = await CoveredSliderSession.open(options)) });
  assert.equal(coveredRun.status, 'ui');
  assert.match(coveredRun.detail, /s2\.wbR\.dpr2: the press point \(208, 210\) hits #additionalSectionContent, not #wbR/);
  assert.equal(covered.pressChecks, 2, 'revealed and checked once more before failing');
  assert.ok('s2.coreTemperature.dpr2.inputs' in coveredRun.metrics && !('s2.wbR.dpr2.inputs' in coveredRun.metrics));
  class StrayPressSession extends FakeSession {
    static async open(options) { return new StrayPressSession(options); }
    async drag(options) {
      if (this.lastId === 'cyan') this.lastId = 'additionalSectionContent';
      return super.drag(options);
    }
  }
  const stray = await run('s2', ['--dpr', '2'], { sessionFactory: StrayPressSession.open });
  assert.equal(stray.status, 'ui');
  assert.match(stray.detail, /s2\.cyan\.dpr2: the press landed on #additionalSectionContent, not #cyan/);

  const s5 = await run('s5', ['--scenarios', 's5']);
  expectKeys(s5, ['s5.enterCrop.firstDrawMs', 's5.enterCrop.previewPx', 's5.enterCrop.showsPositive', 's5.edgeDrag.overlayFps', 's5.edgeDrag.moveToFrameP95Ms',
    's5.straighten.releaseToPreviewMs', 's5.applyCrop.positiveDrawnMs', 's5.applyCrop.maxLongTaskMs', 's5.rotate90a.firstRedrawMs', 's5.rotate90b.maxLongTaskMs', 's5.mirror.firstRedrawMs']);
  assert.equal(s5.metrics['s5.enterCrop.previewPx'], '953×633');
  assert.equal(s5.metrics['s5.enterCrop.showsPositive'], 'false', 'crop mode shows the negative at 1703835');
  assert.equal(s5.metrics['s5.rotate90a.maxLongTaskMs'], 2000);

  const s8 = await run('s8', ['--scenarios', 's8']);
  expectRoutes(s8, roll.length);
  expectKeys(s8, ['s8.open.firstFrameMs', 's8.open.clickHandlerMs', 's8.allTilesFinalMs', 's8.scrollNormal.fps', 's8.scrollFast.framesOver25',
    's8.activeTileReencodesPerDrag', 's8.syncColours.allFinalMs', 's8.syncColours.librawDecodes']);

  const s9 = await run('s9', ['--scenarios', 's9']);
  expectRoutes(s9, 4);
  expectKeys(s9, ['s9.single.png8.imported.totalMs', 's9.single.tiff16.imported.bytes', 's9.single.jpegGain.imported.maxLongTaskMs',
    's9.single.jpegNoGain.geometry.totalMs', 's9.zip.tiff16.msPerFile', 's9.single.png8.imported.inputsAccepted', 's9.single.png8.imported.memoryPeakMB',
    's9.memory.retainedAfterExportMB', 's9.single.png16.imported.encodeMs', 's9.zip.png16.lanes1.lanes', 's9.single.dng.imported.totalMs', 's9.zip.dng.linearDngBuildMs', 's9.zip.dng.blobMs']);
  assert.deepEqual(s9.hashes, {}, 'timing repetitions do not hash');
  const verify = await run('s9', ['--scenarios', 's9'], { extra: SCENARIOS.s9.extraReps[0] });
  assert.equal(verify.status, 'ok', verify.detail);
  assert.equal(verify.metrics['s9.single.tiff16.imported.bitDepth'], 16, 'the TIFF16 header is checked');
  assert.equal(verify.metrics['s9.single.png8.imported.bitDepth'], 8);
  assert.equal(verify.metrics['s9.single.png16.imported.bitDepth'], 16);
  assert.ok(verify.hashes['s9.single.png16.imported.pixelsSha256']);
  assert.equal(verify.metrics['s9.single.png16.geometry.rotationAngle'], '90');
  assert.equal(verify.metrics['s9.single.png16.geometry.mirrored'], 'true');
  assert.match(verify.metrics['s9.single.png16.geometry.cropRegion'], /1600/);
  assert.ok(verify.hashes['s9.single.png8.imported.pixelsSha256'] && verify.hashes['s9.single.tiff16.geometry.pixelsSha256']);
  assert.equal(verify.hashes['s9.single.jpegGain.imported.pixelsSha256'], 'jpeg-pixels');
  const verifyZip = await run('s9', ['--scenarios', 's9'], { extra: SCENARIOS.s9.extraReps.find(extra => extra.label === 'verify-zip') });
  assert.equal(verifyZip.status, 'ok', verifyZip.detail);
  assert.equal(verifyZip.hashes['s9.zip.tiff16.entry2.pixelsSha256'], verifyZip.hashes['s9.zip.tiff16.entry0.pixelsSha256']);
  assert.equal(verifyZip.hashes['s9.zip.jpegGain.entry0.pixelsSha256'], 'jpeg-pixels');
  assert.equal(verifyZip.metrics['s9.zip.png16.lanes1.entry2.bitDepth'], 16);
  class WrongZipDepthSession extends FakeSession {
    static async open(options) { return new WrongZipDepthSession(options); }
    async writeExport(entry, name) { return super.writeExport({ ...entry, bitDepth: 8 }, name); }
  }
  const wrongZipDepth = await run('s9', ['--scenarios', 's9'], { sessionFactory: WrongZipDepthSession.open,
    extra: { ...SCENARIOS.s9.extraReps.find(extra => extra.label === 'verify-zip'), only: ['zip.png16.lanes1'] } });
  assert.equal(wrongZipDepth.status, 'error');
  assert.match(wrongZipDepth.detail, /requested 16-bit, ZIP entry .* says 8-bit/);
  assert.ok(!('s9.single.png8.imported.inputsAccepted' in verify.metrics), 'no inputs are sent while bytes are verified');
  const noflag = await run('s9', ['--scenarios', 's9'], { extra: SCENARIOS.s9.extraReps.find(extra => extra.label === 'verify-noflag') });
  assert.deepEqual(Object.keys(noflag.hashes).sort(), ['s9.single.jpegGain.imported.pixelsSha256', 's9.single.png8.imported.pixelsSha256', 's9.single.tiff16.imported.pixelsSha256']);
  assert.equal(noflag.hashes['s9.single.tiff16.imported.pixelsSha256'], verify.hashes['s9.single.tiff16.imported.pixelsSha256']);

  const parallel = await run('s9-parallel', ['--scenarios', 's9-parallel'], { extra: SCENARIOS['s9-parallel'].extraReps[0] });
  expectKeys(parallel, ['s9.zip.png16.lanes3.lanes', 's9.zip.png16.lanes3.encodeMs', 's9.zip.png16.lanes3.entry0.bitDepth']);
  assert.equal(parallel.metrics['s9.zip.png16.lanes3.lanes'], 3);
  assert.ok(parallel.hashes['s9.zip.png16.lanes3.entry0.pixelsSha256']);
  class OneLaneSession extends FakeSession {
    static async open(options) { return new OneLaneSession(options); }
    async click(...args) { await super.click(...args); for (const event of this.pending) if (event.n === 'nc:batchExport') event.detail.lanes = 1; }
  }
  const wrongLanes = await run('s9-parallel', ['--scenarios', 's9-parallel'], { sessionFactory: OneLaneSession.open });
  assert.equal(wrongLanes.status, 'error');
  assert.match(wrongLanes.detail, /planner ran 1 lanes/);

  const dust = await run('dust-brush', ['--scenarios', 'dust-brush']);
  expectKeys(dust, ['dust-brush.photo0.route', 'dust-brush.photo0.filmType', 'dust-brush.releaseToRepairedP95Ms',
    'dust-brush.stroke19.releaseToRepairedMs', 'dust-brush.postMessageMaxBytes', 'dust-brush.memory.rendererPeakMB']);
  assert.equal(dust.metrics['dust-brush.strokes'], 20);
  assert.equal(dust.metrics['dust-brush.postMessageMaxBytes'], 4096);
  assert.equal(dust.metrics['dust-brush.releaseToRepairedP95Ms'], 19);
  const overlay = await run('overlay-idle', ['--scenarios', 'overlay-idle']);
  expectKeys(overlay, ['overlay-idle.photo0.route', 'overlay-idle.passed', 'overlay-idle.runningAnimations']);
  assert.equal(overlay.metrics['overlay-idle.runningAnimations'], 0);
  class NoExportOverlaySession extends FakeSession {
    static async open(options) { return new NoExportOverlaySession(options); }
    async click(...args) { await super.click(...args); this.pending = this.pending.filter(event => event.k !== 'vis'); }
  }
  const noOverlay = await run('overlay-idle', ['--scenarios', 'overlay-idle'], { sessionFactory: NoExportOverlaySession.open });
  assert.equal(noOverlay.status, 'error');
  assert.match(noOverlay.detail, /no loading overlay was shown during export/);
  let cameraOptions;
  const loupe = await run('loupe', ['--scenarios', 'loupe'], { sessionFactory: async options => { cameraOptions = options; return new FakeSession(options); } });
  expectKeys(loupe, ['loupe.photo0.route', 'loupe.mainBusyPct', 'loupe.conversions', 'loupe.grabs']);
  assert.equal(cameraOptions.fakeCamera, true);
  assert.equal(loupe.metrics['loupe.conversions'], 30);

  // A background conversion after import must not replace photo 0's route.
  class BackgroundSession extends FakeSession {
    static async open(options) { return new BackgroundSession(options); }
    async setFiles(paths) { await super.setFiles(paths); this.convert('background', { cache: false, ft: 'bw', paint: false }); }
  }
  const background = await run('s6', ['--scenarios', 's6'], { sessionFactory: BackgroundSession.open });
  assert.equal(background.metrics['s6.photo0.route'], 'color');
  assert.equal(background.metrics['s6.photo0.filmType'], 'color');
  assert.equal(background.routes.find(route => route.photo === roll[0].name).request.id, 1);
  class UncachedForegroundSession extends BackgroundSession {
    static async open(options) { return new UncachedForegroundSession(options); }
    async setFiles(paths) {
      await super.setFiles(paths);
      for (const event of this.pending) if (event.cls === 'convert') event.cache = false;
    }
  }
  const uncached = await run('s1', ['--quick'], { sessionFactory: UncachedForegroundSession.open });
  assert.equal(uncached.metrics['s1.photo0.route'], 'color');
  assert.equal(uncached.routes[0].request.id, 1, 'display hash attributes an uncached foreground result');
  class GpuRouteSession extends FakeSession {
    static async open(options) { return new GpuRouteSession(options); }
    async setFiles(paths) {
      await super.setFiles(paths);
      this.pending = this.pending.filter(event => event.cls !== 'convert' && !event.k.startsWith('gl.'));
      const t = this.step(1);
      this.emit({ k: 'req', t, wid: 7, cls: 'prepare', id: 20, cache: true, ft: 'positive', pe: 'legacy' });
      this.emit({ k: 'res', t: this.step(20), rt: t, wid: 7, cls: 'prepare', id: 20 });
      this.emit({ k: 'gl.upload', t: this.step(1), c: 'glCanvas', w: 1809, h: 1202, format: 0x8D99, type: 0x1403 });
      this.emit({ k: 'gl.draw', t: this.step(1), c: 'glCanvas', sig: 'gpu-source' });
      this.convert('background', { cache: false, ft: 'bw', paint: false });
    }
  }
  const gpuRoute = await run('s1', ['--quick'], { sessionFactory: GpuRouteSession.open });
  assert.equal(gpuRoute.metrics['s1.photo0.route'], 'positive-legacy');
  assert.equal(gpuRoute.metrics['s1.photo0.filmType'], 'positive');
  assert.equal(gpuRoute.routes[0].request.id, 20);

  let timingOptions, profiledOptions;
  await run('s1', ['--quick'], { sessionFactory: async options => { timingOptions = options; return new FakeSession(options); } });
  await run('s1', ['--quick'], { profiled: true, sessionFactory: async options => { profiledOptions = options; return new FakeSession(options); } });
  assert.equal(timingOptions.captureStacks, false);
  assert.equal(profiledOptions.captureStacks, true);

  let hangOptions;
  const h = await run('h', ['--scenarios', 'h'], { sessionFactory: async options => { hangOptions = options; return new FakeSession(options); } });
  assert.equal(hangOptions.captureStacks, true);
  for (const result of [s3, s4, s5, h]) expectRoutes(result);
  expectKeys(h, ['h.stalls', 'h.drags', 'h.fixture']);
  assert.equal(h.metrics['h.stalls'], 0);
  assert.equal(h.metrics['h.drags'], 100);
  // A stall is dumped, counted, and the remaining drags continue in a new browser.
  let opened = 0;
  class StallingSession extends FakeSession {
    static async open(options) { opened++; return new StallingSession(options); }
    async drag(options) {
      if (opened === 1 && this.lastId === 'curveCanvas' && (this.drags = (this.drags || 0) + 1) === 3) {
        this.status = 'hang';
        this.abortReason = 'page silent for 30 s';
        this.hangDump = { info: { silentMs: 30_000 }, file: 'hang.json', stacks: [{ kind: 'page', frames: [{ function: 'applyLUT' }] }] };
        throw new ScenarioAbort('hang', 'fake stall');
      }
      return super.drag(options);
    }
  }
  const stalled = await run('h', ['--scenarios', 'h'], { sessionFactory: StallingSession.open });
  assert.equal(stalled.status, 'ok', stalled.detail);
  assert.equal(stalled.metrics['h.stalls'], 1);
  assert.equal(stalled.metrics['h.drags'], 99);
  assert.equal(stalled.hangs[0].topFrame, 'applyLUT');
  assert.equal(opened, 2, 'the browser is relaunched after the stall');

  let selftestOptions;
  const selftest = await run('selftest-hang', ['--inject-hang'], { fixture: { name: 'negative-sample.jpg', path: '/fixtures/negative-sample.jpg' },
    sessionFactory: async options => { selftestOptions = options; return new FakeSession(options); } });
  assert.equal(selftestOptions.captureStacks, true);
  assert.equal(selftest.status, 'ok', `the expected hang is not a failure: ${selftest.detail}`);
  assert.equal(selftest.selftestPassed, true, JSON.stringify(selftest.metrics));
  assert.equal(selftest.metrics['selftest.injectedFrame'], 'true');

  // A session that dies mid-scenario ends the repetition with its status.
  class DyingSession extends FakeSession {
    async setFiles(paths) { await super.setFiles(paths); this.status = 'memory-ceiling'; this.memoryCeiling = { detail: 'browser footprint 3.10 GB > ceiling 3.00 GB', browserGoneMs: 140 }; this.lastMemorySample = this.sampler.samples[0]; this.currentWindow = 's1-import'; }
    static async open(options) { return new DyingSession(options); }
  }
  const dead = await run('s1', ['--quick'], { sessionFactory: DyingSession.open });
  assert.equal(dead.status, 'memory-ceiling');
  assert.equal(dead.memoryCeiling.browserGoneMs, 140);
  assert.equal(dead.memoryCeiling.window, 's1-import');
  assert.equal(dead.lastMemorySample.totalMB, 2048);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('scenarios: S1-S9 (incl. CPU path, control run, S9 byte verification), H with a stall, the hang self-test and a memory-ceiling abort run end to end on a simulated session');
