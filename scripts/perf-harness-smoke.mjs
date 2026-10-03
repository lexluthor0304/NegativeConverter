// Fast in-browser checks for the benchmark harness (#230), so the smoke run
// exercises what unit tests cannot:
// - the ?perf=1 app hook emits User Timing measures for real trace sites,
//   and nothing without the flag;
// - the in-page probe (scripts/perf/probe.js) records the uploads, draws,
//   conversion requests/results and input the benchmark metrics need, and
//   an upload of a conversion result is recognised as the positive;
// - a small synthetic 12-bit CFA DNG from scripts/perf/fixtures.mjs decodes
//   through the app's LibRaw at its full size.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSyntheticDng, previewSizes, stubJpeg } from './perf/fixtures.mjs';
import { pictures, conversionResultIndex } from './perf/lib/metrics.mjs';

const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy && !document.querySelector('.loading-overlay.visible')`;

export async function runPerfHarnessSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const probeSource = readFileSync(join(root, 'scripts', 'perf', 'probe.js'), 'utf8');
  const { result: { identifier } } = await send('Page.addScriptToEvaluateOnNewDocument', { source: probeSource });
  const dir = mkdtempSync(join(tmpdir(), 'nc-perf-smoke-'));
  const importFiles = async files => {
    const doc = await send('DOM.getDocument');
    const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
    if (!input.result?.nodeId) fail('#fileInput not found');
    await send('DOM.setFileInputFiles', { files, nodeId: input.result.nodeId });
  };
  const boot = async query => {
    // The previous page may satisfy the boot condition too: wait for a new document.
    const previous = await evaluate('performance.timeOrigin');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en${query}` });
    await waitFor('perf smoke boot', `performance.timeOrigin !== ${previous} && document.readyState === 'complete' && !!document.getElementById('studioImportAutoCrop') && !!globalThis.__ncPerf`);
    await installDialogAutoAccept();
    await wait(1500);
  };
  try {
    // 1. ?perf=1: probe + app hook on a small JPEG negative.
    await boot('&perf=1');
    await evaluate(`globalThis.__ncPerf.drain(); true`);
    await importFiles([join(root, 'negative2positive', 'test-fixtures', 'negative-sample.jpg')]);
    await waitFor('perf smoke import ready', ready, 150_000);
    await wait(1500);
    const drained = await evaluate(`globalThis.__ncPerf.drain()`);
    const events = drained.events.sort((a, b) => a.t - b.t);
    const kinds = events.reduce((acc, event) => { acc[event.k] = (acc[event.k] || 0) + 1; return acc; }, {});
    const change = events.find(event => event.k === 'input' && event.type === 'change' && event.id === 'fileInput');
    const convertResults = conversionResultIndex(events);
    // The WebGL display is the norm; without WebGL the CPU canvas shows the photo.
    const pics = [...pictures(events, 'glCanvas'), ...pictures(events, 'canvas')];
    const webgl = await evaluate(`getComputedStyle(document.getElementById('glCanvas')).display !== 'none'`);
    const measures = events.filter(event => event.k === 'um' && /^nc:/.test(event.n)).map(event => event.n);
    const positives = pics.filter(pic => pic.positive && pic.res);
    const summary = { kinds, convertResults: convertResults.size, pictures: pics.length, positives: positives.length,
      matchedByHash: positives.filter(pic => pic.matchedBy === 'hash' || pic.res && pic.kind !== 'draw').length, measures: [...new Set(measures)], counters: drained.counters };
    console.log('perf harness smoke (probe):', JSON.stringify(summary));
    if (!change) fail('probe did not record the file input change: ' + JSON.stringify(summary));
    if (webgl && (!kinds['gl.upload'] || !kinds['gl.draw'])) fail('probe recorded no WebGL uploads/draws: ' + JSON.stringify(summary));
    if (!webgl && !kinds.c2d) fail('probe recorded no 2D canvas drawing: ' + JSON.stringify(summary));
    if (!convertResults.size) fail('probe recorded no hashed conversion results: ' + JSON.stringify(summary));
    if (!positives.length) fail('no displayed picture was tied to a conversion result (positive not recognised): ' + JSON.stringify(summary));
    if (!measures.includes('nc:prepareStudioPhoto') && !measures.includes('nc:processNegative')) fail('?perf=1 produced no perf-trace measures: ' + JSON.stringify(summary));
    if (!drained.counters['worker.new']) fail('probe saw no workers: ' + JSON.stringify(summary));
    const window = await evaluate(`(async () => { globalThis.__ncPerf.beginWindow('smoke'); await new Promise(r => setTimeout(r, 300)); return globalThis.__ncPerf.endWindow(); })()`);
    if (window.frames.length < 3 || window.ticks.length < 10) fail('probe window recorded no frames/ticks: ' + JSON.stringify({ frames: window.frames.length, ticks: window.ticks.length }));

    // 2. Without ?perf=1 the hook creates no User Timing entries.
    await boot('');
    await importFiles([join(root, 'negative2positive', 'test-fixtures', 'negative-sample-2.jpg')]);
    await waitFor('perf smoke import without flag', ready, 150_000);
    const entries = await evaluate(`[...performance.getEntriesByType('mark'), ...performance.getEntriesByType('measure')].filter(entry => entry.name.startsWith('nc:')).length`);
    if (entries !== 0) fail(`perf-trace User Timing entries without ?perf=1: ${entries}`);
    console.log('ok: no perf-trace entries without ?perf=1');

    // 3. A synthetic 12-bit CFA DNG (with SubIFD previews) through LibRaw.
    const dng = join(dir, 'synthetic-smoke-cfa.dng');
    writeSyntheticDng(dng, { width: 1200, height: 800, seed: 7, kind: 'color' },
      previewSizes({ width: 1200, height: 800 }).map(size => ({ ...size, jpeg: stubJpeg(size.width, size.height) })));
    await boot('&perf=1');
    await evaluate('globalThis.__ncPerf.drain(); true');
    await importFiles([dng]);
    await waitFor('synthetic DNG converted', ready, 150_000);
    const rawEvents = (await evaluate('globalThis.__ncPerf.drain()')).events;
    const opened = rawEvents.some(event => event.k === 'req' && event.cls === 'libraw' && event.fn === 'open');
    const decoded = rawEvents.find(event => event.k === 'res' && event.cls === 'libraw' && event.fn === 'imageData');
    console.log('perf harness smoke (synthetic DNG):', JSON.stringify({ opened, decoded: decoded && { w: decoded.w, h: decoded.h } }));
    if (!opened || !decoded) fail('the synthetic CFA DNG did not go through LibRaw');
    if (decoded.w !== 1200 || decoded.h !== 800) fail(`LibRaw decoded the synthetic DNG at ${decoded.w}x${decoded.h}, expected 1200x800`);
    const status = await evaluate(`document.getElementById('filmTypeDetectionStatus')?.textContent || ''`);
    console.log(`ok: synthetic CFA DNG decoded through LibRaw at 1200x800 (${status})`);

    // Current dust message classes, using a tiny echo worker in this real
    // cross-origin-isolated page. No detector/model or large fixture runs.
    const protocol = await evaluate(`(async () => {
      const url = URL.createObjectURL(new Blob(['onmessage = e => postMessage({id:e.data.id, type:e.data.type + "Result", patch:new Uint8Array(64)});'], {type:'text/javascript'}));
      const worker = new Worker(url, {name:'nc-perf-protocol-smoke'});
      try {
        globalThis.__ncPerf.drain();
        for (const [i,type] of ['stroke','plane','maskDelta','refine'].entries()) {
          await new Promise((resolve,reject) => {
            const timer = setTimeout(() => reject(new Error('protocol smoke timeout')), 5000);
            worker.onmessage = () => { clearTimeout(timer); resolve(); };
            worker.postMessage({id:10000+i,type,data:new Uint8Array(128)});
          });
        }
        return globalThis.__ncPerf.drain().events.filter(e => (e.k === 'req' || e.k === 'res') && e.id >= 10000);
      } finally { worker.terminate(); URL.revokeObjectURL(url); }
    })()`);
    const dustRequests = protocol.filter(event => event.k === 'req');
    if (dustRequests.map(event => event.cls).join(',') !== 'dust,dust,dust,refine') fail('dust protocol classes: ' + JSON.stringify(protocol));
    if (!dustRequests.slice(0, 3).every(event => event.bytes >= 128 && event.bytes < 512)) fail('dust payload sizes missing: ' + JSON.stringify(protocol));
    console.log('ok: small dust protocol messages classified and sized; refine kept separate');

    // ZIP JPEG entries call this same byte decoder after extraction in Node.
    const jpeg = await evaluate(`(async () => {
      const canvas = new OffscreenCanvas(4,3);
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#92703c'; ctx.fillRect(0,0,4,3);
      const bytes = new Uint8Array(await (await canvas.convertToBlob({type:'image/jpeg'})).arrayBuffer());
      return globalThis.__ncPerf.exports.jpegBytesSha256(btoa(String.fromCharCode(...bytes)));
    })()`);
    if (jpeg.width !== 4 || jpeg.height !== 3 || !/^[a-f0-9]{64}$/.test(jpeg.sha256)) fail('ZIP JPEG byte decoder: ' + JSON.stringify(jpeg));
    console.log('ok: ZIP JPEG byte decoder hashes actual decoded 4x3 pixels');
  } finally {
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    rmSync(dir, { recursive: true, force: true });
  }
}
