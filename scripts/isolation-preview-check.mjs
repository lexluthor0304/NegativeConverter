// Opt-in check of cross-origin isolation on the production build (#264 Part
// A, "Chrome on the Vite preview"): the same headers Vercel sends
// (scripts/cross-origin-isolation.mjs), served by `vite preview` from
// negative2positive/dist. Not part of `npm test` or the smoke run, which use
// the dev server.
//
//   npm run build:web && PORT=5331 CDP_PORT=9331 node scripts/isolation-preview-check.mjs
//
// Checks: the page and every worker are isolated (window.__ncIsolation.report();
// with ISOLATION_CDP_WORKERS=1 also CDP on every worker target that starts); a
// generated CFA DNG decodes through LibRaw's bundled worker and exports as a
// 16-bit PNG (with a threaded libraw-wasm installed, its pthread pool starts
// from the bundled chunks); dust removal repairs a photo with MI-GAN on more
// than one ONNX Runtime thread (its pthreads start from the bundled chunks
// too); no request is blocked by COEP, CORP or COOP.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSyntheticDng } from './perf/fixtures.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 5331;
const CDP_PORT = Number(process.env.CDP_PORT) || 9331;
const chromeBin = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find((path) => existsSync(path));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [];
const dir = mkdtempSync(join(tmpdir(), 'nc-isolation-preview-'));
function cleanup() {
  for (const child of children) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  rmSync(dir, { recursive: true, force: true });
}
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));
function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

if (!existsSync(join(ROOT, 'negative2positive', 'dist', 'index.html'))) fail('no production build: run `npm run build:web` first');
if (!chromeBin) fail('Google Chrome not found');

