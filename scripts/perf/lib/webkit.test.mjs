// Safari mode's scenario code against a scripted WebDriver session: the
// execute scripts, trusted actions and metric mapping run in Node.
import assert from 'node:assert/strict';

process.env.NC_PERF_TIME_SCALE = '0';
const { safariScenario } = await import('./webkit.mjs');
const { webkitMemory } = await import('./webkit.mjs');
const { GiB } = await import('./guards.mjs');

// Mail's pre-existing WebContent/GPU never enter the harness footprint.
{
  let processList = [
    { pid: 900000001, command: 'com.apple.WebKit.WebContent' },
    { pid: 900000002, command: 'com.apple.WebKit.GPU' }
  ];
  const reads = [], aborted = [];
  const memory = await webkitMemory({ label: 'fake', port: 1, outDir: '.', args: { force: true },
    freeDiskAtStart: 4.5 * GiB, swapAtStart: 0, ceilingBytes: GiB, start: false,
    list: async () => processList, connected: async () => [900000003], associatedGpu: async () => [900000004],
    readSwap: async () => ({ used: 0 }), readDisk: () => 4.5 * GiB,
    reader: { start: async () => {}, stop() {}, read: async pids => {
      reads.push(pids); return Object.fromEntries(pids.map(pid => [pid, { footprint: 0.6 * GiB }]));
    } }, onAbort: verdict => aborted.push(verdict)
  });
  processList = [...processList, { pid: 900000003, command: 'com.apple.WebKit.WebContent' }, { pid: 900000004, command: 'com.apple.WebKit.GPU' }];
  await memory.sampler.tick();
  assert.deepEqual(reads, [[900000003, 900000004]]);
  assert.equal(aborted.length, 1);
  assert.equal(aborted[0].reason, 'memory-ceiling');
  memory.assertScope();
  memory.stop();
}

class FakeWebDriver {
  constructor() { this.t = 1000; this.pending = []; this.files = []; this.focused = 0; this.current = null; this.lastRect = null; this.zoom = 1; this.windowStart = 0; }
  emit(event) { this.pending.push(event); }
  step(ms) { this.t += ms; return this.t; }
  convert(tag) {
    const rt = this.step(1);
    this.emit({ k: 'req', t: rt, wid: 1, cls: 'convert', id: rt, cache: true });
    this.emit({ k: 'res', t: this.step(25), wid: 1, cls: 'convert', id: rt, rt, hash: tag, cache: true, w: 1800, h: 1200 });
    this.emit({ k: 'gl.upload', t: this.step(1), c: 'glCanvas', w: 1800, h: 1200, hash: tag });
    this.emit({ k: 'gl.draw', t: this.step(2), c: 'glCanvas', sig: tag });
  }
  async navigate() { this.step(500); }
  async execute(script, args = []) {
    this.step(2);
    if (script.includes('drain()')) { const events = this.pending; this.pending = []; return { events }; }
    if (script === 'return performance.now()') return this.t;
    if (script.includes('beginWindow')) { this.windowStart = this.t; return this.t; }
    if (script.includes('endWindow()')) {
      this.step(100);
      const frames = [], ticks = [];
      for (let f = this.windowStart; f <= this.t; f += 1000 / 60) frames.push(f);
      for (let f = this.windowStart; f <= this.t; f += 5) ticks.push(f);
      ticks.splice(5, 12); // one 60 ms gap: a long task seen by the heartbeat
      return { start: this.windowStart, end: this.t, frames, ticks };
    }
    if (script === 'return devicePixelRatio') return 2;
    if (script.includes("getElementById(arguments[0])") && script.includes('getBoundingClientRect')) {
      this.lastRect = args[0];
      return { x: 100, y: 200, width: 216, height: 20, value: '0', min: -100, max: 100 };
    }
    if (script.includes("getElementById('canvasContainer')")) { this.lastRect = 'canvasContainer'; return { x: 0, y: 0, width: 900, height: 600 }; }
    if (script.includes('__ncPerf.snapshot()')) return { glCanvas: { rect: { width: 900 * this.zoom } } };
    if (script.includes('.file-list-name\')].map')) return this.files.map((_, i) => i);
    if (script.includes('.focus()')) { this.focused = args[0]; return true; }
    if (script.includes('zoomResetBtn')) { this.zoom = 1; return true; }
    return true;
  }
  async executeAsync(script, args) {
    this.files = args[0];
    this.current = this.files[0];
    this.emit({ k: 'input', type: 'change', id: 'fileInput', t: this.step(5), tr: false });
    this.emit({ k: 'c2d', t: this.step(900), c: 'canvas', fn: 'putImageData', w: 6000, h: 4000, hash: 'neg' });
    this.convert('import');
    this.emit({ k: 'vis', t: this.step(5), ov: false, ready: true, busy: false });
    this.emit({ k: 'mut', t: this.t, what: 'filename', v: this.current });
    this.step(3000);
    return this.files.map(name => ({ name, size: 1 }));
  }
  async drag({ from, to, steps }) {
    const id = this.lastRect;
    this.emit({ k: 'input', type: 'mousedown', id, t: this.step(5), tr: true, b: 1 });
    for (let i = 1; i <= steps; i++) {
      const t = this.step(16);
      this.emit({ k: 'input', type: 'mousemove', id, t, tr: true, b: 1, x: from.x + i, y: from.y });
      if (id === 'canvasContainer') this.emit({ k: 'mut', t: t + 9, what: 'transform', v: `p${i}` });
      else {
        this.emit({ k: 'input', type: 'input', id, t: t + 0.2, tr: true, v: String(i) });
        if (id.startsWith('core')) { if (i % 3 === 0) { this.convert(`${id}${i}`); this.t = t; } }
        else this.emit({ k: 'gl.draw', t: t + 10, c: 'glCanvas', sig: `${id}${i}`, ut: t + 1 });
      }
    }
    this.emit({ k: 'input', type: 'mouseup', id, t: this.step(20), tr: true, b: 0 });
  }
  async click(x, y, { count = 1 } = {}) {
    if (count === 2) {
      const t = this.step(10);
      this.zoom = 2;
      this.emit({ k: 'input', type: 'dblclick', id: 'canvas', t, tr: true });
      this.emit({ k: 'mut', t: t + 13, what: 'transform', v: 'matrix(2, 0, 0, 2, 0, 0)' });
      this.emit({ k: 'gl.upload', t: t + 400, c: 'glCanvas', w: 2400, h: 1600, hash: 'zoom' });
      this.emit({ k: 'gl.draw', t: t + 402, c: 'glCanvas', sig: 'zoom' });
      this.step(500);
    }
  }
  async wheel(x, y, deltaY, count) {
    for (let i = 0; i < count; i++) {
      const t = this.step(16);
      this.emit({ k: 'input', type: 'wheel', t, tr: true });
      this.emit({ k: 'mut', t: t + 1, what: 'transform', v: `w${i}` });
    }
  }
  async keys(values) {
    for (const value of values) {
      const t = this.step(5);
      if (value === '') this.focused += 1;
      if (value === '') this.focused -= 1;
      if (value === '') {
        this.emit({ k: 'input', type: 'keydown', key: 'Enter', t, tr: true });
        this.current = this.files[this.focused];
        this.emit({ k: 'mut', t: t + 2, what: 'filename', v: this.current });
        this.step(80);
        this.convert(`switch${this.focused}`);
        this.emit({ k: 'vis', t: this.step(3), ov: false, ready: true, busy: false });
      }
    }
  }
}

