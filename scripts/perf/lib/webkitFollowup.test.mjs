import assert from 'node:assert/strict';

process.env.NC_PERF_TIME_SCALE = '0';
const { safariScenario, metricsFromSelfDriven, webkitMemory } = await import('./webkit.mjs');
const { GiB } = await import('./guards.mjs');
const { KEY } = await import('./webdriver.mjs');

function foreground(index, t = 10) {
  const ft = ['bw', 'positive', 'color', 'bw'][index];
  return [
    { k: 'req', t, wid: 1, id: t, cls: 'convert', ft, pe: 'legacy', cache: true },
    { k: 'res', t: t + 10, rt: t, wid: 1, id: t, cls: 'convert', hash: `photo${index}`, cache: true, w: 4, h: 3 },
    { k: 'gl.upload', t: t + 11, c: 'glCanvas', w: 4, h: 3, hash: `photo${index}` },
    { k: 'gl.draw', t: t + 12, c: 'glCanvas', sig: `photo${index}-${t}` },
    { k: 'vis', t: t + 13, ready: true, busy: false, ov: false },
    { k: 'req', t: t + 14, wid: 2, id: t + 14, cls: 'convert', ft: 'color', cache: false },
    { k: 'res', t: t + 15, rt: t + 14, wid: 2, id: t + 14, cls: 'convert', hash: 'background' }
  ];
}

class TinyWebDriver {
  constructor({ abortSwitch = 0 } = {}) {
    this.t = 100; this.pending = []; this.current = 0; this.focused = 0;
    this.switches = 0; this.abortSwitch = abortSwitch; this.visits = [];
  }
  show(index) {
    this.current = index; this.visits.push(index);
    this.pending.push({ k: 'mut', t: this.t + 1, what: 'filename', v: `r${index}.dng` }, ...foreground(index, this.t + 2));
    this.t += 100;
  }
  async navigate() {}
  async executeAsync(script, [names]) {
    this.pending.push({ k: 'input', t: this.t++, type: 'change', id: 'fileInput' });
    this.show(0); this.t += 3000;
    return names;
  }
  async execute(script, args = []) {
    this.t += 2;
    if (script.includes('drain()')) { const events = this.pending; this.pending = []; return { events }; }
    if (script.includes('beginWindow')) { this.start = this.t; return this.t; }
    if (script.includes('endWindow()')) return { start: this.start, end: this.t, frames: [], ticks: [this.start, this.t] };
    if (script.includes('snapshot()')) return { filename: `r${this.current}.dng`, filmType: 'color' };
    if (script.includes('.file-list-name\')].map')) return [0, 1, 2, 3];
    if (script.includes('.focus()')) { this.focused = args[0]; return true; }
    if (script.includes('.click()') && script.includes('.file-list-name')) this.show(args[0]);
    if (script === 'return performance.now()') return this.t;
    if (script === 'return devicePixelRatio') return 2;
    return true;
  }
  async keys(keys) {
    if (++this.switches === this.abortSwitch) throw new Error('later switch aborted');
    for (const key of keys) {
      if (key === KEY.ArrowRight) this.focused++;
      if (key === KEY.ArrowLeft) this.focused--;
      if (key === KEY.Enter) {
        this.pending.push({ k: 'input', t: this.t++, type: 'keydown', key: 'Enter' });
        this.show(this.focused);
      }
    }
  }
  async drag() {}
  async wheel() {}
  async click() {}
}

async function safari(wd) {
  const metrics = {};
  await safariScenario('s7', { wd, origin: 'http://tiny.invalid', roll: [0, 1, 2, 3].map(i => ({ name: `r${i}.dng` })),
    record: (key, value) => { if (value != null) metrics[key] = value; }, note() {} });
  return metrics;
}

