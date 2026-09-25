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
import { encodeTiffBlob } from '../../../negative2positive/src/workers/imageEncoders.js';
import { ZipStoreWriter } from '../../../negative2positive/src/app/zipStoreWriter.js';

const UPNG = createRequire(import.meta.url)('upng-js');

// Simulated sessions need no real waiting.
process.env.NC_PERF_TIME_SCALE = '0';
const { parseArgs } = await import('../lib/args.mjs');
const { runRepetition } = await import('../lib/runner.mjs');
const { SCENARIOS } = await import('./index.mjs');
const { ScenarioAbort } = await import('../lib/session.mjs');

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
        this.hangDump = {
          info: { silentMs: 30_500 }, file: join(this.options.outDir, `hang-${this.options.label}.json`), trace: 'trace.json.gz',
          stacks: [{ kind: 'page', frames: [{ function: 'ncInjectedHang' }] }, { kind: 'worker', url: 'conversionWorker.js', frames: [{ function: 'onmessage' }] }],
          ring: { ring: [{ k: 'input', t: 1 }] }, samples: [{ pid: 1, file: sample }], processes: [{ type: 'renderer', id: 1, cpuTime: 31 }]
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
  convert(value, { cache = true, delay = 20 } = {}) {
    const id = ++this.hash;
    const rt = this.step(1);
    this.emit({ k: 'req', t: rt, wid: 7, cls: 'convert', id, cache, ft: 'color' });
    const hash = `h${id}-${value}`;
    this.emit({ k: 'res', t: this.step(delay), wid: 7, cls: 'convert', id, rt, hash, cache, w: 1809, h: 1202 });
    this.emit({ k: 'gl.upload', t: this.step(1), c: 'glCanvas', w: 1809, h: 1202, hash });
    this.emit({ k: 'gl.draw', t: this.step(2), c: 'glCanvas', sig: `sig-${hash}` });
  }
  snapshot() {
    return {
      t: this.t, dpr: this.dpr, ready: true, busy: false, filename: this.current ? basename(this.current) : '', filmType: 'color', filmTypeStatus: 'Colour negative',
      glCanvas: { width: 1809, height: 1202, display: 'block', rect: { width: 904 * this.zoom, height: 601 * this.zoom } },
      transform: `matrix(${this.zoom}, 0, 0, ${this.zoom}, 0, 0)`, files: this.files.length, badges: this.files.length, thumbnails: this.files.length,
      transferBytes: 1024 * 900, decodedBytes: 1024 * 4000, memory: null
    };
  }
  async evaluate(expression) {
    this.check();
    this.step(1);
    if (expression === 'performance.now()') return this.t;
    if (expression.includes('? performance.now() : null')) return this.t;
    if (expression.includes('__ncPerf.snapshot()')) return this.snapshot();
    if (expression.includes('return { value: e.value')) return { value: '0', min: -100, max: 100 };
    if (expression.includes(".file-list-name')].map")) return this.files.map((_, i) => i);
    const focus = /data-index="(\d+)"\]'\);\s*if \(!button\) return false;/.exec(expression);
    if (focus) { this.focused = Number(focus[1]); return true; }
    if (expression.includes("document.querySelectorAll('.file-list-settings-badge').length <")) return false;
    if (expression.includes('aria-current')) return '0';
    if (expression.includes('__ncPerf.selfMs()')) return this.selfMs;
    const format = /\.format-btn\[data-format="(\w+)"\]'\)\.click\(\)/.exec(expression);
    if (format) { this.format = format[1]; return true; }
    const depth = /\.bitdepth-btn\[data-bitdepth="(\d+)"\]'\)\.click\(\)/.exec(expression);
    if (depth) { this.bitDepth = Number(depth[1]); return true; }
    if (expression.includes('__ncPerf.exports.list()')) return this.exportsList.map((entry, index) => ({ index, t: entry.t, end: entry.t, name: entry.name, size: 1000, kind: entry.kind, done: true }));
    if (expression.includes('__ncPerf.exports.clear()')) { this.exportsList = []; return true; }
    const upload = /exports\.upload\((\d+), '\/__perf\/export\?name=' \+ encodeURIComponent\("([^"]+)"\)\)/.exec(expression);
    if (upload) return this.writeExport(this.exportsList[Number(upload[1])], upload[2]);
    if (expression.includes('exports.jpegSha256')) return { width: 10, height: 10, sha256: 'jpeg-pixels' };
    return true;
  }
  async writeExport(entry, name) {
    const safe = basename(name).replace(/[^\w.-]+/g, '_');
    // The preview plugin writes uploads into the ref's export dir.
    const file = join(FakeSession.exportDir, `${++this.uploadSeq}-${safe}`);
    const rgba16 = new Uint16Array(4 * 4 * 4).fill(4097);
    const tiff = async () => new Uint8Array(await encodeTiffBlob(rgba16, 4, 4, entry.bitDepth).arrayBuffer());
    let bytes;
    // More than 256 colours, so UPNG keeps 8-bit truecolour like the app's PNG8.
    if (/\.png$/.test(name)) bytes = new Uint8Array(UPNG.encode([new Uint8Array(32 * 32 * 4).map((_, i) => (i * 37) & 255).buffer], 32, 32, 0));
    else if (/\.tiff?$/.test(name)) bytes = await tiff();
    else if (/\.jpe?g$/.test(name)) bytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]);
    else {
      const chunks = [];
      const writer = new ZipStoreWriter({ write: async chunk => { chunks.push(new Uint8Array(chunk)); } });
      for (let i = 0; i < 3; i++) await writer.addBlob(`f${i}.tif`, new Blob([await tiff()]));
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
    if (id === 'cropBtn') this.emit({ k: 'c2d', t: this.step(30), c: 'canvas', fn: 'putImageData', w: 953, h: 633, hash: `crop${t}` });
    if (id === 'applyCropBtn' || id === 'rotateRightBtn' || id === 'mirrorBtn') {
      this.emit({ k: 'lt', t: t + 1, s: t + 1, d: 2000 });
      this.step(2000);
      this.convert(id, { delay: 60 });
    }
    if (id === 'studioToggleLightTable') this.emit({ k: 'et', t, n: 'click', s: t, ps: t + 1, pe: t + 3, d: 16 });
    if (id === 'exportSingleBtn' || id === 'exportZipBtn') {
      const ext = this.format === 'jpeg' ? 'jpg' : this.format === 'tiff' ? 'tif' : 'png';
      this.step(1500);
      this.exportsList.push({ t: this.t, name: id === 'exportZipBtn' ? 'converted_negatives.zip' : `L1000617_positive.${ext}`, kind: id === 'exportZipBtn' ? 'stream' : 'download', bitDepth: this.bitDepth });
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
  const collector = { groups: { roll, export: [single, ...roll.slice(0, 3)] }, gpu: null };
  const run = (id, argv, overrides = {}) => runRepetition({
    scenario: SCENARIOS[id], fixture: ['roll', 'export'].includes(SCENARIOS[id].fixtureGroup) ? null : single,
    group: SCENARIOS[id].fixtureGroup, ref, rep: 0, args: parseArgs(argv, {}), profiled: false, outDir: dir,
    chromeBin: 'chrome', ceilingBytes: 1e12, swapAtStart: 0, collector, sessionFactory: FakeSession.open, ...overrides
  });
  const expectKeys = (result, keys) => {
    assert.equal(result.status, 'ok', `${result.label}: ${result.detail}`);
    for (const key of keys) assert.ok(key in result.metrics, `${result.label} records ${key} (has ${Object.keys(result.metrics).slice(0, 12).join(', ')}…)`);
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

  const s2 = await run('s2', ['--dpr', '2']);
  expectKeys(s2, ['s2.coreExposure.dpr2.updatesPerSecond', 's2.coreExposure.dpr2.framesCoveredPct', 's2.coreExposure.dpr2.inputToDrawP95Ms',
    's2.coreExposure.dpr2.workerRoundTripMs', 's2.coreExposure.dpr2.previewWidth', 's2.coreExposure.dpr2.probeSelfPct', 's2.cyan.dpr2.inputToDrawP50Ms',
    's2.wbR.dpr2.framesCoveredPct', 's2.coreExposure.cpu.dpr2.control.mainBusyPct', 's2.coreExposure.dpr2.control.scriptMs']);
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
  expectKeys(s3, ['s3.curve.dpr1.inputToDrawP95Ms', 's3.curve.dpr2.updatesPerSecond', 's3.curve.dpr2.rafFps', 's3.curve.dpr2.longTaskCount']);
  assert.equal(s3.metrics['s3.curve.dpr2.inputToDrawP50Ms'], 13);

  const s4 = await run('s4', ['--dpr', '2']);
  expectKeys(s4, ['s4.dpr2.fitTo2x.transformAppliedMs', 's4.dpr2.fitTo2x.textureRefinedAtMs', 's4.dpr2.fitTo2x.backingOverNeeded', 's4.dpr2.fitTo2x.nativeDetailMs',
    's4.dpr2.to2_5x.transformAppliedMs', 's4.dpr2.to7_6x.zoom', 's4.dpr2.wheel.transformAppliedMs', 's4.dpr2.pan.transformFramesPerSecond', 's4.dpr2.pan.moveToFrameP95Ms']);
  assert.equal(s4.metrics['s4.dpr2.fitTo2x.transformAppliedMs'], 11);
  assert.equal(s4.metrics['s4.dpr2.fitTo2x.textureRefinedAtMs'], 476);
  assert.equal(s4.metrics['s4.dpr2.wheel.transformAppliedMs'], 0.4);
  assert.equal(s4.metrics['s4.dpr2.pan.moveToFrameP50Ms'], 8);

  const s6 = await run('s6', ['--scenarios', 's6']);
  expectKeys(s6, ['s6.firstPositiveVisibleMs', 's6.roll.settingsAllMs', 's6.roll.thumbnailsAllMs', 's6.roll.coresUsed', 's6.roll.librawDecodes',
    's6.dragAfter.coreExposure.updatesPerSecond', 's6.dragAfter.cyan.maxLongTaskMs', 's6.memory.rendererPeakMB']);

  const s7 = await run('s7', ['--quick']);
  expectKeys(s7, ['s7.coldUnanalysed.firstPixelsMs', 's7.warm1Back.firstDisplayPositiveMs', 's7.coldAnalysed.readyMs', 's7.warm1Back.samples', 's7.coldAnalysed.longTaskCount']);
  assert.equal(s7.metrics['s7.warm1Back.samples'], 2);
  const s7full = await run('s7', ['--scenarios', 's7']);
  expectKeys(s7full, ['s7.twoBack.firstPixelsMs', 's7.rapid5.firstPixelsMs', 's7.rapid5.fromFirstPressMs', 's7.rapid5.librawDecodes']);

  const s5 = await run('s5', ['--scenarios', 's5']);
  expectKeys(s5, ['s5.enterCrop.firstDrawMs', 's5.enterCrop.previewPx', 's5.enterCrop.showsPositive', 's5.edgeDrag.overlayFps', 's5.edgeDrag.moveToFrameP95Ms',
    's5.straighten.releaseToPreviewMs', 's5.applyCrop.positiveDrawnMs', 's5.applyCrop.maxLongTaskMs', 's5.rotate90a.firstRedrawMs', 's5.rotate90b.maxLongTaskMs', 's5.mirror.firstRedrawMs']);
  assert.equal(s5.metrics['s5.enterCrop.previewPx'], '953×633');
  assert.equal(s5.metrics['s5.enterCrop.showsPositive'], 'false', 'crop mode shows the negative at 1703835');
  assert.equal(s5.metrics['s5.rotate90a.maxLongTaskMs'], 2000);

  const s8 = await run('s8', ['--scenarios', 's8']);
  expectKeys(s8, ['s8.open.firstFrameMs', 's8.open.clickHandlerMs', 's8.allTilesFinalMs', 's8.scrollNormal.fps', 's8.scrollFast.framesOver25',
    's8.activeTileReencodesPerDrag', 's8.syncColours.allFinalMs', 's8.syncColours.librawDecodes']);

  const s9 = await run('s9', ['--scenarios', 's9']);
  expectKeys(s9, ['s9.single.png8.imported.totalMs', 's9.single.tiff16.imported.bytes', 's9.single.jpegGain.imported.maxLongTaskMs',
    's9.single.jpegNoGain.geometry.totalMs', 's9.zip.tiff16.msPerFile', 's9.single.png8.imported.inputsAccepted', 's9.single.png8.imported.memoryPeakMB',
    's9.memory.retainedAfterExportMB']);
  assert.deepEqual(s9.hashes, {}, 'timing repetitions do not hash');
  const verify = await run('s9', ['--scenarios', 's9'], { extra: SCENARIOS.s9.extraReps[0] });
  assert.equal(verify.status, 'ok', verify.detail);
  assert.equal(verify.metrics['s9.single.tiff16.imported.bitDepth'], 16, 'the TIFF16 header is checked');
  assert.equal(verify.metrics['s9.single.png8.imported.bitDepth'], 8);
  assert.ok(verify.hashes['s9.single.png8.imported.pixelsSha256'] && verify.hashes['s9.single.tiff16.geometry.pixelsSha256']);
  assert.equal(verify.hashes['s9.single.jpegGain.imported.pixelsSha256'], 'jpeg-pixels');
  assert.equal(verify.hashes['s9.zip.tiff16.entry2.pixelsSha256'], verify.hashes['s9.zip.tiff16.entry0.pixelsSha256']);
  assert.ok(!('s9.single.png8.imported.inputsAccepted' in verify.metrics), 'no inputs are sent while bytes are verified');
  const noflag = await run('s9', ['--scenarios', 's9'], { extra: SCENARIOS.s9.extraReps[1] });
  assert.deepEqual(Object.keys(noflag.hashes).sort(), ['s9.single.jpegGain.imported.pixelsSha256', 's9.single.png8.imported.pixelsSha256', 's9.single.tiff16.imported.pixelsSha256']);
  assert.equal(noflag.hashes['s9.single.tiff16.imported.pixelsSha256'], verify.hashes['s9.single.tiff16.imported.pixelsSha256']);

  const h = await run('h', ['--scenarios', 'h']);
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

  const selftest = await run('selftest-hang', ['--inject-hang'], { fixture: { name: 'negative-sample.jpg', path: '/fixtures/negative-sample.jpg' } });
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