const preview = spawn(process.execPath, [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview',
  '--config', 'negative2positive/vite.config.js', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
children.push(preview);
let headers = null;
for (let i = 0; i < 60 && !headers; i++) {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/`);
    if (response.ok) headers = Object.fromEntries(response.headers);
  } catch { /* not up yet */ }
  if (!headers) await wait(500);
}
if (!headers) fail('vite preview did not start');
if (headers['cross-origin-opener-policy'] !== 'same-origin' || headers['cross-origin-embedder-policy'] !== 'require-corp') {
  fail(`the preview server does not send the isolation headers: ${JSON.stringify(headers)}`);
}

const profile = mkdtempSync(join(dir, 'chrome-'));
const chrome = spawn(chromeBin, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });
children.push(chrome);
let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i++) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
    wsUrl = targets.find((target) => target.type === 'page')?.webSocketDebuggerUrl || null;
  } catch { /* not up yet */ }
  if (!wsUrl) await wait(250);
}
if (!wsUrl) fail('Chrome did not expose CDP');
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
const blocked = [];
const workers = [];
const listeners = [];
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'Audits.issueAdded' && msg.params?.issue?.code === 'BlockedByResponseIssue') {
    blocked.push(msg.params.issue.details?.blockedByResponseIssueDetails);
  }
  for (const listener of listeners) listener(msg);
};
const send = (method, params = {}, sessionId = undefined) => new Promise((resolve) => {
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); resolve({ error: { message: `timed out: ${method}` } }); }, 180_000);
  pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const evaluate = async (expression) => {
  const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (reply.result?.exceptionDetails) fail(`evaluate threw: ${JSON.stringify(reply.result.exceptionDetails).slice(0, 800)}`);
  return reply.result?.result?.value;
};
const waitFor = async (label, expression, timeoutMs = 120_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(expression)) return;
    await wait(500);
  }
  fail(`timeout waiting for ${label}`);
};
listeners.push((msg) => {
  if (msg.method !== 'Target.attachedToTarget') return;
  const { sessionId, targetInfo, waitingForDebugger } = msg.params;
  if (!/worker/.test(targetInfo.type)) {
    if (waitingForDebugger) void send('Runtime.runIfWaitingForDebugger', {}, sessionId);
    return;
  }
  workers.push((async () => {
    // Not paused: a paused worker holds up a threaded runtime's pool start.
    void send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
    if (waitingForDebugger) void send('Runtime.runIfWaitingForDebugger', {}, sessionId);
    const reply = await send('Runtime.evaluate', {
      expression: `(async () => { for (let i = 0; i < 150 && self.onmessage === null; i++) await new Promise(r => setTimeout(r, 20));
        return { isolated: self.crossOriginIsolated === true, name: self.name || '' }; })()`,
      awaitPromise: true, returnByValue: true
    }, sessionId);
    const value = reply.result?.result?.value;
    return value ? { url: targetInfo.url, ...value } : { url: targetInfo.url, gone: true };
  })());
});

await send('Page.enable');
await send('Runtime.enable');
await send('Audits.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?lang=en&debug=1` });
await waitFor('app boot', `document.readyState === 'complete' && !!window.__ncIsolation && !!document.getElementById('fileInput')`);
await wait(1500);
const page = await evaluate(`({ isolated: self.crossOriginIsolated === true, sab: typeof SharedArrayBuffer === 'function' })`);
if (!page.isolated || !page.sab) fail(`the production build is not isolated: ${JSON.stringify(page)}`);
const report = await evaluate(`window.__ncIsolation.report()`);
console.log('preview isolation report:', JSON.stringify(report.workers));
if (!report.allIsolated) fail(`not every worker is isolated: ${JSON.stringify(report.workers)}`);
// A threaded libraw-wasm (#264 Part D) starts its pthread pool from the
// bundled worker chunks: more than one thread here means the nested workers
// resolved in the production build.
const libraw = report.workers.libraw || {};
if (libraw.threaded && !(libraw.threads > 1 && libraw.poolSize > 0)) fail(`the threaded LibRaw build did not start its pool in the production build: ${JSON.stringify(libraw)}`);
// CDP auto-attach to worker targets is opt-in (ISOLATION_CDP_WORKERS=1): in
// Chrome 154 attaching to them held up the page (see isolation-smoke.mjs).
if (process.env.ISOLATION_CDP_WORKERS === '1') await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

// A LibRaw decode on the built bundle and a 16-bit PNG export.
const dng = join(dir, 'preview.dng');
writeSyntheticDng(dng, { width: 1600, height: 1066, seed: 43, kind: 'color' });
await evaluate(`(() => {
  window.showSaveFilePicker = undefined;
  window.__previewDownloads = [];
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && this.href.startsWith('blob:')) window.__previewDownloads.push(fetch(this.href).then(r => r.arrayBuffer()).then(b => b.byteLength));
  };
})()`);
const doc = await send('DOM.getDocument');
const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
await send('DOM.setFileInputFiles', { files: [dng], nodeId: input.result.nodeId });
const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy && !document.body.dataset.studioDetecting && !document.querySelector('.loading-overlay.visible')`;
await waitFor('RAW import', ready, 180_000);
await wait(1500);
await waitFor('settled', ready, 180_000);
await evaluate(`document.querySelector('.format-btn[data-format="png"]').click(); document.querySelector('.bitdepth-btn[data-bitdepth="16"]').click()`);
await wait(200);
await evaluate(`document.getElementById('exportSingleBtn').click()`);
await waitFor('16-bit PNG export', `window.__previewDownloads.length > 0`, 180_000);
const bytes = await evaluate(`window.__previewDownloads[0]`);
if (!(bytes > 1000)) fail(`the export is empty: ${bytes}`);
const guard = await evaluate(`window.__ncIsolation.planeGuard()`);
const checked = (await Promise.all(workers)).filter((entry) => !entry.gone);
const notIsolated = checked.filter((entry) => !entry.isolated);
console.log(`preview: ${checked.length} worker targets, LibRaw: ${checked.filter((entry) => /worker-[\w-]+\.js|libraw/i.test(entry.url)).length}, guard ${JSON.stringify({ checks: guard.checks, violations: guard.violations.length })}`);
if (notIsolated.length) fail(`worker targets not isolated: ${JSON.stringify(notIsolated)}`);
if (guard.violations.length) fail(`shared-plane check fired: ${JSON.stringify(guard.violations)}`);

// ONNX Runtime's pthreads start from the bundled chunks: dust removal loads
// MI-GAN on its own and repairs a photo with dust, on min(4, cores - 2)
// threads (#264 Part A phase 1: "ORT's threaded .mjs resolves under Vite").
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?lang=en&debug=1` });
await waitFor('app boot for AI repair', `document.readyState === 'complete' && !!window.__ncIsolation?.aiRepair && /No model loaded/.test(document.getElementById('dustAiStatus')?.textContent || '')`);
await wait(500);
const dustDoc = await send('DOM.getDocument');
const dustInput = await send('DOM.querySelector', { nodeId: dustDoc.result.root.nodeId, selector: '#fileInput' });
await send('DOM.setFileInputFiles', { files: [join(ROOT, 'negative2positive/test-fixtures/negative-sample.jpg')], nodeId: dustInput.result.nodeId });
await waitFor('photo with dust', `${ready} && document.getElementById('studioFilename').textContent === 'negative-sample.jpg'`, 150_000);
await evaluate(`document.getElementById('studioTab-repair').click(); document.getElementById('dustRemovalEnabled').click()`);
await waitFor('MI-GAN loads and repairs', `/Model ready.*last run [1-9]/.test(document.getElementById('dustAiStatus').textContent)`, 180_000);
const ai = await evaluate(`({ ...window.__ncIsolation.aiRepair(), cores: navigator.hardwareConcurrency, status: document.getElementById('dustAiStatus').textContent })`);
console.log('preview AI repair:', JSON.stringify(ai));
if (ai.cores >= 4 && !(ai.threads > 1)) fail(`ONNX Runtime runs on one thread in the isolated production build: ${JSON.stringify(ai)}`);
if (blocked.length) fail(`requests blocked by COEP/CORP/COOP: ${JSON.stringify(blocked.slice(0, 5))}`);
console.log(`ok: production build isolated in the page and ${checked.length} workers; RAW decode and 16-bit export (${bytes} bytes) work; MI-GAN repairs on ${ai.provider} with ${ai.threads} ORT threads`);
process.exit(0);