const cases = {
  async partial() {
    const metrics = {};
    await assert.rejects(safariScenario('s7', { wd: new TinyWebDriver({ abortSwitch: 2 }), origin: 'http://tiny.invalid',
      roll: [0, 1, 2, 3].map(i => ({ name: `r${i}.dng` })), record: (key, value) => { if (value != null) metrics[key] = value; }, note() {} }), /later switch aborted/);
    assert.ok(Number.isFinite(metrics['s7.coldUnanalysed.firstPixelsMs']), 'a completed Safari switch must survive the following abort');
    assert.equal(metrics['s7.warm1Back.firstPixelsMs'], undefined, 'the failed switch must not gain a measurement');
  },
  async safariRoutes() {
    const wd = new TinyWebDriver();
    const metrics = await safari(wd);
    assert.equal(metrics['s7.photo0.route'], 'bw', 'the later background request cannot replace the foreground route');
    assert.equal(metrics['s7.photo1.route'], 'positive-legacy');
    assert.equal(metrics['s7.photo2.filmType'], 'color');
    assert.equal(metrics['s7.photo3.route'], 'bw', 'unvisited roll photos get metadata after the measured switches');
    assert.deepEqual(wd.visits.slice(0, 5), [0, 1, 0, 2, 0], 'route visits must not warm the measured switches');
    for (const id of ['s1', 's2', 's4']) {
      const recorded = {};
      await safariScenario(id, { wd: new TinyWebDriver(), origin: 'http://tiny.invalid', fixture: { name: 'r0.dng', width: 4 },
        record: (key, value) => { recorded[key] = value; }, note() {} });
      assert.equal(recorded[`${id}.photo0.route`], 'bw', `${id} Safari import metadata`);
    }
  },
  async tauriRoutes() {
    for (const scenario of ['s1', 's2', 's7', 's9', 's9-parallel']) {
      const recorded = {};
      const report = { scenario, snapshot: { filmType: 'color' }, parts: [
        { name: 'import', before: 0, events: foreground(0), window: { start: 0, end: 100, frames: [], ticks: [] } },
        { name: 'switch:warm1Back', cls: 'warm1Back', index: 1, target: 'r1.dng', keyT: 100,
          events: foreground(1, 110), window: { start: 100, end: 200, frames: [], ticks: [] } }
      ] };
      const metrics = metricsFromSelfDriven(report, { record: (key, value) => { recorded[key] = value; } });
      assert.equal(metrics[`${scenario}.photo0.route`], 'bw', `${scenario} must map the displayed foreground request`);
      assert.equal(recorded[`${scenario}.photo0.filmType`], 'bw');
      assert.equal(metrics[`${scenario}.photo1.route`], 'positive-legacy');
    }
  },
  async scope() {
    // Fake PIDs above the OS range cannot affect a real process during cleanup.
    const content = 900000011, oldGpu = 900000012, unrelatedGpu = 900000014, unrelatedContent = 900000015;
    let list = [{ pid: oldGpu, command: 'com.apple.WebKit.GPU' }];
    const reads = [], killed = [];
    const kill = process.kill;
    process.kill = pid => { killed.push(pid); return true; };
    const memory = await webkitMemory({ label: 'unrelated-gpu', port: 1, outDir: '.', args: {}, swapAtStart: 0, start: false,
      list: async () => list, connected: async () => [content], readSwap: async () => ({ used: 0 }), readDisk: () => 100 * GiB,
      reader: { start: async () => {}, stop() {}, read: async pids => { reads.push(...pids); return {}; } } });
    try {
      list = [...list, { pid: content, command: 'com.apple.WebKit.WebContent' },
        { pid: unrelatedGpu, command: 'com.apple.WebKit.GPU' }, { pid: unrelatedContent, command: 'com.apple.WebKit.WebContent' }];
      await memory.sampler.tick();
      assert.ok(!reads.includes(unrelatedGpu), 'the globally new GPU must never enter the owned sampling/cleanup set');
      assert.ok(!reads.includes(unrelatedContent), 'the disconnected new WebContent must never enter the owned set');
      assert.equal(memory.verdict?.reason, 'error', 'unproven GPU ownership must fail closed');
      assert.match(memory.verdict.detail, /GPU ownership/);
    } finally { memory.stop(); process.kill = kill; }
    assert.ok(killed.includes(content), 'the positively attributed renderer is cleaned on refusal');
    assert.ok(!killed.includes(unrelatedGpu) && !killed.includes(unrelatedContent) && !killed.includes(oldGpu),
      'abort and normal cleanup must preserve all unrelated/shared PIDs');
    const { webkitProcessScope } = await import('./memory.mjs');
    const disconnected = webkitProcessScope({ before: [], port: 1,
      list: async () => [{ pid: unrelatedContent, command: 'com.apple.WebKit.WebContent' }], connected: async () => [] });
    assert.deepEqual(await disconnected.resolve(), { renderer: [], gpu: [], other: [] });
    assert.throws(() => disconnected.assert(), /attribute/);
    let rendererList = [{ pid: oldGpu, command: 'com.apple.WebKit.GPU' }];
    const rendererOnly = await webkitMemory({ label: 'shared-gpu', port: 1, outDir: '.', args: {}, swapAtStart: 0, start: false,
      list: async () => rendererList, connected: async () => [content],
      readSwap: async () => ({ used: 0 }), readDisk: () => 100 * GiB,
      reader: { start: async () => {}, stop() {}, read: async () => ({ [content]: { footprint: 8 * 1024 ** 2 } }) } });
    try {
      rendererList = [...rendererList, { pid: content, command: 'com.apple.WebKit.WebContent' }];
      await rendererOnly.sampler.tick();
      rendererOnly.assertScope();
      assert.equal(rendererOnly.summary().rendererPeakMB, 8);
      assert.equal(rendererOnly.summary().gpuPeakMB, null, 'unmeasured shared GPU must not be reported as zero footprint');
    } finally { rendererOnly.stop(); }
  }
};

for (const name of process.argv[2] ? [process.argv[2]] : Object.keys(cases)) {
  await cases[name]();
  console.log(`webkit followup: ${name} passed (scripted callers, no native measurement)`);
}
