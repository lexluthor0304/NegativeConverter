import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { metricsFromSelfDriven } from './lib/webkit.mjs';

const source = readFileSync(process.env.NC_PERF_SELFDRIVE_PROBE_PATH || new URL('./probe.js', import.meta.url), 'utf8');

async function drive(scenario, abortIndex = -1) {
  let clock = 0, current = 0, report, world, worker, frames = 0;
  const names = [0, 1, 2, 3].map(index => `r${index}.dng`), visits = [];
  const type = ['bw', 'positive', 'color', 'bw'];
  class TinyBlob { constructor() { this.size = 1; this.type = ''; } }
  class TinyFile extends TinyBlob { constructor(parts, name) { super(); this.name = name; } }
  class TinyTransfer {
    constructor() { this.files = []; this.items = { add: file => this.files.push(file) }; }
  }
  class TinyWorker {
    constructor() { this.listeners = []; }
    postMessage() {}
    addEventListener(type, callback) { if (type === 'message') this.listeners.push(callback); }
  }
  const rect = { x: 0, y: 0, width: 4, height: 3, toJSON() { return this; } };
  const filename = { get textContent() { return names[current]; } };
  const tiles = names.map((name, index) => ({ dataset: { index: String(index) }, click() {
    if (index === abortIndex) throw new Error('metadata visit failed');
    current = index; visits.push(index);
    worker.postMessage({ type: 'prepare', id: ++clock, cacheInput: true, settings: { filmType: type[index], positiveEngine: 'legacy' } });
    worker.postMessage({ type: 'convert', id: ++clock, settings: { filmType: 'color' } });
  } }));
  const menu = { classList: { contains: () => true } };
  const exportButton = { click() {
    void (async () => {
      const id = await world.__TAURI_INTERNALS__.invoke('begin_export_write');
      await world.__TAURI_INTERNALS__.invoke('finish_export_write', { id });
    })();
  } };
  const input = { dispatchEvent() { tiles[0].click(); } };
  const elements = { fileInput: input, studioImportAutoCrop: {}, studioFilename: filename, exportDropdownMenu: menu,
    exportSingleBtn: exportButton, exportZipBtn: exportButton };
  const document = {
    readyState: 'complete', body: { classList: { contains: () => true }, dataset: {} },
    getElementById: id => elements[id] || null,
    querySelector: selector => {
      if (selector.includes('.file-list-name')) {
        const index = /data-index="(\d+)"/.exec(selector)?.[1];
        return index === undefined ? tiles[current] : tiles[Number(index)];
      }
      if (selector === '.film-type-btn.active') return { dataset: { type: 'color' } };
      if (selector.includes('.format-btn') || selector.includes('.bitdepth-btn')) return { click() {} };
      return null;
    },
    querySelectorAll: selector => selector === '.file-list-settings-badge' || selector === '.file-list-item' ? names.map(() => ({ querySelector: () => null })) : [],
    addEventListener() {}
  };
  world = {
    performance: { now: () => ++clock, getEntriesByType: () => [] }, navigator: { userAgent: 'scripted WKWebView' },
    devicePixelRatio: 1, Worker: TinyWorker, Blob: TinyBlob, File: TinyFile, DataTransfer: TinyTransfer,
    document, location: { origin: 'http://tiny.invalid', search: '' }, URLSearchParams, Event: class {},
    setInterval: () => 1, clearInterval() {},
    setTimeout: (callback, ms) => { clock += ms; queueMicrotask(callback); return 1; },
    requestAnimationFrame: callback => { if (++frames < 1000) queueMicrotask(() => callback(++clock)); },
    getComputedStyle: () => ({ display: 'block', opacity: '1' }), localStorage: { setItem() {} },
    addEventListener() {}, __TAURI_INTERNALS__: { invoke: async cmd => cmd === 'begin_export_write' ? 'fake-write' : undefined },
    fetch: async (url, options) => {
      if (options?.method === 'POST') report = JSON.parse(options.body);
      return { ok: true, blob: async () => new TinyBlob() };
    }
  };
  runInNewContext(source, world);
  worker = new world.Worker('/conversionWorker.js');
  const exports = scenario.startsWith('s9') ? [{ id: 'single.dng.imported', format: 'dng', bitDepth: 16 }] : [];
  await world.__ncPerf.selfDrive({ scenario, fixtures: names, sliders: [], exports });
  return { report, visits, window: world.__ncPerf.dump().window, metrics: metricsFromSelfDriven(report) };
}

for (const id of ['s7', 's9', 's9-parallel']) {
  const result = await drive(id);
  assert.equal(result.report.error, undefined);
  for (const index of [0, 1, 2, 3]) {
    assert.equal(result.metrics[`${id}.photo${index}.filmType`], ['bw', 'positive', 'color', 'bw'][index]);
    assert.equal(result.metrics[`${id}.photo${index}.route`], ['bw', 'positive-legacy', 'color', 'bw'][index]);
  }
  assert.equal(result.report.parts[0].snapshot.filename, 'r0.dng', 'metadata snapshots belong to their own photo');
  if (id === 's7') {
    assert.deepEqual(result.visits.slice(0, 5), [0, 1, 0, 2, 0]);
    assert.equal(result.report.parts.at(-1).name, 'route:3');
    assert.ok(result.report.parts.at(-1).keyT > result.report.parts.at(-2).window.end);
  } else {
    const exportPart = result.report.parts.find(part => part.name.startsWith('export:'));
    assert.ok(result.report.parts.filter(part => part.name.startsWith('route:')).every(part => part.keyT > exportPart.window.end),
      'metadata visits must follow all export windows');
    assert.ok(Number.isFinite(result.metrics['s9.single.dng.imported.desktopWriteMs']), 'the native-write mapper still sees its fake completed write');
  }
}
const aborted = await drive('s7', 3);
assert.match(aborted.report.error, /metadata visit failed/);
assert.equal(aborted.metrics['s7.photo0.route'], 'bw', 'completed request metadata survives a later self-drive rejection');
assert.equal(aborted.metrics['s7.photo3.route'], undefined);
assert.equal(aborted.window, null, 'a rejected metadata visit closes its measurement window');
console.log('probe self-drive routes: actual probe/mapper callers, post-window visits and retained pre-error metadata (no native measurement)');