const run = async (id, extra = {}) => {
  const metrics = {};
  const notes = [];
  await safariScenario(id, {
    wd: new FakeWebDriver(), origin: 'http://127.0.0.1:1', fixture: { name: 'synthetic-24mp-cfa.dng', width: 6000 },
    roll: Array.from({ length: 4 }, (_, i) => ({ name: `r${i}.dng` })),
    record: (key, value) => { if (value !== null && value !== undefined) metrics[key] = value; }, note: text => notes.push(text), ...extra
  });
  return { metrics, notes };
};

const s1 = await run('s1');
assert.equal(s1.metrics['s1.firstPixelsDrawnMs'], 900);
assert.ok(s1.metrics['s1.firstPositiveVisibleMs'] > 900);
assert.equal(s1.metrics['s1.timerGapCount'], 1, 'the heartbeat gap stands in for long tasks');
assert.ok(s1.metrics['s1.mainBusyPct'] > 0);

const s2 = await run('s2');
assert.ok(s2.metrics['s2.coreExposure.dpr2.updatesPerSecond'] > 0);
const covered = s2.metrics['s2.coreExposure.dpr2.framesCoveredPct'];
assert.ok(covered > 30 && covered < 40, `one conversion per three moves covers about a third of the frames (${covered})`);
assert.equal(s2.metrics['s2.cyan.dpr2.inputToDrawP50Ms'], 10);
assert.equal(s2.metrics['s2.cyan.dpr2.framesCoveredPct'], 100);

const s4 = await run('s4');
assert.equal(s4.metrics['s4.dpr2.fitTo2x.transformAppliedMs'], 13);
assert.equal(s4.metrics['s4.dpr2.fitTo2x.textureRefinedAtMs'], 400);
assert.equal(s4.metrics['s4.dpr2.wheel.transformAppliedMs'], 1);
assert.equal(s4.metrics['s4.dpr2.pan.moveToFrameP95Ms'], 9);

const s7 = await run('s7');
assert.ok(Number.isFinite(s7.metrics['s7.coldUnanalysed.firstPixelsMs']));
assert.ok(Number.isFinite(s7.metrics['s7.warm1Back.firstDisplayPositiveMs']));
assert.ok(Number.isFinite(s7.metrics['s7.coldAnalysed.readyMs']));

console.log('webkit: Safari S1, S2, S4 and S7 run on a scripted WebDriver session with WebKit long-task proxies');
