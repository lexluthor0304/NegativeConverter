// Cross-origin isolation (#264 Part A) in a real browser. The Vite dev server
// sends COOP same-origin + COEP require-corp on every response
// (scripts/cross-origin-isolation.mjs), so the whole smoke run is isolated;
// this step checks what that means:
//
// 1. Isolated page: `crossOriginIsolated` and SharedArrayBuffer in the page,
//    and in every worker: the app's own report (window.__ncIsolation.report()
//    spawns one of each and asks it; LibRaw's is checked through its script's
//    COEP header, or answered from inside a threaded build). With
//    ISOLATION_CDP_WORKERS=1, CDP also evaluates `self.crossOriginIsolated` in
//    every worker target that starts during the step, nested ones included.
// 2. Lens correction loads its bundled lensfun profiles under COEP, the
//    GitHub star count's CORS fetch is not blocked (rendered unless offline or
//    rate limited), Vercel Analytics' cross-origin debug script is not
//    injected in dev, and no request of this step is blocked by COEP, CORP or
//    COOP (the Audits domain's BlockedByResponse issues and blocked network
//    loads; smoke-test.mjs also watches the issues for the whole run).
// 3. A generated CFA DNG (LibRaw) is imported and exported as 8- and 16-bit
//    PNG on the isolated page and again on a page whose document the step
//    serves without COOP/COEP (CDP Fetch): not isolated, every worker still
//    starts, and the exports are byte-identical, so shared planes and threads
//    change no pixel. The shared-plane hash check never fires.
//
// With a threaded libraw-wasm installed (LibRaw.features.threads, #264 Part
// D), the LibRaw entry reports its threads from inside its worker and its
// pthread workers must be isolated too. Opt-in, real files (never in the
// repo): ISOLATION_RAW_TIMING=/abs/a.dng:/abs/b.nef times loadRawFile on
// each (median of 3, 16-bit full size) with the installed decoder build;
// ISOLATION_IMPORT_PROFILE=/abs/a.dng imports each file into a fresh page
// with shared planes and again with ?sharedPlanes=0 and reports the page
// thread's time in whole-buffer copies: slice and structured clones of 1 MB
// or more (#264: at 60 MP no copy task over 10 ms, 20 ms in all).
import { mkdtempSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { writeSyntheticDng } from './perf/fixtures.mjs';

const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy && !document.body.dataset.studioDetecting && !document.querySelector('.loading-overlay.visible')`;

const CAPTURE = `(() => {
  window.showSaveFilePicker = undefined;
  window.__isolationDownloads = [];
  const pending = new Set();
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = url => { if (!pending.has(url)) revoke(url); };
  HTMLAnchorElement.prototype.click = function () {
    if (!this.download || !this.href.startsWith('blob:')) return;
    const href = this.href, name = this.download;
    pending.add(href);
    window.__isolationDownloads.push(fetch(href).then(r => r.arrayBuffer()).then(async bytes => {
      pending.delete(href); revoke(href);
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
      return { name, size: bytes.byteLength, sha256: digest };
    }));
  };
})()`;

// The app's isolation report, bounded so a stuck probe fails the step instead
// of the whole CDP command.
const REPORT = `Promise.race([window.__ncIsolation.report(),
  new Promise((resolve) => setTimeout(() => resolve({ workers: { report: { error: 'timed out' } }, allIsolated: false }), 150000))])`;

// ORT's output at one thread and at the isolated worker's default, each in a
// module worker of its own (ORT fixes its thread count per realm).
const ORT_THREADS_PROBE = `(async () => {
  const harness = location.origin + '/src/app/inferenceThreads.harness.mjs';
  const run = (threads) => new Promise((resolve) => {
    const code = 'import(' + JSON.stringify(harness) + ').then(m => m.runInferenceThreadProbe({ threads: ' + threads + ' }))'
      + '.then(r => postMessage(r), e => postMessage({ error: String((e && e.stack) || e) }));';
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    const worker = new Worker(url, { type: 'module' });
    const timer = setTimeout(() => { worker.terminate(); resolve({ error: threads + ' thread(s): no answer in 90 s' }); }, 90000);
    worker.onmessage = ({ data }) => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); resolve(data); };
    worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); resolve({ error: event.message || 'worker error' }); };
  });
  const { compareInferenceProbes } = await import(harness);
  const { inferenceThreadCount } = await import(location.origin + '/src/app/inferenceRuntime.js');
  const defaultThreads = inferenceThreadCount({ isolated: self.crossOriginIsolated === true, worker: true });
  const one = await run(1);
  if (one.error) return { error: one.error };
  const two = await run(2);
  if (two.error) return { error: two.error };
  const many = defaultThreads > 2 ? await run(defaultThreads) : two;
  if (many.error) return { error: many.error };
  const summary = (probe) => ({ threads: probe.threads, miganMs: probe.migan.ms, semanticMs: probe.semantic.ms });
  return { cores: navigator.hardwareConcurrency, defaultThreads, one: summary(one), two: summary(two), many: summary(many),
    diff: compareInferenceProbes(one, many), diffTwo: compareInferenceProbes(one, two) };
})()`;

// The lens search's result, and the bundled lensfun assets loaded directly
// (the app falls back to jsDelivr on the web when they fail).
const LENSFUN_CHECK = `(async () => {
  const options = document.querySelectorAll('#lensResultSelect option').length;
  const status = document.getElementById('lensStatusBox')?.textContent || '';
  const bounded = (promise, label) => Promise.race([promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' did not settle in 60 s')), 60000))]);
  let local;
  try {
    const { loadLocalLensfunAssets } = await import('/src/app/lensfunLoader.js');
    const assets = await bounded(loadLocalLensfunAssets(), 'the bundled lensfun assets');
    const client = await bounded(assets.createLensfun({ moduleFactory: assets.moduleFactory, wasmUrl: assets.wasmUrl, dataUrl: assets.dataUrl }), 'createLensfun');
    local = { ok: Boolean(client), wasmUrl: String(assets.wasmUrl), dataUrl: String(assets.dataUrl) };
  } catch (error) {
    local = { ok: false, error: String((error && error.stack) || error).slice(0, 600) };
  }
  return { options, status, local };
})()`;

// The document (and only it) is served without COOP/COEP: the page is then
// not isolated, and its workers are not either, although their scripts still
// carry COEP.
const NOT_ISOLATED_MARK = 'isolation=off';

// index.html's star count (cached for 6 h in localStorage under this key).
const STAR_COUNT_API = /^https:\/\/api\.github\.com\/repos\/lexluthor0304\/NegativeConverter\/?$/;
const STAR_COUNT_CACHE_KEY = 'nc_github_stars';

// The page thread's whole-buffer copies, timed where they are made: every
// call of TypedArray/ArrayBuffer slice, postMessage (the structured clone of
// what is not transferred or shared) and structuredClone that moves 1 MB or
// more is logged with its size and duration. Installed before the page's own
// scripts (a V8 CPU profile does not attribute these builtins: its control
// below saw 0 ms of a 36 ms clone + slice). Receiving a clone is not counted.
const COPY_LOG = `(() => {
  const log = window.__ncCopyLog = [];
  const MIN_BYTES = 1 << 20;
  const copiedBytes = (message, transfer) => {
    const moved = new Set(Array.isArray(transfer) ? transfer : (transfer && transfer.transfer) || []);
    const walk = (value, depth) => {
      if (!value || typeof value !== 'object' || depth > 3) return 0;
      if (value instanceof ArrayBuffer) return moved.has(value) ? 0 : value.byteLength;
      if (ArrayBuffer.isView(value)) {
        const buffer = value.buffer;
        if (typeof SharedArrayBuffer === 'function' && buffer instanceof SharedArrayBuffer) return 0;
        return moved.has(buffer) ? 0 : value.byteLength;
      }
      if (typeof ImageData === 'function' && value instanceof ImageData) return walk(value.data, depth + 1);
      let bytes = 0;
      for (const key of Object.keys(value)) bytes += walk(value[key], depth + 1);
      return bytes;
    };
    return walk(message, 0);
  };
  const wrap = (owner, name, label, bytesOf) => {
    const original = owner && owner[name];
    if (typeof original !== 'function') return;
    Object.defineProperty(owner, name, { configurable: true, writable: true, value: function (...args) {
      let bytes = 0;
      try { bytes = bytesOf(this, args); } catch { bytes = 0; }
      if (!(bytes >= MIN_BYTES)) return original.apply(this, args);
      const started = performance.now();
      try { return original.apply(this, args); } finally {
        const entry = { call: label, bytes, ms: performance.now() - started };
        // Where the large ones come from.
        if (bytes >= 8 * MIN_BYTES) entry.at = String(new Error().stack || '').split('\\n').slice(2, 5).map((line) => line.trim().replace(/^at /, '').replace(/\\?[^:)]*/, '')).join(' < ');
        log.push(entry);
      }
    } });
  };
  const sliceBytes = (view, [start = 0, end = view.length]) => {
    const n = view.length;
    const s = start < 0 ? Math.max(n + start, 0) : Math.min(start, n);
    const e = end < 0 ? Math.max(n + end, 0) : Math.min(end, n);
    return Math.max(0, e - s) * view.BYTES_PER_ELEMENT;
  };
  wrap(Object.getPrototypeOf(Uint8Array.prototype), 'slice', 'slice', sliceBytes);
  wrap(ArrayBuffer.prototype, 'slice', 'slice', (buffer, [start = 0, end = buffer.byteLength]) => Math.max(0, Math.min(end, buffer.byteLength) - Math.max(0, start)));
  wrap(Worker.prototype, 'postMessage', 'postMessage', (_, [message, transfer]) => copiedBytes(message, transfer));
  wrap(MessagePort.prototype, 'postMessage', 'postMessage', (_, [message, transfer]) => copiedBytes(message, transfer));
  wrap(window, 'structuredClone', 'structuredClone', (_, [value, options]) => copiedBytes(value, options));
})()`;

// Sums the log: every copy, the longest, and the largest few.
export function summarizeCopies(log = []) {
  const round = (value) => Math.round(value * 10) / 10;
  const total = log.reduce((sum, entry) => sum + entry.ms, 0);
  const longest = log.reduce((max, entry) => Math.max(max, entry.ms), 0);
  const top = [...log].sort((a, b) => b.ms - a.ms).slice(0, 5)
    .map((entry) => ({ call: entry.call, mb: round(entry.bytes / 1048576), ms: round(entry.ms), ...(entry.at ? { at: entry.at } : {}) }));
  return { copies: log.length, copyMs: round(total), longestMs: round(longest), top };
}

export async function runIsolationSmoke({ send, sendTo, onCdpEvent, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root,
  timingFiles = (process.env.ISOLATION_RAW_TIMING || '').split(':').filter(Boolean),
  profileFiles = (process.env.ISOLATION_IMPORT_PROFILE || '').split(':').filter(Boolean),
  cdpWorkers = process.env.ISOLATION_CDP_WORKERS === '1' }) {
  const started = Date.now();
  const step = (label) => console.log(`isolation [${((Date.now() - started) / 1000).toFixed(1)} s] ${label}`);
  const dir = mkdtempSync(join(tmpdir(), 'nc-isolation-'));
  const blocked = [];
  const workerChecks = [];
  const sessions = new Map();
  // Workers that ended before they could be evaluated (a probe's LibRaw
  // instance is disposed at once): not a finding.
  const detached = new Set();
  // The GitHub star count's request at boot (a CORS fetch to api.github.com).
  const starRequests = new Map();
  const stopListening = onCdpEvent((msg) => {
    if (msg.method === 'Audits.issueAdded') {
      const issue = msg.params?.issue;
      if (issue?.code === 'BlockedByResponseIssue') blocked.push({ kind: 'issue', details: issue.details?.blockedByResponseIssueDetails });
      return;
    }
    if (!msg.sessionId && msg.method === 'Network.requestWillBeSent' && STAR_COUNT_API.test(msg.params?.request?.url || '')) {
      starRequests.set(msg.params.requestId, { url: msg.params.request.url });
      return;
    }
    if (!msg.sessionId && msg.method === 'Network.responseReceived' && starRequests.has(msg.params?.requestId)) {
      Object.assign(starRequests.get(msg.params.requestId), { status: msg.params.response?.status });
      return;
    }
    if (!msg.sessionId && msg.method === 'Network.loadingFailed' && starRequests.has(msg.params?.requestId)) {
      Object.assign(starRequests.get(msg.params.requestId), {
        failed: msg.params.errorText, blockedReason: msg.params.blockedReason, cors: msg.params.corsErrorStatus?.corsError
      });
    }
    if (msg.method === 'Network.loadingFailed' && /coep|coop|corp/i.test(msg.params?.blockedReason || '')) {
      blocked.push({ kind: 'network', reason: msg.params.blockedReason, error: msg.params.errorText });
      return;
    }
    if (msg.method === 'Target.detachedFromTarget') {
      detached.add(msg.params?.sessionId);
      return;
    }
    if (msg.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo, waitingForDebugger } = msg.params;
      sessions.set(sessionId, targetInfo);
      if (!/worker/.test(targetInfo.type)) {
        if (waitingForDebugger) void sendTo(sessionId, 'Runtime.runIfWaitingForDebugger');
        return;
      }
      // Workers are not paused (a paused worker holds up the pool start of a
      // threaded runtime); nested workers are attached as they appear. The
      // isolation is read once the worker's script has run (its policy comes
      // with its script's response): when it has set a message handler.
      workerChecks.push((async () => {
        void sendTo(sessionId, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
        if (waitingForDebugger) void sendTo(sessionId, 'Runtime.runIfWaitingForDebugger');
        const evaluated = await sendTo(sessionId, 'Runtime.evaluate', {
          expression: `(async () => {
            for (let i = 0; i < 150 && self.onmessage === null; i++) await new Promise(r => setTimeout(r, 20));
            return { isolated: self.crossOriginIsolated === true, sab: typeof SharedArrayBuffer === 'function', name: self.name || '', started: self.onmessage !== null };
          })()`,
          awaitPromise: true,
          returnByValue: true
        });
        const value = evaluated.result?.result?.value;
        if (!value && (detached.has(sessionId) || evaluated.error)) return { url: targetInfo.url, type: targetInfo.type, gone: true };
        return { url: targetInfo.url, type: targetInfo.type, ...(value || { error: JSON.stringify(evaluated.result?.exceptionDetails || 'no value') }) };
      })().catch((error) => ({ url: targetInfo.url, error: String(error?.message || error) })));
    }
  });
  const importFiles = async (paths) => {
    const doc = await send('DOM.getDocument');
    const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
    if (!input.result?.nodeId) fail('#fileInput not found');
    await send('DOM.setFileInputFiles', { files: paths, nodeId: input.result.nodeId });
  };
  const boot = async (query) => {
    const previous = await evaluate('performance.timeOrigin');
    const loaded = new Promise((resolve) => {
      const stop = onCdpEvent((msg) => { if (msg.method === 'Page.loadEventFired' && !msg.sessionId) { stop(); resolve(true); } });
      setTimeout(() => { stop(); resolve(false); }, 90_000);
    });
    const navigated = await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&debug=1${query}` });
    step(`navigated ${JSON.stringify(navigated.result || navigated.error || {})}`);
    step(`load event ${await loaded ? 'fired' : 'missing after 90 s'}`);
    await waitFor('isolation boot', `performance.timeOrigin !== ${previous} && document.readyState === 'complete' && !!document.getElementById('studioImportAutoCrop') && !!window.__ncIsolation`);
    step('booted');
    await installDialogAutoAccept();
    await wait(800);
    await evaluate(CAPTURE);
  };
  const take = async (label) => {
    await waitFor(label, `window.__isolationDownloads.length > 0`, 300_000);
    return evaluate(`window.__isolationDownloads.shift()`);
  };
  const exportPng = async (depth, label) => {
    await evaluate(`document.querySelector('.format-btn[data-format="png"]').click(); document.querySelector('.bitdepth-btn[data-bitdepth="${depth}"]').click()`);
    await wait(200);
    await evaluate(`document.getElementById('exportSingleBtn').click()`);
    const entry = await take(label);
    await waitFor('export settled', `!document.getElementById('exportSingleBtn').disabled`, 300_000);
    return entry.sha256;
  };
  // The LibRaw decode itself, through the app's loader, on the file handed to a
  // probe <input>: both planes' SHA-256 and the metadata the app keeps.
  const rawProbe = async (file) => {
    await evaluate(`(() => {
      if (document.getElementById('__isolationProbeInput')) return true;
      const input = document.createElement('input');
      input.type = 'file'; input.id = '__isolationProbeInput'; input.hidden = true;
      document.body.appendChild(input);
      return true;
    })()`);
    const doc = await send('DOM.getDocument');
    const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#__isolationProbeInput' });
    await send('DOM.setFileInputFiles', { files: [file], nodeId: input.result.nodeId });
    return evaluate(`(async () => {
      const { loadRawFile } = await import('/src/app/rawFileLoader.js');
      const file = document.getElementById('__isolationProbeInput').files[0];
      const bytes = await file.arrayBuffer();
      let meta = null;
      const image = await loadRawFile(bytes, file.name, { sharedPlanes: true, onMetadata: (value) => { meta = value; } });
      const hex = async (view) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', view.slice().buffer))].map((b) => b.toString(16).padStart(2, '0')).join('');
      return { width: image.width, height: image.height, shared: typeof SharedArrayBuffer === 'function' && image.__image16.data.buffer instanceof SharedArrayBuffer,
        image16: await hex(image.__image16.data), image8: await hex(image.data), meta: JSON.stringify(meta) };
    })()`);
  };
  const decodeAndExport = async (file, label) => {
    await importFiles([file]);
    await waitFor(`${label}: RAW import converted`, ready, 180_000);
    await wait(1500);
    await waitFor(`${label}: settled`, ready, 180_000);
    const png8 = await exportPng(8, `${label}: 8-bit PNG`);
    const png16 = await exportPng(16, `${label}: 16-bit PNG`);
    return { png8, png16 };
  };

  try {
    await send('Audits.enable');
    await send('Network.enable');
    if (cdpWorkers) await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

    // A small generated CFA DNG: decoded by LibRaw like a camera file.
    const dng = join(dir, 'isolation.dng');
    writeSyntheticDng(dng, { width: 1600, height: 1066, seed: 41, kind: 'color' });

    // ---- 1. isolated page and workers
    step('isolated boot');
    // Uncached, so the boot fetches the star count again. The hash check
    // reads every byte of every shared plane here (no timing is checked).
    await evaluate(`(() => { try { localStorage.removeItem(${JSON.stringify(STAR_COUNT_CACHE_KEY)}); } catch {} return true; })()`);
    await boot('&planeGuard=1');
    const page = await evaluate(`({ isolated: self.crossOriginIsolated === true, sab: typeof SharedArrayBuffer === 'function',
      report: window.__ncIsolation.page() })`);
    if (!page.isolated || !page.sab) fail(`the page is not cross-origin isolated on the Vite dev server: ${JSON.stringify(page)}`);
    const report = await evaluate(REPORT);
    console.log('isolation report:', JSON.stringify(report.workers));
    const notIsolated = Object.entries(report.workers).filter(([, answer]) => answer.crossOriginIsolated !== true);
    if (!report.allIsolated || notIsolated.length) fail(`workers not cross-origin isolated: ${JSON.stringify(notIsolated)}`);
    for (const name of ['conversion', 'conversionBand', 'geometry', 'rawPostDecode', 'autoFrame', 'dust', 'aiInpaint', 'semantic', 'scanDecode', 'multiShot', 'export',
      'rollFrame', 'autoFrameHelper', 'displayProxy', 'heif', 'blob', 'libraw']) {
      if (!report.workers[name]) fail(`the isolation report has no ${name} worker`);
    }
    const threadedLibRaw = report.workers.libraw.threaded === true;
    if (threadedLibRaw && !(report.workers.libraw.threads > 1)) fail(`the threaded LibRaw build runs on one thread on an isolated page: ${JSON.stringify(report.workers.libraw)}`);

    // ---- 2. third-party and bundled loads under COEP
    step('third-party loads');
    const analytics = await evaluate(`[...document.scripts].map(s => s.src).filter(src => /vercel|insights/.test(src))`);
    if (analytics.length) fail(`Vercel Analytics injected a script in dev: ${JSON.stringify(analytics)}`);
    // The star count: rendered from api.github.com under COEP. Offline or a
    // rate limit (403) is only noted; a CORS or COEP failure fails the step.
    await waitFor('GitHub star count', `!document.getElementById('githubStarCount')?.hidden`, 20_000, { soft: true });
    const starCount = await evaluate(`(() => { const el = document.getElementById('githubStarCount'); return { shown: !!el && !el.hidden, text: el?.textContent || '' }; })()`);
    const starFetches = [...starRequests.values()];
    console.log('isolation star count:', JSON.stringify({ ...starCount, requests: starFetches }));
    const starBlocked = starFetches.filter((entry) => entry.blockedReason || entry.cors);
    if (starBlocked.length) fail(`the GitHub star count request was blocked on the isolated page: ${JSON.stringify(starBlocked)}`);
    if (!starCount.shown) console.log(`note: the GitHub star count was not rendered (offline or rate limited?): ${JSON.stringify(starFetches)}`);
    await evaluate(`(() => {
      document.getElementById('lensLensMakerInput').value = 'Nikon';
      document.getElementById('lensLensModelInput').value = 'AF-S Nikkor 50mm f/1.8G';
      document.getElementById('lensSearchBtn').click();
    })()`);
    // The click disables the button until the search has run.
    await waitFor('lensfun search', `!document.getElementById('lensSearchBtn').disabled`, 60_000, { soft: true });
    const lens = await evaluate(LENSFUN_CHECK);
    console.log('isolation lensfun:', JSON.stringify(lens));
    // The app's lens search ran (on the bundled assets unless they failed and
    // the CDN answered), and the bundled assets load on their own.
    if (/fail|失败|失敗/i.test(lens.status) || !lens.options) fail(`lensfun did not load under COEP: ${JSON.stringify(lens)}`);
    if (!lens.local.ok) fail(`the bundled lensfun assets do not load on the isolated page: ${JSON.stringify(lens.local)}`);

    // ---- ONNX Runtime threads: several in an isolated worker, one without
    step('ORT threads');
    // isolation; MI-GAN and EfficientViT output against one thread.
    const ort = await evaluate(ORT_THREADS_PROBE);
    console.log('isolation ORT threads:', JSON.stringify(ort));
    if (ort.error) fail(`ORT thread probe failed: ${ort.error}`);
    // min(4, cores - 2) threads: more than one from 4 cores up.
    if ((ort.cores >= 4 && !(ort.defaultThreads > 1)) || !(ort.many.threads > 1) || ort.one.threads !== 1) {
      fail(`ORT does not run threaded in an isolated worker: ${JSON.stringify(ort)}`);
    }
    // MI-GAN runs threaded because its output does not depend on the thread
    // count; EfficientViT stays on one thread (semanticWorker.js), so its
    // differences are only reported.
    if (ort.diff.migan.differing || ort.diffTwo.migan.differing) {
      fail(`MI-GAN output depends on the ORT thread count: ${JSON.stringify({ many: ort.diff.migan, two: ort.diffTwo.migan })}`);
    }
    if (ort.diff.semantic.differing || ort.diffTwo.semantic.differing) {
      console.log(`note: EfficientViT logits differ between 1 and ${ort.many.threads} threads (it runs on one): ${JSON.stringify(ort.diff.semantic)}`);
    }

    // ---- 3. a LibRaw decode and its exports, isolated
    step('LibRaw decode, isolated');
    // Three decodes of the same file on the isolated page (a threaded LibRaw
    // build runs its pool there): the output must not change between them.
    const isolatedDecode = await rawProbe(dng);
    for (let repeat = 2; repeat <= 3; repeat++) {
      const again = await rawProbe(dng);
      if (again.image16 !== isolatedDecode.image16 || again.image8 !== isolatedDecode.image8 || again.meta !== isolatedDecode.meta) {
        fail(`LibRaw decode ${repeat} of the same file differs on the isolated page: ${JSON.stringify({ first: isolatedDecode, again })}`);
      }
    }
    const isolatedExports = await decodeAndExport(dng, 'isolated');
    const guard = await evaluate(`window.__ncIsolation.planeGuard()`);
    if (!guard.enabled) fail('the shared-plane hash check is off on the dev server');
    if (guard.violations.length) fail(`a shared plane changed during a worker job: ${JSON.stringify(guard.violations)}`);
    // Opt-in (ISOLATION_CDP_WORKERS=1): CDP also reads self.crossOriginIsolated
    // in every worker target that starts, nested ones included.
    const checkedWorkers = (await Promise.all(workerChecks.splice(0))).filter((entry) => !entry.gone);
    if (cdpWorkers) {
      const badWorkers = checkedWorkers.filter((entry) => entry.isolated !== true);
      if (badWorkers.length) fail(`worker targets not cross-origin isolated: ${JSON.stringify(badWorkers)}`);
      const librawWorkers = checkedWorkers.filter((entry) => /libraw/.test(entry.url) && entry.name !== 'em-pthread');
      const librawThreads = checkedWorkers.filter((entry) => /libraw-threaded/.test(entry.url) && entry.name === 'em-pthread');
      console.log(`isolation: ${checkedWorkers.length} worker targets isolated (${librawWorkers.length} LibRaw, ${librawThreads.length} LibRaw pthreads)`);
      if (!librawWorkers.length) fail(`no LibRaw worker target was seen: ${JSON.stringify(checkedWorkers.map((entry) => entry.url))}`);
      if (threadedLibRaw && !librawThreads.length) console.log('note: no LibRaw pthread target was attached in time');
    }

    // ---- opt-in: decode time of real files with the installed build
    if (timingFiles.length) {
      const fixtures = join(root, '.isolation-timing');
      mkdirSync(fixtures, { recursive: true });
      try {
        for (const file of timingFiles) {
          const name = basename(file);
          copyFileSync(file, join(fixtures, name));
          const timing = await evaluate(`(async () => {
            const { loadRawFile } = await import('/src/app/rawFileLoader.js');
            const { createLibRaw } = await import('/src/app/librawRuntime.js');
            // A threaded build's pool start-up (nested workers), per decode.
            let poolMs = null;
            const probe = createLibRaw();
            if (probe.threaded && typeof probe.raw.runtimeInfo === 'function') {
              const started = performance.now();
              await probe.raw.runtimeInfo();
              poolMs = Math.round(performance.now() - started);
            }
            probe.raw.dispose?.();
            const url = '/@fs' + ${JSON.stringify(join(fixtures, name))};
            const bytes = await (await fetch(url)).arrayBuffer();
            const runs = [];
            let info = null;
            const log = console.info;
            console.info = (...args) => { if (args[0] === '[RAW]') info = args[1]; };
            try {
              for (let i = 0; i < 3; i++) {
                const started = performance.now();
                const image = await loadRawFile(bytes.slice(0), ${JSON.stringify(name)}, { sharedPlanes: true });
                runs.push(Math.round(performance.now() - started));
                if (!image?.__image16) throw new Error('no 16-bit plane');
              }
            } finally { console.info = log; }
            runs.sort((a, b) => a - b);
            return { name: ${JSON.stringify(name)}, median: runs[1], runs, threads: info?.threads ?? null, poolMs, width: info?.width, height: info?.height };
          })()`);
          console.log('isolation RAW timing:', JSON.stringify(timing));
        }
      } finally {
        rmSync(fixtures, { recursive: true, force: true });
      }
    }

    // ---- opt-in: the page thread's plane copies during a fresh import, with
    // shared planes and with the copy path (?sharedPlanes=0), each on a fresh
    // page (the hash check off: it is not part of the import).
    if (profileFiles.length) {
      const installed = await send('Page.addScriptToEvaluateOnNewDocument', { source: COPY_LOG });
      try {
        await boot('&planeGuard=0');
        // The method's control: a 64 MB plane posted to a worker without a
        // transfer and sliced once, and the same plane shared.
        const control = await evaluate(`(() => {
          window.__ncCopyLog.length = 0;
          const worker = new Worker(URL.createObjectURL(new Blob(['onmessage = () => {}'], { type: 'text/javascript' })));
          const plane = new Uint16Array(32 * 1024 * 1024);
          worker.postMessage(plane);
          plane.slice();
          worker.postMessage(new Uint16Array(new SharedArrayBuffer(64 * 1024 * 1024)));
          worker.terminate();
          return window.__ncCopyLog.splice(0);
        })()`);
        const controlSummary = summarizeCopies(control);
        console.log('isolation import profile control (64 MB clone, slice, shared post):', JSON.stringify(controlSummary));
        if (controlSummary.copies !== 2) fail(`the copy log missed the control's clone and slice, or counted the shared post: ${JSON.stringify(control)}`);
        for (const file of profileFiles) {
          const result = { file: basename(file) };
          for (const [label, query] of [['shared', '&planeGuard=0'], ['copy', '&planeGuard=0&sharedPlanes=0']]) {
            await boot(query);
            const importStarted = Date.now();
            await evaluate('window.__ncCopyLog.length = 0');
            await importFiles([file]);
            await waitFor(`${label} profile: import converted`, ready, 600_000);
            await wait(1500);
            await waitFor(`${label} profile: settled`, ready, 600_000);
            result[label] = { ms: Date.now() - importStarted, ...summarizeCopies(await evaluate('window.__ncCopyLog.splice(0)')) };
          }
          const within = result.shared.longestMs <= 10 && result.shared.copyMs <= 20;
          console.log('isolation import profile:', JSON.stringify(result));
          console.log(`${within ? 'ok' : 'note'}: ${result.file} shared planes: page-thread copies ${result.shared.copyMs} ms in all, longest ${result.shared.longestMs} ms`
            + ` (copy path: ${result.copy.copyMs} ms, longest ${result.copy.longestMs} ms)${within ? '' : ' -- over the #264 budget (10 ms per copy, 20 ms in all)'}`);
        }
      } finally {
        if (installed.result?.identifier) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: installed.result.identifier });
      }
    }

    // ---- 4. the same decode on a page that is not isolated
    step('page without isolation');
    await send('Fetch.enable', { patterns: [{ urlPattern: `*${NOT_ISOLATED_MARK}*`, resourceType: 'Document', requestStage: 'Response' }] });
    // fulfillRequest, not continueResponse: the browser takes COOP/COEP from
    // the headers it parsed, which only a new response replaces. (Vite's HMR
    // client then logs that its websocket failed; nothing reloads here.)
    const stopStripping = onCdpEvent((msg) => {
      if (msg.method !== 'Fetch.requestPaused' || msg.sessionId) return;
      const { requestId, responseHeaders = [], responseStatusCode } = msg.params;
      const headers = responseHeaders.filter(({ name }) => !/^cross-origin-(opener|embedder)-policy$/i.test(name));
      void send('Fetch.getResponseBody', { requestId }).then((reply) => {
        const body = reply.result?.base64Encoded ? reply.result.body : Buffer.from(reply.result?.body || '').toString('base64');
        return send('Fetch.fulfillRequest', { requestId, responseCode: responseStatusCode || 200, responseHeaders: headers, body });
      });
    });
    try {
      await boot(`&${NOT_ISOLATED_MARK}`);
    } finally {
      stopStripping();
      await send('Fetch.disable');
    }
    const plain = await evaluate(`({ isolated: self.crossOriginIsolated === true, shared: window.__ncIsolation.page().crossOriginIsolated })`);
    if (plain.isolated) fail('the page served without COOP/COEP is still isolated');
    const plainReport = await evaluate(REPORT);
    const failedToStart = Object.entries(plainReport.workers).filter(([, answer]) => answer.error);
    if (failedToStart.length) fail(`workers failed on the page that is not isolated: ${JSON.stringify(failedToStart)}`);
    if (Object.values(plainReport.workers).some((answer) => answer.crossOriginIsolated)) fail(`a worker of a page that is not isolated reports isolation: ${JSON.stringify(plainReport.workers)}`);
    const plainDecode = await rawProbe(dng);
    const plainExports = await decodeAndExport(dng, 'not isolated');
    console.log('isolation decodes:', JSON.stringify({ isolated: isolatedDecode, notIsolated: plainDecode }));
    console.log('isolation exports:', JSON.stringify({ isolated: isolatedExports, notIsolated: plainExports }));
    if (!isolatedDecode.shared || plainDecode.shared) fail(`shared planes are not tied to isolation: ${JSON.stringify({ isolatedDecode, plainDecode })}`);
    for (const key of ['width', 'height', 'image16', 'image8', 'meta']) {
      if (isolatedDecode[key] !== plainDecode[key]) fail(`the LibRaw decode differs between the isolated page and the copy path (${key}): ${JSON.stringify({ isolatedDecode, plainDecode })}`);
    }
    if (plainExports.png8 !== isolatedExports.png8 || plainExports.png16 !== isolatedExports.png16) {
      fail(`exports differ between the isolated page and the copy path: ${JSON.stringify({ isolatedExports, plainExports })}`);
    }
    await Promise.all(workerChecks.splice(0));

    if (blocked.length) fail(`requests blocked by COEP/CORP/COOP: ${JSON.stringify(blocked.slice(0, 10))}`);
    const probed = Object.keys(report.workers).length;
    console.log(`ok: page and ${probed} worker scripts${cdpWorkers ? ` (${checkedWorkers.length} worker targets via CDP)` : ''} cross-origin isolated, lensfun loads, ORT threads, no COEP/CORP/COOP blocks, exports identical without isolation`);
  } finally {
    stopListening();
    if (cdpWorkers) await send('Target.setAutoAttach', { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
    await send('Network.disable');
    for (const sessionId of sessions.keys()) void sendTo(sessionId, 'Runtime.runIfWaitingForDebugger').catch?.(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}
