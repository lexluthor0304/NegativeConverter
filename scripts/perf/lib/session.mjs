// One Chrome per scenario repetition: CDP wiring, the probe, trusted input,
// worker auto-attach, memory sampling, the hang watchdog and the run guards.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CdpConnection } from './cdp.mjs';
import { launchChrome, WINDOW } from './chrome.mjs';
import { HangWatchdog, collectHangDump, hangThresholdMs } from './hang.mjs';
import { MemorySampler, FootprintReader } from './memory.mjs';
import { evaluateRunGuards, readSwapUsage, freeDiskBytes } from './guards.mjs';
import { runPaced, HZ_60_MS, linearPath } from './pacing.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const PROBE_SOURCE = readFileSync(join(here, '..', 'probe.js'), 'utf8');
export const WORKER_PROBE_SOURCE = readFileSync(join(here, '..', 'probe-worker.js'), 'utf8');
export const STAGE_CONTROL_SOURCE = readFileSync(join(here, '..', 'stage-control.js'), 'utf8');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class ScenarioAbort extends Error {
  constructor(status, detail) {
    super(`${status}: ${detail}`);
    this.name = 'ScenarioAbort';
    this.status = status;
    this.detail = detail;
  }
}

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  Escape: { code: 'Escape', keyCode: 27 }
};

export class ChromeSession {
  constructor(options, deps = {}) {
    this.options = options;
    this.deps = deps;
    this.events = [];
    this.workerTiming = [];
    this.workers = new Map();
    this.windows = [];
    this.status = 'ok';
    this.abortReason = null;
    this.crashed = false;
    this.pageTimeOrigin = null;
    this.hangDump = null;
    this.selfMs = 0;
    this.counters = {};
  }

  /**
   * options: { chromeBin, cdpPort, probe, headful, dpr, log, mapper, outDir, label,
   *            ceilingBytes, swapAtStart, guardDiskPath, traceRecorderFactory }
   */
  static async open(options, deps = {}) {
    const session = new ChromeSession(options, deps);
    try { await session.#start(); return session; } catch (error) { await session.close(); throw error; }
  }

  async #start() {
    const { chromeBin, cdpPort, headful, log = () => {} } = this.options;
    this.chrome = await (this.deps.launchChrome || launchChrome)({ bin: chromeBin, port: cdpPort, headful, log, fakeCamera: this.options.fakeCamera });
    this.connection = await (this.deps.connect || (url => CdpConnection.connect(url)))(this.chrome.version.webSocketDebuggerUrl);
    this.connection.onClose(() => { if (this.status === 'ok') this.#abort('crashed', 'CDP connection closed'); });
    const { targetInfos } = await this.connection.send('Target.getTargets');
    const target = targetInfos.find(info => info.type === 'page') || { targetId: (await this.connection.send('Target.createTarget', { url: 'about:blank' })).targetId };
    this.targetId = target.targetId;
    const { sessionId } = await this.connection.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    this.page = this.connection.session(sessionId);
    this.page.on('Inspector.targetCrashed', () => this.#abort('crashed', 'renderer crashed (Inspector.targetCrashed)'));
    this.connection.on('Target.detachedFromTarget', params => {
      if (params.sessionId === sessionId) this.#abort('crashed', 'page target detached');
      this.workers.delete(params.sessionId);
    }, {});
    this.page.on('Page.javascriptDialogOpening', () => { this.page.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}); });
    await this.page.send('Page.enable');
    await this.page.send('Runtime.enable');
    await this.page.send('Performance.enable', { timeDomain: 'timeTicks' }).catch(() => {});
    await this.page.send('Inspector.enable').catch(() => {});
    await this.page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    if (this.options.probe) {
      // Enabled now: once the main thread is busy, Debugger.enable would queue
      // behind it, while Debugger.pause is handled on the IO thread.
      if (this.options.captureStacks) await this.page.send('Debugger.enable');
      await this.page.send('Page.addScriptToEvaluateOnNewDocument', { source: `globalThis.__ncPerfConfig = ${JSON.stringify({ keepExportChunks: Boolean(this.options.keepExportChunks) })};\n${PROBE_SOURCE}` });
      this.connection.on('Target.attachedToTarget', params => this.#onAttached(params), {});
      this.connection.on('Runtime.bindingCalled', (params, message) => this.#onBinding(params, message), {});
      await this.page.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    } else {
      await this.page.send('Page.addScriptToEvaluateOnNewDocument', { source: STAGE_CONTROL_SOURCE });
    }
    await this.setDpr(this.options.dpr || 2);
    await this.#startMemory();
    this.#startWatchdog();
  }

  async #onAttached({ sessionId, targetInfo, waitingForDebugger }) {
    if (!['worker', 'shared_worker', 'service_worker'].includes(targetInfo?.type)) {
      if (waitingForDebugger) this.connection.send('Runtime.runIfWaitingForDebugger', {}, { sessionId }).catch(() => {});
      return;
    }
    const worker = this.connection.session(sessionId);
    this.workers.set(sessionId, { session: worker, url: targetInfo.url, attachedAt: Date.now() });
    try {
      await worker.send('Runtime.enable', {}, { timeoutMs: 10_000 });
      await worker.send('Runtime.addBinding', { name: '__ncPerfWorkerEmit' }, { timeoutMs: 10_000 });
      await worker.send('Runtime.evaluate', { expression: WORKER_PROBE_SOURCE }, { timeoutMs: 10_000 });
      if (this.options.captureStacks) await worker.send('Debugger.enable', {}, { timeoutMs: 10_000 });
      await worker.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, { timeoutMs: 10_000 });
    } catch {
      // A worker that is gone already, or cannot be instrumented, must still run.
    } finally {
      worker.send('Runtime.runIfWaitingForDebugger', {}, { timeoutMs: 10_000 }).catch(() => {});
    }
  }

  #onBinding(params, message) {
    if (params.name !== '__ncPerfWorkerEmit') return;
    try {
      const record = JSON.parse(params.payload);
      const worker = this.workers.get(message.sessionId);
      this.workerTiming.push({ ...record, url: worker?.url || null, session: message.sessionId });
    } catch {}
  }

  async #startMemory() {
    if (this.deps.startMemory) return this.deps.startMemory(this);
    this.reader = new FootprintReader();
    await this.reader.start();
    this.sampler = new MemorySampler({
      reader: this.reader,
      resolvePids: () => this.processIds(),
      onSample: sample => this.#checkGuards(sample)
    });
    this.sampler.start();
  }

  async #checkGuards(sample) {
    if (this.status !== 'ok') return;
    const swap = (await readSwapUsage()).used;
    const verdict = evaluateRunGuards({
      browserBytes: sample.totalBytes,
      ceilingBytes: this.options.ceilingBytes,
      swapUsed: swap,
      swapUsedAtStart: this.options.swapAtStart,
      freeDisk: freeDiskBytes(this.options.guardDiskPath || '.'),
      force: this.options.force, freeDiskAtStart: this.options.freeDiskAtStart
    });
    if (verdict) {
      this.lastMemorySample = sample;
      this.memoryCeiling = { detail: verdict.detail, swapGrowthMB: Number.isFinite(swap) && Number.isFinite(this.options.swapAtStart) ? Math.round((swap - this.options.swapAtStart) / 1048576) : null };
      // SIGKILL first: the machine matters more than a tidy shutdown.
      await this.#abort('memory-ceiling', verdict.detail);
      this.memoryCeiling.browserGoneMs = Date.now() - sample.t;
    }
  }

  #startWatchdog() {
    if (!this.options.probe && !this.options.watchdogWithoutProbe) return;
    this.watchdog = new HangWatchdog({
      thresholdMs: this.options.hangThresholdMs || hangThresholdMs(),
      ping: () => this.page.send('Runtime.evaluate', { expression: '1', returnByValue: true }, { timeoutMs: 0 }),
      onHang: info => this.#onHang(info)
    });
    this.watchdog.start();
  }

  async #onHang(info) {
    if (this.status !== 'ok') return;
    this.status = 'hang';
    this.abortReason = `page silent for ${Math.round(info.silentMs / 1000)} s`;
    this.options.log?.(`hang detected (${this.abortReason}); collecting a dump`);
    try {
      const sessions = [{ kind: 'page', session: this.page, url: 'page' },
        ...[...this.workers.entries()].map(([id, worker]) => {
          const pending = new Set();
          const records = this.workerTiming.filter(record => record.session === id);
          for (const record of records) {
            if (record.ph === 'start') pending.add(record.id);
            else if (record.ph === 'reply') pending.delete(record.id);
          }
          return { kind: 'worker', id, session: worker.session, url: worker.url, busy: records.length ? pending.size > 0 : null };
        })];
      this.hangDump = await collectHangDump({
        connection: this.connection, sessions, mapper: this.options.mapper, traceRecorder: this.traceRecorder || null,
        processIds: await this.processIds().catch(() => ({})), dir: this.options.outDir, label: this.options.label, info,
        captureStacks: Boolean(this.options.captureStacks)
      });
    } catch (error) {
      this.hangDump = { error: String(error.message || error) };
    }
    await this.chrome.kill();
  }

  #abort(status, detail) {
    if (this.status !== 'ok') return Promise.resolve();
    this.lastMemorySample ||= this.sampler?.samples.at(-1) || null;
    this.status = status;
    this.abortReason = detail;
    this.options.log?.(`aborting: ${status} — ${detail}`);
    return this.chrome ? this.chrome.kill() : Promise.resolve();
  }

  /** Throw when the session was aborted (hang, crash, memory ceiling). */
  check() {
    if (this.status !== 'ok') throw new ScenarioAbort(this.status, this.abortReason);
  }

  async processIds() {
    const { processInfo = [] } = await this.connection.send('SystemInfo.getProcessInfo', {}, { timeoutMs: 10_000 });
    const groups = { renderer: [], gpu: [], other: [] };
    for (const info of processInfo) {
      if (info.type === 'renderer') groups.renderer.push(info.id);
      else if (info.type === 'GPU' || info.type === 'gpu-process' || info.type === 'gpu') groups.gpu.push(info.id);
      else groups.other.push(info.id);
    }
    this.lastProcessInfo = processInfo;
    return groups;
  }

  async cpuTimes() {
    const { processInfo = [] } = await this.connection.send('SystemInfo.getProcessInfo', {}, { timeoutMs: 10_000 });
    return processInfo.reduce((total, info) => total + (info.cpuTime || 0), 0);
  }

  async setDpr(dpr) {
    this.dpr = dpr;
    await this.page.send('Emulation.setDeviceMetricsOverride', { width: WINDOW.width, height: WINDOW.height, deviceScaleFactor: dpr, mobile: false });
  }

  async evaluate(expression, options) {
    this.check();
    try {
      return await this.page.evaluate(expression, options);
    } catch (error) {
      this.check();
      throw error;
    }
  }

  /** Navigate and wait until the Studio is interactive; returns in-page ms since navigation start. */
  async boot(url, { timeoutMs = 120_000 } = {}) {
    this.check();
    // Poll only once the new document exists; the old one would answer at once.
    const loaded = this.page.waitFor('Page.domContentEventFired', { timeoutMs });
    await this.page.send('Page.navigate', { url });
    await loaded;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      this.check();
      try {
        const bootMs = await this.page.evaluate(`new Promise(resolve => {
          const ready = () => document.readyState !== 'loading' && document.getElementById('studioImportAutoCrop') && document.body && document.body.classList.contains('studio');
          const poll = () => ready() ? resolve(performance.now()) : requestAnimationFrame(poll);
          poll();
        })`, { timeoutMs: Math.max(1000, deadline - Date.now()) });
        this.pageTimeOrigin = await this.page.evaluate('performance.timeOrigin');
        return bootMs;
      } catch (error) {
        if (/Execution context was destroyed|Cannot find context|Inspected target navigated/.test(error.message)) { await sleep(100); continue; }
        throw error;
      }
    }
    throw new ScenarioAbort('timeout', `Studio did not boot within ${timeoutMs} ms`);
  }

  async installDialogAutoAccept() {
    await this.evaluate(`(() => {
      if (window.__ncPerfDialogs) return true;
      window.__ncPerfDialogs = [];
      setInterval(() => {
        const button = document.querySelector('[data-app-dialog-confirm]');
        if (!button) return;
        window.__ncPerfDialogs.push((document.querySelector('[data-app-dialog-message]') || {}).textContent || '');
        button.click();
      }, 150);
      return true;
    })()`);
  }

  async gpuRenderer() {
    return this.evaluate(`(() => {
      const gl = document.createElement('canvas').getContext('webgl');
      if (!gl) return null;
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return renderer;
    })()`);
  }

  /** Pull probe events into Node (sorted by time). */
  async drain() {
    if (!this.options.probe || this.status !== 'ok') return 0;
    const out = await this.evaluate('globalThis.__ncPerf ? globalThis.__ncPerf.drain() : null', { timeoutMs: 60_000 });
    if (!out) return 0;
    for (const event of out.events) this.events.push(event);
    this.events.sort((a, b) => a.t - b.t);
    this.selfMs = out.selfMs;
    this.counters = out.counters;
    this.observed = out.observed;
    return out.events.length;
  }

  async now() {
    return this.evaluate('performance.now()');
  }

  async beginWindow(label) {
    this.currentWindow = label;
    this.windowStartMetrics = await this.performanceMetrics();
    if (!this.options.probe) return this.now();
    this.windowStartSelfMs = await this.evaluate('globalThis.__ncPerf ? globalThis.__ncPerf.selfMs() : 0');
    return this.evaluate(`globalThis.__ncPerf.beginWindow(${JSON.stringify(label)})`);
  }

  /** Ends the window: frames, timer ticks, main busy % (CDP) and probe self time. */
  async endWindow() {
    this.currentWindow = null;
    const window = this.options.probe ? await this.evaluate('globalThis.__ncPerf.endWindow()') : { start: null, end: await this.now(), frames: [], ticks: [] };
    const metrics = await this.performanceMetrics();
    const before = this.windowStartMetrics || {};
    const wallS = (metrics.Timestamp ?? 0) - (before.Timestamp ?? 0);
    const taskS = (metrics.TaskDuration ?? 0) - (before.TaskDuration ?? 0);
    window.mainBusyPct = wallS > 0 ? Math.round((taskS / wallS) * 1000) / 10 : null;
    window.scriptMs = Math.round(((metrics.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) * 1000);
    window.taskMs = Math.round(taskS * 1000);
    if (this.options.probe) {
      const selfMs = await this.evaluate('globalThis.__ncPerf.selfMs()');
      window.probeSelfMs = Math.round((selfMs - (this.windowStartSelfMs || 0)) * 10) / 10;
      window.probeSelfPct = window.taskMs > 0 ? Math.round((window.probeSelfMs / window.taskMs) * 1000) / 10 : null;
    }
    this.windows.push(window);
    await this.drain();
    return window;
  }

  async performanceMetrics() {
    try {
      const { metrics = [] } = await this.page.send('Performance.getMetrics', {}, { timeoutMs: 30_000 });
      return Object.fromEntries(metrics.map(metric => [metric.name, metric.value]));
    } catch {
      return {};
    }
  }

  /** Poll `expression` until truthy; drains probe events periodically. Returns ms waited. */
  async waitFor(description, expression, { timeoutMs = 120_000, pollMs = 100, drainEveryMs = 2000 } = {}) {
    const started = Date.now();
    let lastDrain = started;
    while (Date.now() - started < timeoutMs) {
      this.check();
      if (await this.evaluate(expression, { timeoutMs: Math.max(5000, timeoutMs) })) return Date.now() - started;
      if (Date.now() - lastDrain > drainEveryMs) { await this.drain(); lastDrain = Date.now(); }
      await sleep(pollMs);
    }
    throw new ScenarioAbort('timeout', `timed out after ${timeoutMs} ms waiting for ${description}`);
  }

  async waitForReady(options = {}) {
    return this.waitFor('studio ready', `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy && !document.querySelector('.loading-overlay.visible')`, options);
  }

  async setFiles(paths, selector = '#fileInput') {
    this.check();
    const { root } = await this.page.send('DOM.getDocument', { depth: 1 });
    const { nodeId } = await this.page.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`${selector} not found`);
    await this.page.send('DOM.setFileInputFiles', { files: paths, nodeId });
  }

  // ---- trusted input ----
  mouse(type, x, y, { buttons = 0, button = 'none', clickCount = 0, modifiers = 0, deltaY = 0 } = {}) {
    return this.page.send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount, modifiers, deltaX: 0, deltaY }, { timeoutMs: 60_000 });
  }

  async click(x, y, { clickCount = 1, modifiers = 0 } = {}) {
    await this.mouse('mouseMoved', x, y);
    await this.mouse('mousePressed', x, y, { button: 'left', buttons: 1, clickCount, modifiers });
    await this.mouse('mouseReleased', x, y, { button: 'left', buttons: 0, clickCount, modifiers });
  }

  async dblclick(x, y) {
    await this.click(x, y, { clickCount: 1 });
    await this.click(x, y, { clickCount: 2 });
  }

  /**
   * Press at `from`, move along a straight line in `steps` paced moves at
   * 60 Hz, release. Returns { pressT, releaseT } in Node time plus the moves.
   */
  async drag({ from, to, steps = 180, modifiers = 0, releaseAtEnd = true }) {
    await this.mouse('mouseMoved', from.x, from.y);
    await this.mouse('mousePressed', from.x, from.y, { button: 'left', buttons: 1, clickCount: 1, modifiers });
    const path = linearPath({ x0: from.x, y0: from.y, x1: to.x, y1: to.y, count: steps });
    const paced = await runPaced(steps, i => this.mouse('mouseMoved', path[i].x, path[i].y, { button: 'left', buttons: 1, modifiers }), { periodMs: HZ_60_MS });
    if (releaseAtEnd) await this.mouse('mouseReleased', to.x, to.y, { button: 'left', buttons: 0, clickCount: 1, modifiers });
    return { lateness: paced.lateness };
  }

  async wheel(x, y, deltaY, { count = 1 } = {}) {
    await runPaced(count, () => this.mouse('mouseWheel', x, y, { deltaY }), { periodMs: HZ_60_MS });
  }

  async key(key, { modifiers = 0 } = {}) {
    const spec = KEYS[key] || { code: key, keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0 };
    await this.page.send('Input.dispatchKeyEvent', { type: spec.text ? 'keyDown' : 'rawKeyDown', key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode, text: spec.text, unmodifiedText: spec.text, modifiers });
    await this.page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode, modifiers });
  }

  /** Make a control visible (tab, <details>, collapsed section), outside any measured window. */
  async reveal(id) {
    const rect = await this.evaluate(`(async () => {
      const element = document.getElementById(${JSON.stringify(id)});
      if (!element) return null;
      const pane = element.closest('.studio-pane');
      if (pane && pane.hidden) document.getElementById('studioTab-' + pane.id.replace('studioPane-', ''))?.click();
      for (let details = element.closest('details'); details; details = details.parentElement && details.parentElement.closest('details')) details.open = true;
      const collapsed = element.closest('.section-content.collapsed');
      if (collapsed) (collapsed.parentElement.querySelector('.section-header, .section-title') || {}).click?.();
      window.dispatchEvent(new Event('resize'));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      element.scrollIntoView({ block: 'center', inline: 'center' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, visible: r.width > 0 && r.height > 0 && r.y >= 0 && r.bottom <= innerHeight };
    })()`);
    if (!rect || !rect.visible) throw new ScenarioAbort('ui', `#${id} could not be revealed: ${JSON.stringify(rect)}`);
    return rect;
  }

  async rect(selector) {
    return this.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  }

  async heapAfterGcMB() {
    try {
      await this.page.send('HeapProfiler.collectGarbage', {}, { timeoutMs: 60_000 });
      const { usedSize } = await this.page.send('Runtime.getHeapUsage', {}, { timeoutMs: 30_000 });
      return Math.round((usedSize / 1024 / 1024) * 10) / 10;
    } catch {
      return null;
    }
  }

  memoryMark() {
    return this.sampler?.mark() ?? 0;
  }

  memorySummary(from = 0) {
    return this.sampler?.summary(from) ?? null;
  }

  async close() {
    this.watchdog?.stop();
    this.sampler?.stop();
    this.reader?.stop();
    try { this.connection?.close(); } catch {}
    await this.chrome?.kill();
  }
}
