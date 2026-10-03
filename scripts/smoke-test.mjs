import { runRollFilmTypeSmoke } from './roll-film-type-smoke.mjs';
import { runFolderImportSmoke } from './folder-import-smoke.mjs';
import { runSimplicitySmoke } from './simplicity-smoke.mjs';
import { runHiddenJobSmoke } from './hidden-job-smoke.mjs';
import { runMemoryBudgetSmoke } from './memory-budget-smoke.mjs';
import { runPerfHarnessSmoke } from './perf-harness-smoke.mjs';
import { runEmbeddedPreviewSmoke } from './embedded-preview-smoke.mjs';
import { runDisplaySessionSmoke } from './display-session-smoke.mjs';
import { runInterpretationRoutesSmoke } from './interpretation-routes-smoke.mjs';
import { expectLoadingOverlayIdle } from './loading-overlay-idle.mjs';
// End-to-end smoke test: drives the real app in headless Chrome via CDP.
//
//   node scripts/smoke-test.mjs
//   node scripts/smoke-test.mjs --dust-only --dust-delay-inpaint
//
// Vite 起動 → 実際の入力から写真を読み込み → Studio 自動変換 → 調整・一括書き出し。
// Asserts the canvas pixels actually changed (negative inverted) and that no
// uncaught page errors occurred. Requires Google Chrome on this machine.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runPositiveImportSmoke } from './positive-import-smoke.mjs';
import { runBwRollImportSmoke } from './bw-roll-import-smoke.mjs';
import { runStudioSmoke } from './studio-smoke.mjs';
import { runStudioAutoCropSmoke } from './studio-auto-crop-smoke.mjs';
import { runStudioColorAnalysisSmoke } from './studio-color-analysis-smoke.mjs';
import { runWorkspaceUiSmoke } from './workspace-ui-smoke.mjs';
import { runStudioRawAutoFrameSmoke } from './studio-raw-autoframe-smoke.mjs';
import { runFilmEdgeSmoke } from './film-edge-smoke.mjs';
import { runRollAnalysisSmoke } from './roll-analysis-smoke.mjs';
import { runLightTableSmoke } from './light-table-smoke.mjs';
import { runPhotoSortSmoke } from './photo-sort-smoke.mjs';
import { runPerformanceUiSmoke } from './performance-ui-smoke.mjs';
import { runComparePreviewSmoke } from './compare-preview-smoke.mjs';
import { runRestartRenderSmoke } from './restart-render-smoke.mjs';
import { runPhotoSessionSmoke, runPhotoSessionRawSmoke } from './photo-session-smoke.mjs';
import { runPhotoHeapSmoke } from './photo-heap-smoke.mjs';
import { runPhotoActivationSmoke } from './photo-activation-smoke.mjs';
import { runWebglPreviewSmoke } from './webgl-preview-smoke.mjs';
import { runPreviewTierSmoke } from './preview-tier-smoke.mjs';
import { runPreviewPathSmoke } from './preview-path-smoke.mjs';
import { runGpuPreviewSmoke } from './gpu-preview-smoke.mjs';
import { runDisplayModesSmoke } from './display-modes-smoke.mjs';
import { runZoomDetailSmoke } from './zoom-detail-smoke.mjs';
import { runDarkroomSmoke } from './darkroom-smoke.mjs';
import { runCameraSmoke } from './camera-smoke.mjs';
import { runRollHomeSmoke } from './roll-home-smoke.mjs';
import { runTechnicalDepthSmoke } from './technical-depth-smoke.mjs';
import { runExpiredFilmSmoke, runExpiredLiveTypeSmoke } from './expired-film-smoke.mjs';
import { runNativeFilmFontSmoke } from './native-film-font-smoke.mjs';
import { runExportGainMapSmoke } from './export-gain-map-smoke.mjs';
import { runSilverCoreCacheSmoke } from './silvercore-cache-smoke.mjs';
import { runGeometrySmoke } from './geometry-smoke.mjs';
import { runPng16BandSmoke } from './png16-band-smoke.mjs';
import { runRawPostDecodeSmoke, runRawParitySmoke } from './raw-post-decode-smoke.mjs';
import { runRollFrameSmoke } from './roll-frame-smoke.mjs';
import { runRawDecodeGateSmoke } from './raw-decode-gate-smoke.mjs';
import { runExportOwnershipSmoke } from './export-ownership-smoke.mjs';
import { runRepairReleaseSmoke } from './repair-release-smoke.mjs';
import { runDustUndoSmoke } from './dust-undo-smoke.mjs';
import { runBatchPipelineSmoke } from './batch-pipeline-smoke.mjs';
import { runFirstPhotoSmoke } from './first-photo-smoke.mjs';
import { runImportParitySmoke } from './import-parity-smoke.mjs';
import { runStudioSyncSmoke } from './studio-sync-smoke.mjs';
import { runCropApplySmoke } from './crop-apply-smoke.mjs';
import { runAutoFrameImportSmoke } from './autoframe-import-smoke.mjs';
import { runTwoStageImportSmoke } from './two-stage-import-smoke.mjs';
import { runIsolationSmoke } from './isolation-smoke.mjs';

// UPNG is already a runtime dependency of the app; reuse it to decode screenshots.
const UPNG = createRequire(import.meta.url)('upng-js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'negative2positive', 'test-fixtures', 'negative-sample.jpg');
const FIXTURE2 = join(ROOT, 'negative2positive', 'test-fixtures', 'negative-sample-2.jpg');
// PORT / CDP_PORT let an isolated worktree run its own copy alongside another.
const PORT = Number(process.env.PORT) || 5197;
const CDP_PORT = Number(process.env.CDP_PORT) || 9224;
const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const chromeBin = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromeBin) {
  // On CI a missing browser means the smoke never ran, which must not read as
  // a pass; locally it is a legitimate skip.
  if (process.env.CI) {
    console.error('FAIL: no Chrome binary found (set CHROME_BIN)');
    process.exit(1);
  }
  console.error('SKIP: no Chrome binary found (set CHROME_BIN)');
  process.exit(0);
}
if (!existsSync(FIXTURE)) {
  console.error(`FAIL: fixture missing: ${FIXTURE}`);
  process.exit(1);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// A throwaway Chrome profile: without it headless Chrome writes into the
// developer's default profile directory.
const chromeProfileDir = mkdtempSync(join(tmpdir(), 'nc-smoke-'));
const children = [];
function cleanup() {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch {}
  }
  try { rmSync(chromeProfileDir, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
// 'exit' does not fire on Ctrl-C or kill, which would orphan vite and Chrome.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// ---- start vite dev server ----
// Spawning `npx` without a shell throws ENOENT on Windows (it is npx.cmd);
// run vite's bin with the current node instead.
const viteBin = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const vite = spawn(process.execPath, [viteBin, '--config', 'negative2positive/vite.config.js', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: 'ignore',
});
children.push(vite);

let serverUp = false;
for (let i = 0; i < 60; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/`);
    if (res.ok) { serverUp = true; break; }
  } catch {}
  await wait(500);
}
if (!serverUp) fail('vite dev server did not start');

// ---- start chrome ----
const chrome = spawn(chromeBin, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  // The session itself runs over the DevTools pipe (fd 3 in, fd 4 out).
  '--remote-debugging-pipe',
  `--user-data-dir=${chromeProfileDir}`,
  '--no-first-run', '--hide-scrollbars', '--window-size=1440,900',
  // A fake camera, granted without a prompt, for the live loupe scenario.
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
// execFile buffers stderr and kills the browser after its default 1 MiB
// limit; repeated WebGPU model sessions can exceed it. Keep a bounded tail.
let chromeDiagnostics = '';
chrome.stderr.on('data', chunk => { chromeDiagnostics = (chromeDiagnostics + chunk).slice(-8000); });
chrome.once('error', error => fail(`Chrome startup failed: ${error.message}`));
chrome.once('exit', (code, signal) => fail(`Chrome exited before the smoke completed (${code ?? signal}): ${chromeDiagnostics}`));
children.push(chrome);

// The DevTools pipe carries the session, as NUL-delimited JSON. A websocket
// to the debugging port is closed whenever macOS goes from full to dark wake
// (a closed lid, a notification that woke it), which ended runs at random
// steps with "code 1006; Chrome still running"; the pipe stays open. The port
// stays open for manual inspection.
const toChrome = chrome.stdio[3];
const fromChrome = chrome.stdio[4];
let receiveCdp = () => {};
let pipeChunks = [];
fromChrome.on('data', (chunk) => {
  let start = 0;
  for (let end = chunk.indexOf(0); end !== -1; end = chunk.indexOf(0, start)) {
    pipeChunks.push(chunk.subarray(start, end));
    const message = JSON.parse(Buffer.concat(pipeChunks).toString('utf8'));
    pipeChunks = [];
    start = end + 1;
    receiveCdp(message);
  }
  if (start < chunk.length) pipeChunks.push(chunk.subarray(start));
});
const writeCdp = (message) => toChrome.write(`${JSON.stringify(message)}\0`);
toChrome.on('error', (error) => fail(`Chrome debugging pipe failed: ${error.message}`));

// The page target, attached in flat mode: page commands carry its session id
// and page messages are handed on without it, as the page's own websocket
// gave them; worker sessions (Target.setAutoAttach) keep theirs.
const handshake = new Map();
let handshakeId = 0;
receiveCdp = (msg) => {
  if (msg.id && handshake.has(msg.id)) { handshake.get(msg.id)(msg); handshake.delete(msg.id); }
};
const browserCommand = (method, params = {}) => new Promise((resolve) => {
  const id = ++handshakeId;
  const timeout = setTimeout(() => fail(`chrome did not answer ${method} on its debugging pipe`), 30_000);
  handshake.set(id, (m) => { clearTimeout(timeout); resolve(m); });
  writeCdp({ id, method, params });
});
let pageTargetId = null;
for (let i = 0; i < 60 && !pageTargetId; i++) {
  const targets = await browserCommand('Target.getTargets');
  pageTargetId = targets.result?.targetInfos?.find((t) => t.type === 'page')?.targetId || null;
  if (!pageTargetId) await wait(250);
}
if (!pageTargetId) fail('chrome did not expose a page target');
const attached = await browserCommand('Target.attachToTarget', { targetId: pageTargetId, flatten: true });
const pageSessionId = attached.result?.sessionId;
if (!pageSessionId) fail(`could not attach to the page target: ${JSON.stringify(attached.error || attached)}`);
// Why the session went: Chrome's own detach or crash event, whether the
// browser still runs, and the last command sent.
let inspectorEvent = null;
let lastCommand = null;
function sessionLost(what) {
  const running = chrome.exitCode === null && chrome.signalCode === null;
  fail(`${what} (Chrome ${running ? 'still running' : `gone: ${chrome.exitCode ?? chrome.signalCode}`}; `
    + `${inspectorEvent || 'no Inspector event'}; last command ${lastCommand || 'none'}): ${chromeDiagnostics}`);
}
fromChrome.on('close', () => sessionLost('Chrome debugging pipe closed'));

let msgId = 0;
const pending = new Map();
const pageErrors = [];
// Steps that need raw CDP events (worker targets, Fetch) subscribe here.
const cdpEventListeners = new Set();
function onCdpEvent(listener) {
  cdpEventListeners.add(listener);
  return () => cdpEventListeners.delete(listener);
}
// Requests the cross-origin isolated page (#264) had blocked by COEP, CORP or
// COOP, over the whole run: the Audits domain reports each as an issue.
const isolationBlocks = [];
receiveCdp = (msg) => {
  if (msg.sessionId === pageSessionId) delete msg.sessionId;
  else if (!msg.sessionId && !msg.id) {
    // The browser session's own events: only the page session ending matters.
    if (msg.method === 'Target.detachedFromTarget' && msg.params?.sessionId === pageSessionId) {
      sessionLost('Chrome detached the page debugging session');
    }
    return;
  }
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'Inspector.detached' || msg.method === 'Inspector.targetCrashed') {
    inspectorEvent = `${msg.method} ${JSON.stringify(msg.params || {})}`;
    console.error(`page ${inspectorEvent}`);
  }
  for (const listener of cdpEventListeners) {
    try { listener(msg); } catch (error) { console.error('CDP listener failed:', error); }
  }
  if (msg.method === 'Audits.issueAdded' && msg.params?.issue?.code === 'BlockedByResponseIssue' && !msg.sessionId) {
    const details = msg.params.issue.details?.blockedByResponseIssueDetails;
    isolationBlocks.push(`${details?.reason || 'blocked'}: ${details?.request?.url || '?'}`);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params?.exceptionDetails?.exception?.description
      || msg.params?.exceptionDetails?.text || 'unknown exception');
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
    const message = (msg.params.args || []).map(arg => arg.description || arg.value || arg.type).join(' ');
    // ONNX Runtime emits provider-placement warnings through console.error.
    if (/\[W:onnxruntime:/.test(message)) return;
    console.error('page console error:', message);
    if (/^Export failed:/.test(message)) pageErrors.push(message);
    // The shared-plane hash check (#264) must never fire in a smoke run.
    if (/shared plane changed during a worker job/.test(message)) pageErrors.push(message);
    const frames = msg.params.stackTrace?.callFrames || [];
    if (frames.length) console.error(frames.slice(0, 5).map(frame => `  ${frame.functionName} (${frame.url}:${frame.lineNumber + 1})`).join('\n'));
  }
  if (msg.method === 'Page.javascriptDialogOpening') {
    // The guide flow uses alert(); with the Page domain enabled the dialog
    // blocks the renderer until we acknowledge it.
    const text = msg.params?.message || '';
    console.log(`dialog auto-accepted: ${text.slice(0, 120)}`);
    if (/OpenCV/i.test(text)) {
      pageErrors.push(`OpenCV load failure dialog: ${text.slice(0, 200)}`);
    }
    writeCdp({
      id: ++msgId,
      method: 'Page.handleJavaScriptDialog',
      params: { accept: true },
      sessionId: pageSessionId,
    });
  }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++msgId;
  lastCommand = method;
  const timeout = setTimeout(() => fail(`Chrome command timed out: ${method}`), 180_000);
  pending.set(id, (m) => { clearTimeout(timeout); resolve(m); });
  writeCdp({ id, method, params, sessionId: pageSessionId });
});
// A command to an attached target's session (flat mode: a worker, #264).
const sendTo = (sessionId, method, params = {}) => new Promise((resolve) => {
  const id = ++msgId;
  const timeout = setTimeout(() => { pending.delete(id); resolve({ error: { message: `timed out: ${method}` } }); }, 30_000);
  pending.set(id, (m) => { clearTimeout(timeout); resolve(m); });
  writeCdp({ id, method, params, sessionId });
});
async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.result?.exceptionDetails) {
    fail(`evaluate threw: ${JSON.stringify(res.result.exceptionDetails)}`);
  }
  return res.result?.result?.value;
}
// The app renders its own modal dialogs instead of calling alert()/confirm(),
// because native JavaScript dialogs are silently ignored inside the macOS
// desktop webview. Auto-confirm them the way the CDP handler auto-accepted the
// native ones, and record their text so the OpenCV failure check still works.
async function installDialogAutoAccept() {
  await evaluate(`(() => {
    if (window.__ncDialogAuto) return true;
    window.__ncDialogAuto = true;
    window.__ncDialogLog = [];
    setInterval(() => {
      const btn = document.querySelector('[data-app-dialog-confirm]');
      if (!btn) return;
      const msgEl = document.querySelector('[data-app-dialog-message]');
      window.__ncDialogLog.push(msgEl ? msgEl.textContent : '');
      btn.click();
    }, 150);
    return true;
  })()`);
}

async function drainDialogs() {
  const messages = await evaluate(`(() => {
    const log = window.__ncDialogLog || [];
    window.__ncDialogLog = [];
    return log;
  })()`);
  for (const text of messages || []) {
    console.log(`dialog auto-accepted: ${String(text).slice(0, 120)}`);
    if (/OpenCV/i.test(text)) {
      pageErrors.push(`OpenCV load failure dialog: ${String(text).slice(0, 200)}`);
    }
  }
}

async function waitFor(description, expression, timeoutMs = 60_000, { soft = false } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await evaluate(expression)) return true;
    await drainDialogs();
    await wait(500);
  }
  if (soft) return false;
  await dumpDiagnostics(description);
  fail(`timeout waiting for ${description}`);
}

async function dumpDiagnostics(context) {
  try {
    const info = await evaluate(`(() => ({
      badge: document.getElementById('statusBadge')?.className,
      overlay: document.querySelector('.loading-overlay')?.className,
      loadingText: document.querySelector('.loading-progress-text')?.textContent,
      phaseText: document.querySelector('.loading-phase-text')?.textContent,
      dustStatus: document.getElementById('dustStatus')?.textContent,
      dustWorkerResponses: window.__dustSources,
      dustStatusUpdates: window.__dustStatusUpdates,
      loupeStatus: document.getElementById('loupeStatus')?.textContent,
      loupeHidden: document.getElementById('loupeOverlay')?.hidden,
      loupePermissionProbe: window.__loupePermissionProbe,
      timeOrigin: performance.timeOrigin,
      toast: [...document.querySelectorAll('.toast-message')].map((t) => t.textContent),
    }))()`);
    console.error(`diagnostics [${context}]: ${JSON.stringify(info)}`);
    if (pageErrors.length) console.error(`page errors so far:\n${pageErrors.join('\n---\n')}`);
  } catch {}
}

// Mean luminance of the composited preview area, measured from a real
// screenshot. This sees exactly what the user sees — including the WebGL
// canvas, whose backbuffer cannot be read back via drawImage.
async function previewLuminance() {
  const rect = await evaluate(`(() => {
    const r = document.getElementById('canvasContainer').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`);
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { ...rect, scale: 1 },
  });
  const png = UPNG.decode(Buffer.from(shot.result.data, 'base64'));
  const rgba = new Uint8Array(UPNG.toRGBA8(png)[0]);
  let sum = 0;
  for (let i = 0; i < rgba.length; i += 4) sum += rgba[i] + rgba[i + 1] + rgba[i + 2];
  return sum / (rgba.length / 4 * 3);
}

await send('Page.enable');
// Keep the compile-once OpenCV check observable even after the full run's
// imports and worker loads have filled the default Resource Timing buffer.
await send('Page.addScriptToEvaluateOnNewDocument', { source: 'performance.setResourceTimingBufferSize(100000);' });
await send('Runtime.enable');
await send('Inspector.enable');
await send('Audits.enable');
// The fake-camera flags make headless Chrome reserve part of the window (the
// viewport came out 1440x757); pin the layout the scenarios were written for.
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?lang=en` });
await waitFor('app boot', `!!document.getElementById('studioImportAutoCrop')`);
await installDialogAutoAccept();
await wait(1500); // let main.js finish wiring

// This scenario navigates and imports its own small fixtures. Exit here so
// --auto-crop-only cannot continue through the unrelated camera/roll suites.
if (process.argv.includes('--auto-crop-only')) {
  await runStudioAutoCropSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}
await evaluate(`document.getElementById('studioImportAutoCrop').click()`);

if (process.argv.includes('--isolation-only')) {
  await runIsolationSmoke({ send, sendTo, onCdpEvent, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
  if (isolationBlocks.length) fail(`requests blocked by COEP/CORP/COOP:\n${isolationBlocks.join('\n')}`);
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}

if (process.argv.includes('--performance-only')) {
  await runPerformanceUiSmoke({ evaluate, fail });
  await runRawPostDecodeSmoke({ evaluate, fail });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}

// #252: OpenCV's shared module, the roll-frame worker and the parallel detector.
if (process.argv.includes('--roll-frame-only')) {
  await runRollFrameSmoke({ evaluate, fail });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}

// Opt-in: real RAW files, see scripts/raw-post-decode-smoke.mjs.
if (process.argv.includes('--raw-parity-only')) {
  // Recording on 1703835 (RAW_PARITY_RECORD=1) only needs loadRawFile there.
  if (process.env.RAW_PARITY_RECORD !== '1') await runRawPostDecodeSmoke({ evaluate, fail });
  await runRawParitySmoke({ send, evaluate, waitFor, fail, port: PORT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}

// Opt-in: the RGB16 gate over every decoder configuration (#264), real RAW
// files, see scripts/raw-decode-gate-smoke.mjs.
if (process.argv.includes('--raw-decode-gate-only')) {
  await runRawDecodeGateSmoke({ send, onCdpEvent, evaluate, waitFor, fail, port: PORT, root: ROOT });
  if (isolationBlocks.length) fail(`requests blocked by COEP/CORP/COOP:\n${isolationBlocks.join('\n')}`);
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}

if (process.argv.includes('--studio-sync-only')) {
  await runStudioSyncSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}

if (process.argv.includes('--silvercore-cache-only')) {
  await runSilverCoreCacheSmoke({ evaluate, fail });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}

if (process.argv.includes('--compare-preview-only')) {
  await runComparePreviewSmoke({ send, evaluate, waitFor, wait, fail, port: PORT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}

if (process.argv.includes('--restart-only')) {
  await runRestartRenderSmoke({ send, evaluate, waitFor, fail, port: PORT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}

if (process.argv.includes('--photo-session-only')) {
  await runPhotoSessionSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port: PORT });
  await runPhotoHeapSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port: PORT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}

if (process.argv.includes('--photo-heap-only')) {
  await runPhotoHeapSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port: PORT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}

if (process.argv.includes('--display-session-only')) {
  await runDisplaySessionSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port: PORT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}

if (process.argv.includes('--photo-activation-only')) {
  await runPhotoActivationSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}

if (process.argv.includes('--webgl-preview-only')) {
  await runWebglPreviewSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port: PORT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}

if (process.argv.includes('--preview-tier-only')) {
  await runPreviewTierSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port: PORT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}

if (process.argv.includes('--preview-path-only')) {
  await runPreviewPathSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port: PORT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}

if (process.argv.includes('--gpu-preview-only')) {
  await runGpuPreviewSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port: PORT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}

if (process.argv.includes('--display-modes-only')) {
  await runDisplayModesSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port: PORT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}

if (process.argv.includes('--zoom-detail-only')) {
  await runZoomDetailSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port: PORT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}

if (process.argv.includes('--photo-sort-only')) {
  await runPhotoSortSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
  if (pageErrors.length) fail('uncaught page errors: ' + pageErrors.join('\n'));
  console.log('SMOKE PASS (photo sorting)');
  process.exit(0);
}

if (process.argv.includes('--light-table-only')) {
  await runLightTableSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
  if (pageErrors.length) fail('uncaught page errors: ' + pageErrors.join('\n'));
  console.log('SMOKE PASS (light table)');
  process.exit(0);
}

if (process.argv.includes('--photo-session-raw-only')) {
  await runPhotoSessionRawSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port: PORT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}

if (process.argv.includes('--simplicity-only')) {
  await runSimplicitySmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}
if (process.argv.includes('--positive-only')) {
  await runPositiveImportSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS');
  process.exit(0);
}
if (process.argv.includes('--bw-roll-only')) {
  await runBwRollImportSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS');
  process.exit(0);
}
if (process.argv.includes('--native-font-only')) {
  await runNativeFilmFontSmoke({ send, evaluate, waitFor, wait, fail, port: PORT, root: ROOT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS');
  process.exit(0);
}
if (process.argv.includes('--roll-film-type-only')) {
  await runRollFilmTypeSmoke({send,evaluate,waitFor,wait,fail,installDialogAutoAccept,port:PORT});
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}
if (process.argv.includes('--folder-only')) {
  await runFolderImportSmoke({send,evaluate,waitFor,wait,fail,installDialogAutoAccept,port:PORT,root:ROOT});
  if(pageErrors.filter(e=>!/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS');process.exit(0);
}
if (process.argv.includes('--export-ownership-only')) {
  await runExportOwnershipSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS');
  process.exit(0);
}
if (process.argv.includes('--repair-release-only')) {
  await runRepairReleaseSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS');
  process.exit(0);
}
if (process.argv.includes('--dust-undo-only')) {
  await runDustUndoSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS');
  process.exit(0);
}
if (process.argv.includes('--batch-pipeline-only')) {
  await runBatchPipelineSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS');
  process.exit(0);
}
if (process.argv.includes('--gain-map-only')) {
  await runExportGainMapSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS');
  process.exit(0);
}
if (process.argv.includes('--hidden-job-only')) {
  await runHiddenJobSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS');
  process.exit(0);
}
if (process.argv.includes('--memory-budget-only')) {
  await runMemoryBudgetSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS');
  process.exit(0);
}
// Opt-in: local RAW files against a baseline recorded from a reference build
// (see import-parity-smoke.mjs). Never part of the default run.
if (process.argv.includes('--import-parity-only')) {
  await runImportParitySmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS');
  process.exit(0);
}
if (process.argv.includes('--first-photo-only')) {
  await runFirstPhotoSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS');
  process.exit(0);
}
if (process.argv.includes('--png16-only')) {
  await runPng16BandSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS');
  process.exit(0);
}
if (process.argv.includes('--autoframe-import-only')) {
  await runAutoFrameImportSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}
if (process.argv.includes('--geometry-only')) {
  await runGeometrySmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}
if (process.argv.includes('--two-stage-only')) {
  await runTwoStageImportSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS (two-stage imports)'); process.exit(0);
}
if (process.argv.includes('--perf-harness-only')) {
  await runPerfHarnessSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS (perf harness)');
  process.exit(0);
}
if (process.argv.includes('--embedded-preview-only')) {
  await runEmbeddedPreviewSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS (embedded previews)'); process.exit(0);
}
if (process.argv.includes('--crop-apply-only')) {
  await runCropApplySmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}
if (process.argv.includes('--expired-only')) {
  await runExpiredFilmSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS');
  process.exit(0);
}
if (process.argv.includes('--interpretation-routes-only')) {
  await runInterpretationRoutesSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS');
  process.exit(0);
}
if (process.argv.includes('--expired-live-type-only')) {
  await runExpiredLiveTypeSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS');
  process.exit(0);
}
if (process.argv.includes('--workspace-ui-only')) {
  await runWorkspaceUiSmoke({ send, sendTo, evaluate, waitFor, fail, port: PORT, root: ROOT });
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS');
  process.exit(0);
}

// The historical JPEG fixture is a finished positive. This scenario
// deliberately exercises negative inversion, so choose the import type explicitly.
await evaluate(`document.getElementById('importFilmTypeAuto').checked && document.getElementById('importFilmTypeAuto').click()`);

// ---- 1. load the fixture through the real file input ----
if (!process.argv.includes('--studio-only') && !process.argv.includes('--auto-crop-only') && !process.argv.includes('--color-analysis-only') && !process.argv.includes('--film-edge-only') && !process.argv.includes('--darkroom-only') && !process.argv.includes('--camera-only') && !process.argv.includes('--roll-home-only') && !process.argv.includes('--technical-only')) {
const doc = await send('DOM.getDocument');
const input = await send('DOM.querySelector', {
  nodeId: doc.result.root.nodeId, selector: '#fileInput',
});
if (!input.result?.nodeId) fail('#fileInput not found');
await send('DOM.setFileInputFiles', { files: [FIXTURE], nodeId: input.result.nodeId });

await waitFor('image loaded (toolbar visible)',
  `document.getElementById('previewToolbar').style.display !== 'none'`, 90_000);
console.log('ok: image decoded and automatically converted in the only workspace');
await waitFor('automatic conversion ready', `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`,150000);

// ---- 1b. Auto Frame must actually load OpenCV (regression: opencv-js 5.x
// exposes window.cv as a thenable that the loader has to resolve) ----
await evaluate(`(() => {
  window.__frameDone = false;
  window.__frameTicks = 0;
  const timer = setInterval(() => window.__frameTicks++, 20);
  const original = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (message, ...args) {
    if (message.type === 'analyze-frame') {
      window.__frameInput = structuredClone(message);
      // The reply to this request, not the worker's request for the shared
      // OpenCV module (#252) that may come first.
      const onReply = event => {
        if (event.data?.id !== message.id) return;
        this.removeEventListener('message', onReply);
        window.__frameResult = event.data;
        window.__frameDone = true;
        clearInterval(timer);
      };
      this.addEventListener('message', onReply);
    }
    return original.call(this, message, ...args);
  };
  document.getElementById('autoFrameBtn').click();
})()`);
await waitFor('auto-frame worker result', `window.__frameDone`, 120_000);
if (await evaluate(`!!window.cv || !!document.querySelector('script[data-opencv-loader="1"]')`)) fail('auto frame loaded redundant main-thread OpenCV');
// 主スレッドとの数値比較のためにのみ、ここで別の OpenCV を明示的に初期化する。
await evaluate(`(async () => {
  const { createOpenCvLoader } = await import('/src/app/opencvLoader.js');
  const { default: url } = await import('/@fs${ROOT}/node_modules/@techstark/opencv-js/dist/opencv.js?url');
  if (!await createOpenCvLoader([url])()) throw new Error('comparison OpenCV failed');
})()`);
const frameCheck = await evaluate(`(async () => {
  if (window.__frameResult.error) throw new Error(window.__frameResult.error);
  const { detectFrameAndRotation } = await import('/src/app/autoFrameAnalyzer.js');
  const { applyRotationToImageData } = await import('/src/app/imageGeometry.js');
  const input = window.__frameInput;
  const image = new ImageData(input.rgba, input.width, input.height);
  const expected = detectFrameAndRotation(image, { ...input.options, rotateImageData: applyRotationToImageData });
  const actual = window.__frameResult.result;
  const summary = result => result && { angle: result.angle, cropRegion: result.cropRegion,
    confidence: result.confidence, diagnostics: result.diagnostics };
  return { equal: JSON.stringify(summary(expected)) === JSON.stringify(summary(actual)),
    found: !!actual?.cropRegion, ticks: window.__frameTicks, expected: summary(expected), actual: summary(actual) };
})()`);
if (!frameCheck.equal || !frameCheck.found || frameCheck.ticks < 2) fail('auto-frame worker mismatch or blocked UI: ' + JSON.stringify(frameCheck));
await drainDialogs();
await wait(500);
console.log('ok: auto-frame worker matches main-thread analysis, UI heartbeat continued');

await waitFor('auto frame ready for comparison', `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`,150000);
await evaluate(`document.getElementById('beforeAfterBtn').click()`);
const meanBefore = await previewLuminance();
await evaluate(`document.getElementById('beforeAfterBtn').click()`);
if (!Number.isFinite(meanBefore)) fail('could not measure preview luminance');
if (meanBefore < 3) fail('preview is black after load — decode may have failed');

// 暗室の再変換から共通処理を検証する。旧ステップ UI は使わない。
await waitFor('auto frame conversion ready', `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`,150000);

// ---- 3. 変換タブから再変換 ----
const fullSize = await evaluate(`({ width: window.__frameResult.result.cropRegion.width, height: window.__frameResult.result.cropRegion.height })`);
await evaluate(`document.getElementById('studioTab-conversion').click(); document.getElementById('studioRetry').click()`);
await wait(400);
await waitFor('reconversion overlay closed', `!document.querySelector('.loading-overlay.visible')`,150000);
await expectLoadingOverlayIdle({ evaluate, waitFor, fail }, 'reconversion');
const step3Expr = `document.getElementById('statusBadge').classList.contains('step3')`;
await waitFor('converted status', step3Expr, 150_000);
console.log('ok: reconversion finished in the current workspace');

// プレビュー表示直後に除塵を有効化しても原寸で処理する。
async function waitForDustSettled(description, { freshStatus = false } = {}) {
  // A detect response only supplies the mask. The app still awaits inpainting
  // before committing pixels and accepting brush input. Brush completion also
  // needs a fresh status mutation: its previous Detected status stays visible.
  await waitFor(description, `(${!freshStatus} || window.__dustStatusUpdates > 0) &&
    /^(Detected [0-9]+ dust particles|No dust detected|Error:)/.test(document.getElementById('dustStatus').textContent)`, 60_000);
  const status = await evaluate(`document.getElementById('dustStatus').textContent`);
  if (!/^(Detected [0-9]+ dust particles|No dust detected)$/.test(status)) {
    await dumpDiagnostics(description);
    fail(`${description}: ${status}`);
  }
}
await evaluate(`(() => {
  document.getElementById('studioTab-repair').click();
  window.__dustSources = [];
  window.__dustDelayedInpaintResponses = 0;
  window.__dustStatusUpdates = 0;
  window.__dustStatusObserver = new MutationObserver(() => window.__dustStatusUpdates++);
  window.__dustStatusObserver.observe(document.getElementById('dustStatus'), { childList: true });
  const workerSources = new WeakMap();
  const postDust = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (message, ...args) {
    if (['detect', 'inpaint', 'stroke'].includes(message?.type) &&
        typeof message.reuseSource === 'boolean') {
      let record = workerSources.get(this);
      if (!record) {
        record = { source: null, pending: new Map() };
        workerSources.set(this, record);
        if (${process.argv.includes('--dust-delay-inpaint')}) {
          // Optional fault injection reproduces slow CI repair delivery without
          // delaying detection, so worker-return and app-commit cannot coincide.
          const receive = this.onmessage;
          this.onmessage = event => {
            if (record.pending.get(event.data?.id)?.type === 'inpaint') {
              window.__dustDelayedInpaintResponses++;
              setTimeout(() => receive.call(this, event), 2000);
            } else receive.call(this, event);
          };
        }
        this.addEventListener('message', ({ data }) => {
          const request = record.pending.get(data.id);
          if (!request) return;
          record.pending.delete(data.id);
          if (!data.error) window.__dustSources.push(request);
        });
      }
      if (message.rgba) {
        let hash = 2166136261;
        for (const value of message.rgba) hash = Math.imul(hash ^ value, 16777619);
        record.source = { width: message.width, height: message.height, hash };
      }
      record.pending.set(message.id, { ...record.source, type: message.type });
    }
    return postDust.call(this, message, ...args);
  };
  // This scenario instruments TELEA; learned inference has its own real-model tests.
  if (document.getElementById('dustAiEnabled').checked) document.getElementById('dustAiEnabled').click();
  document.getElementById('dustRemovalEnabled').click();
})()`);
await waitFor('dust detection at full resolution', `window.__dustSources.some(source => source.type === 'detect')`, 90_000);
const dustSource = await evaluate(`window.__dustSources.find(source => source.type === 'detect')`);
if (dustSource.width !== fullSize.width || dustSource.height !== fullSize.height) {
  fail('dust detection used preview dimensions instead of full resolution');
}
await waitForDustSettled('initial dust repair committed');

// クリア後も未修復の画素を使う。画像全体のハッシュで累積修復を検出する。
await evaluate(`window.__dustSources = []; document.getElementById('dustClearMaskBtn').click()`);
await waitFor('dust mask re-detection', `window.__dustSources.some(source => source.type === 'detect')`, 30_000);
const clearedSource = await evaluate(`window.__dustSources.find(source => source.type === 'detect')`);
if (clearedSource.hash !== dustSource.hash) fail('clear mask re-detected dust on an altered source');
await waitForDustSettled('cleared dust repair committed');

// 直接ブラシが変換Workerを呼び直さずに修復することを確認する。
// #259: the pinned worker already holds both planes and the mask, so a stroke
// posts only its points; undo/redo patch in place without conversion or detection.
await evaluate(`(() => {
  window.__brushConversions = 0;
  window.__brushDetections = 0;
  window.__dustSources = [];
  window.__dustStatusUpdates = 0;
  window.__dustMessages = [];
  const size = value => {
    if (!value || typeof value !== 'object') return 0;
    if (ArrayBuffer.isView(value)) return value.byteLength;
    return Object.values(value).reduce((sum, item) => sum + size(item), 0);
  };
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (message, ...args) {
    if (message?.type === 'convert') window.__brushConversions++;
    if (message?.type === 'detect') window.__brushDetections++;
    if (['stroke', 'maskDelta', 'plane'].includes(message?.type)) {
      window.__dustMessages.push({ type: message.type, kind: message.kind, bytes: size(message),
        baseTag: message.baseTag, tag: message.tag, image16: Boolean(message.image16), mask: Boolean(message.mask) });
    }
    return post.call(this, message, ...args);
  };
  document.getElementById('dustShowMask').click();
})()`);
await waitFor('dust worker pinned with its planes', `(async () => {
  const { dustWorker } = await import('/src/app/dustWorkerClient.js');
  return dustWorker.pinned && dustWorker.maskTag !== null;
})()`, 30_000);
await wait(500);
const dustCount = text => /No dust/.test(text) ? 0 : Number(/(\d+)/.exec(text)?.[1]);
const statusBeforeStroke = dustCount(await evaluate(`document.getElementById('dustStatus').textContent`));
// #254: the brush takes pointer events on the surface on screen (the GL
// canvas stays on while the mask is shown), draws the stroke on its overlay
// and writes nothing into #canvas while it paints.
const brushBefore = await evaluate(`(async () => {
  window.__dustMessages = [];
  window.__dustStatusUpdates = 0;
  window.__ncBrush.resetCounters();
  const surface = [...document.querySelectorAll('#canvas, #glCanvas')].find(el => getComputedStyle(el).display !== 'none');
  const rect = surface.getBoundingClientRect();
  const at = (dx) => ({ bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
    clientX: rect.x + rect.width / 2 + dx, clientY: rect.y + rect.height / 2, altKey: true });
  surface.dispatchEvent(new PointerEvent('pointerdown', at(0)));
  surface.dispatchEvent(new PointerEvent('pointermove', at(3)));
  surface.dispatchEvent(new PointerEvent('pointermove', at(6)));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const during = window.__ncBrush.state();
  surface.dispatchEvent(new PointerEvent('pointerup', { ...at(6), buttons: 0 }));
  return { surface: surface.id, during, after: window.__ncBrush.state() };
})()`);
if (!brushBefore.during.feedback.drawing || brushBefore.during.feedback.counters.frames < 1 || brushBefore.during.feedback.points < 2) {
  fail('the dust brush did not draw its stroke on the feedback overlay: ' + JSON.stringify(brushBefore.during.feedback));
}
if (brushBefore.during.canvasWrites.put || brushBefore.during.canvasWrites.draw) {
  fail('the dust brush wrote into #canvas while painting: ' + JSON.stringify(brushBefore.during.canvasWrites));
}
if (!brushBefore.during.containerClass) fail('the view did not take touch-action: none for the dust brush');
if (brushBefore.after.feedback.drawing) fail('pen-up did not end the overlay stroke');
await waitFor('dust brush stroke', `window.__dustSources.some(source => source.type === 'stroke')`, 30_000);
await waitForDustSettled('dust brush repair committed', { freshStatus: true });
if (await evaluate(`window.__brushConversions !== 0`)) fail('dust brush reconverted the full image');
if (await evaluate(`document.getElementById('dustStatus').textContent.startsWith('Error:')`)) {
  fail('dust brush reported an error');
}
const strokeMessages = await evaluate(`window.__dustMessages.filter(message => message.type === 'stroke')`);
if (strokeMessages.length !== 1 || strokeMessages[0].bytes > 1024 * 1024 || strokeMessages[0].image16 || strokeMessages[0].mask) {
  fail('a pinned dust stroke must post only its points: ' + JSON.stringify(strokeMessages));
}
const statusAfterStroke = dustCount(await evaluate(`document.getElementById('dustStatus').textContent`));
// Undo and redo of a stroke apply its bytes in place: no conversion, no new detection.
await evaluate(`window.__dustMessages = []; window.__brushDetections = 0; document.getElementById('undoBtn').click()`);
await wait(1500);
const undoState = await evaluate(`({ conversions: window.__brushConversions, detections: window.__brushDetections,
  status: document.getElementById('dustStatus').textContent, messages: window.__dustMessages })`);
if (undoState.conversions !== 0 || undoState.detections !== 0) fail('undoing a dust stroke re-converted or re-detected: ' + JSON.stringify(undoState));
if (dustCount(undoState.status) !== statusBeforeStroke) fail(`undo did not restore the particle count: ${undoState.status} vs ${statusBeforeStroke}`);
const followed = undoState.messages.find(message => message.type === 'maskDelta');
if (!followed || followed.baseTag !== strokeMessages[0].tag || followed.tag !== strokeMessages[0].baseTag) {
  fail('the worker did not follow the undone mask: ' + JSON.stringify(undoState.messages));
}
await evaluate(`window.__dustMessages = []; document.getElementById('redoBtn').click()`);
await wait(1500);
const redoState = await evaluate(`({ conversions: window.__brushConversions, detections: window.__brushDetections,
  status: document.getElementById('dustStatus').textContent, messages: window.__dustMessages })`);
if (redoState.conversions !== 0 || redoState.detections !== 0 || dustCount(redoState.status) !== statusAfterStroke) {
  fail('redoing a dust stroke re-converted, re-detected or lost its count: ' + JSON.stringify(redoState));
}
// #254: a finger paints a dust-brush stroke: pointer events, captured, with
// touch-action: none on the view, and the photo does not pan.
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
try {
  const touchAt = await evaluate(`(() => {
    const surface = [...document.querySelectorAll('#canvas, #glCanvas')].find(el => getComputedStyle(el).display !== 'none');
    const r = surface.getBoundingClientRect();
    window.__dustSources = [];
    window.__dustStatusUpdates = 0;
    return { x: r.x + r.width * 0.3, y: r.y + r.height * 0.3, transform: document.getElementById('canvasTransformWrapper').style.transform };
  })()`);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchAt.x, y: touchAt.y }] });
  await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touchAt.x + 20, y: touchAt.y + 4 }] });
  const touching = await evaluate(`(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return window.__ncBrush.state();
  })()`);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  if (!touching.feedback.drawing || touching.feedback.points < 2 || !touching.containerClass) {
    fail('a touch drag did not paint a dust-brush stroke: ' + JSON.stringify(touching.feedback));
  }
  await waitFor('touch dust stroke', `window.__dustSources.some(source => source.type === 'stroke')`, 30_000);
  await waitForDustSettled('touch dust stroke committed', { freshStatus: true });
  const transformAfter = await evaluate(`document.getElementById('canvasTransformWrapper').style.transform`);
  if (transformAfter !== touchAt.transform) fail('the touch dust brush panned the photo: ' + JSON.stringify({ before: touchAt.transform, after: transformAfter }));
} finally {
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
}
// #242/#253/#254: the dust-mask view of a repaired, full-resolution frame is
// drawn at display size: the tint, max-pooled at the display frame's size, on
// the display overlay over the photo, which stays on the GL display (or
// #canvas without WebGL).
const dustDisplay = await evaluate(`window.__ncDisplay.frame()`);
const displaySize = JSON.stringify(dustDisplay.display);
const dustBrushState = await evaluate(`window.__ncBrush.state()`);
const dustFrameOk = dustDisplay.surface === 'gl'
  ? JSON.stringify(dustDisplay.canvases.gl) === displaySize && dustDisplay.canvases.main.join('x') === '1x1'
  : JSON.stringify(dustDisplay.canvases.main) === displaySize && JSON.stringify(dustDisplay.handle) === displaySize;
if (!dustFrameOk || JSON.stringify(dustDisplay.canvases.overlay) !== displaySize
  || JSON.stringify(dustDisplay.canvases.dustTint) !== displaySize || !dustBrushState.tint?.current
  || dustDisplay.display[0] * dustDisplay.display[1] > 4_000_000) {
  fail('the dust-mask view is not drawn at display size: ' + JSON.stringify({ dustDisplay, layer: dustBrushState.layer, tint: dustBrushState.tint }));
}
if (dustBrushState.webgl !== (dustDisplay.surface === 'gl')) fail('the dust mask turned the GPU display off: ' + JSON.stringify(dustBrushState));
const overlayPixels = dustBrushState.feedback.width * dustBrushState.feedback.height;
const containerPixels = await evaluate(`(() => { const c = document.getElementById('canvasContainer'); const d = window.devicePixelRatio || 1; return Math.ceil(c.clientWidth * d) * Math.ceil(c.clientHeight * d); })()`);
if (overlayPixels > containerPixels) fail(`the brush overlay is larger than the view: ${overlayPixels} > ${containerPixels}`);
console.log(`ok: dust detection ${dustSource.width}x${dustSource.height}, clean-source reset, pinned regional brush (${strokeMessages[0].bytes} B stroke, pointer events, overlay only while painting), in-place undo/redo, display-size mask view ${displaySize} on ${dustDisplay.surface}`);
// 後続の色調検証ではマスクの色を重ねない。
await evaluate(`window.__dustStatusObserver.disconnect(); document.getElementById('dustShowMask').click()`);
if (await evaluate(`import('/src/app/dustWorkerClient.js').then(({ dustWorker }) => dustWorker.pinned)`)) {
  fail('hiding the dust mask must release the dust worker pin');
}
if (process.argv.includes('--dust-delay-inpaint')) {
  const delayed = await evaluate(`window.__dustDelayedInpaintResponses`);
  if (delayed < 2) fail(`dust delay injection missed detection repairs: ${delayed}`);
  console.log(`ok: ${delayed} delayed inpaint responses settled before subsequent dust actions`);
}
if (process.argv.includes('--dust-only')) {
  if (pageErrors.filter(e => !/ResizeObserver loop/.test(e)).length) fail(pageErrors.join('\n'));
  console.log('SMOKE PASS'); process.exit(0);
}

// ---- 4. the on-screen preview must have changed (negative -> positive) ----
await wait(1500); // allow the final render to composite
const meanAfter = await previewLuminance();
console.log(`ok: mean luminance ${meanBefore.toFixed(1)} -> ${meanAfter.toFixed(1)}`);
if (meanAfter < 3) fail('preview is black after conversion — rendering is broken');
if (Math.abs(meanAfter - meanBefore) < 8) {
  fail('preview barely changed after conversion — pipeline may be broken');
}

// ---- 5. curve editor: drag the midtones up, preview must brighten/change ----
// 調色タブの曲線を開く。旧パネルモードには依存しない。
// No resize event: the curve's ResizeObserver draws it when the drawer first
// gives it a size (#261).
await evaluate(`document.getElementById('studioTab-edit').click(); document.getElementById('studioCurves').open = true;`);
await wait(300);
const curveRevealed = await evaluate(`(() => {
  const curve = document.getElementById('curveCanvas');
  return { width: curve.width, height: curve.height, cssWidth: curve.offsetWidth, cssHeight: curve.offsetHeight,
    alpha: curve.width ? curve.getContext('2d').getImageData(curve.width >> 1, curve.height >> 1, 1, 1).data[3] : 0 };
})()`);
if (!(curveRevealed.cssWidth > 0 && curveRevealed.width === curveRevealed.cssWidth * 2
  && curveRevealed.height === curveRevealed.cssHeight * 2 && curveRevealed.alpha === 255)) {
  fail('curve editor is blank when its drawer is first opened: ' + JSON.stringify(curveRevealed));
}
await evaluate(`(() => {
  const content = document.getElementById('additionalSectionContent');
  if (content.classList.contains('collapsed')) {
    document.querySelector('#additionalSection .section-header').click();
  }
})()`);
await wait(300);
await evaluate(`document.getElementById('curveCanvas').scrollIntoView({ block: 'center' })`);
await wait(300);
const curveRect = await evaluate(`(() => {
  const r = document.getElementById('curveCanvas').getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
})()`);
if (!curveRect.width) fail('curve canvas not visible in Advanced section');
if (curveRect.y < 0 || curveRect.y + curveRect.height > 900) {
  fail(`curve canvas still outside viewport (y=${curveRect.y})`);
}

const cx = curveRect.x + curveRect.width / 2;
const cy = curveRect.y + curveRect.height / 2;
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', clickCount: type === 'mousePressed' ? 1 : 0,
  buttons: type === 'mouseReleased' ? 0 : 1, ...extra,
});
await mouse('mousePressed', cx, cy);
for (let step = 1; step <= 6; step++) {
  await mouse('mouseMoved', cx, cy - (curveRect.height * 0.3 * step) / 6);
  await wait(60);
}
await mouse('mouseReleased', cx, cy - curveRect.height * 0.3);
await wait(2500); // full-res reprocess after drag

const meanCurved = await previewLuminance();
console.log(`ok: curve drag luminance ${meanAfter.toFixed(1)} -> ${meanCurved.toFixed(1)}`);
if (Math.abs(meanCurved - meanAfter) < 3) {
  fail('preview did not react to curve edit — curve pipeline may be broken');
}

// ============================================================
// Batch scenario: two files -> convert -> apply to selected ->
// switch file -> export ZIP (real download, verified with JSZip)
// ============================================================

// input→changeの通常順序でも、撤回・やり直しが元の選択値を保持する。
const selectHistory = await evaluate(`(() => {
  const select = document.getElementById('coreCurvePrecision');
  const original = select.value;
  const next = [...select.options].find(option => option.value !== original).value;
  select.value = next;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('undoBtn').click();
  const undone = select.value;
  document.getElementById('redoBtn').click();
  const redone = select.value;
  document.getElementById('undoBtn').click();
  return { original, next, undone, redone };
})()`);
if (selectHistory.original !== selectHistory.undone || selectHistory.next !== selectHistory.redone) {
  fail('select undo/redo did not preserve pre-change state');
}
console.log('ok: select undo/redo restores both values');

// Fresh app, two files through the real input
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?lang=en` });
await waitFor('app reboot', `!!document.getElementById('studioImportAutoCrop')`);
await installDialogAutoAccept();
await wait(1500);
await evaluate(`document.getElementById('studioImportAutoCrop').click()`);
// Force the JSZip download fallback (the Firefox/Safari path):
// showSaveFilePicker requires a real user gesture, which synthetic
// clicks cannot provide.
await evaluate(`(() => { try { delete window.showSaveFilePicker; } catch {} return true; })()`);
const doc2 = await send('DOM.getDocument');
const input2 = await send('DOM.querySelector', {
  nodeId: doc2.result.root.nodeId, selector: '#fileInput',
});
await send('DOM.setFileInputFiles', { files: [FIXTURE, FIXTURE2], nodeId: input2.result.nodeId });

await waitFor('batch file list',
  `document.getElementById('fileListSection').style.display !== 'none'
   && document.querySelectorAll('.file-list-item').length === 2`, 90_000);
console.log('ok: batch mode, 2 files listed');

await waitFor('batch automatic conversion', `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`,180000);
await waitFor('Step 3 (batch)',
  `document.getElementById('statusBadge').classList.contains('step3')`, 180_000);
console.log('ok: first file converted in batch mode');

// Persist settings for the current file, then copy them to every selected file
await waitFor('batch step-3 actions',
  `document.getElementById('saveSettingsBtn').style.display !== 'none'`, 30_000);
await evaluate(`document.getElementById('saveSettingsBtn').click()`);
await wait(400);
await evaluate(`document.getElementById('applyToSelectedBtn').click()`);
await wait(600);
const settingsBadges = await evaluate(
  `document.querySelectorAll('.file-list-settings-badge').length`);
if (settingsBadges < 2) {
  await dumpDiagnostics('apply to selected');
  fail(`expected settings badges on both files, saw ${settingsBadges}`);
}
console.log('ok: settings applied to both files');

// Switch to the second file — exercises persist/restore of settings
await evaluate(`document.querySelector('.file-list-name[data-index="1"]').click()`);
await waitFor('second file active',
  `document.querySelector('.file-list-name[data-index="1"]').closest('.file-list-item').classList.contains('active')`, 90_000);
console.log('ok: switched to second file');

// Export all files. Without showSaveFilePicker the app intentionally falls
// back from streaming ZIP to individual <a download> clicks (the
// Firefox/Safari path). Headless Chrome does not reliably materialize
// anchor-click downloads, so capture the blobs in-page instead — the whole
// app pipeline (convert, encode, name) still runs for real.
await evaluate(`(() => {
  window.__downloads = [];
  const pendingUrls = new Set();
  const origRevoke = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = (url) => { if (!pendingUrls.has(url)) origRevoke(url); };
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && this.href.startsWith('blob:')) {
      const href = this.href;
      const name = this.download;
      pendingUrls.add(href);
      window.__downloads.push(
        fetch(href).then((r) => r.arrayBuffer()).then((buf) => {
          pendingUrls.delete(href);
          origRevoke(href);
          return { name, size: buf.byteLength, head: [...new Uint8Array(buf.slice(0, 8))] };
        })
      );
      return;
    }
    return origClick.call(this);
  };
  return true;
})()`);

const zipDisabled = await evaluate(`document.getElementById('exportZipBtn').disabled`);
if (zipDisabled) fail('Export ZIP button is disabled with 2 selected files');
await evaluate(`document.getElementById('exportZipBtn').click()`);

await waitFor('batch export downloads', `window.__downloads.length >= 2`, 180_000);
const downloads = await evaluate(`Promise.all(window.__downloads)`);
for (const d of downloads) {
  const isPng = d.head[0] === 0x89 && d.head[1] === 0x50 && d.head[2] === 0x4e && d.head[3] === 0x47;
  const isZip = d.head[0] === 0x50 && d.head[1] === 0x4b;
  if (!isPng && !isZip) fail(`exported file ${d.name} is neither PNG nor ZIP`);
  if (d.size < 10_000) fail(`exported file ${d.name} is suspiciously small (${d.size} bytes)`);
}
console.log(`ok: batch export produced ${downloads.length} files: ${downloads.map((d) => `${d.name} (${Math.round(d.size / 1024)}kB)`).join(', ')}`);

// 保存済み設定を持つ破損ファイルへ切り替えても、表示中の画像を変更しない。
await wait(800);
await evaluate(`(() => {
  const originalCreate = document.createElement.bind(document);
  document.createElement = function (tag, ...args) {
    const element = originalCreate(tag, ...args);
    if (tag === 'input') element.click = function () {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['broken image'], 'broken.png', { type: 'image/png' }));
      this.files = transfer.files;
      this.dispatchEvent(new Event('change'));
    };
    return element;
  };
  try { document.getElementById('addMoreFilesBtn').click(); }
  finally { document.createElement = originalCreate; }
})()`);
await evaluate(`document.getElementById('convertBtn').click()`);
await waitFor('settings before failed-switch test', `document.getElementById('filmSettingsSection').style.display !== 'none'`);
await evaluate(`document.getElementById('applyConvertBtn').click()`);
await waitFor('conversion before failed-switch test', `document.getElementById('statusBadge').classList.contains('step3')`);
await wait(1500);
await evaluate(`document.getElementById('applyToSelectedBtn').click()`);
await drainDialogs();
await waitFor('third file with settings', `document.querySelectorAll('.file-list-settings-badge').length === 3`);
// 原寸化は非同期。プレビュー→原寸の更新を「失敗した切替による破損」と誤認しない。
const failureProbeSize = await evaluate(`(async () => {
  const bitmap = await createImageBitmap(await (await fetch('/test-fixtures/negative-sample-2.jpg')).blob());
  const size = [bitmap.width, bitmap.height]; bitmap.close(); return size;
})()`);
// #canvas holds a display-size frame (none while WebGL presents, #242): the
// frame and the image it shows come from the app's display probe.
await waitFor('full-resolution frame before failed switch', `(() => { const f = window.__ncDisplay.frame(); return f.exact && f.width === ${failureProbeSize[0]} && f.height === ${failureProbeSize[1]}; })()`, 30_000);
const canvasFingerprint = `(() => {
  const f = window.__ncDisplay.frame();
  return [f.width, f.height, window.__ncDisplay.imageHash()];
})()`;
const beforeFailure = await evaluate(canvasFingerprint);
// Display order follows file modification time, not append/queue order.
// Address the corrupt fixture by its stable source index, wherever it appears.
await evaluate(`document.querySelector('.file-list-name[data-index="2"]').click()`);
await waitFor('failed file marked', `!!document.querySelector('.file-list-name[data-index="2"]')?.closest('.file-list-item').querySelector('.file-list-status.error')`);
const restoredIndex = await evaluate(`Number(document.querySelector('.file-list-item.active .file-list-name')?.dataset.index ?? -1)`);
const afterFailure = await evaluate(canvasFingerprint);
if (restoredIndex !== 1 || JSON.stringify(beforeFailure) !== JSON.stringify(afterFailure)) {
  fail('failed file switch changed the active image or queue index: ' + JSON.stringify({ beforeFailure, afterFailure, restoredIndex }));
}
console.log('ok: failed decode preserves the previous image and active file');
}

await runPerformanceUiSmoke({ evaluate, fail });
await runRawPostDecodeSmoke({ evaluate, fail });
await runRollFrameSmoke({ evaluate, fail });
if (!process.argv.some(arg => arg.endsWith('-only'))) {
  await runSilverCoreCacheSmoke({ evaluate, fail });
  await runComparePreviewSmoke({ send, evaluate, waitFor, wait, fail, port: PORT });
  await runRestartRenderSmoke({ send, evaluate, waitFor, fail, port: PORT });
  await runPhotoSessionSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port: PORT });
  await runPhotoHeapSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port: PORT });
  await runDisplaySessionSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port: PORT });
  await runPhotoActivationSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT });
  await runWebglPreviewSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port: PORT });
  await runPreviewTierSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port: PORT });
  await runStudioSyncSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT });
  await runPreviewPathSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port: PORT });
  await runGpuPreviewSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port: PORT });
  await runDisplayModesSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port: PORT });
  await runZoomDetailSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port: PORT });
}
if (!process.argv.includes('--auto-crop-only') && !process.argv.includes('--color-analysis-only') && !process.argv.includes('--film-edge-only') && !process.argv.includes('--darkroom-only') && !process.argv.includes('--camera-only') && !process.argv.includes('--roll-home-only') && !process.argv.includes('--technical-only')) await runStudioSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, fixtures: [FIXTURE, FIXTURE2], root: ROOT });
if (!process.argv.includes('--color-analysis-only') && !process.argv.includes('--film-edge-only') && !process.argv.includes('--darkroom-only') && !process.argv.includes('--camera-only') && !process.argv.includes('--roll-home-only') && !process.argv.includes('--technical-only')) await runStudioAutoCropSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT });
if (!process.argv.includes('--film-edge-only') && !process.argv.includes('--darkroom-only') && !process.argv.includes('--camera-only') && !process.argv.includes('--roll-home-only') && !process.argv.includes('--technical-only')) await runStudioColorAnalysisSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT });
if (!process.argv.includes('--darkroom-only') && !process.argv.includes('--camera-only') && !process.argv.includes('--roll-home-only') && !process.argv.includes('--technical-only')) {
  await runFilmEdgeSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
  await runRollAnalysisSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
  await runLightTableSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
}
if (!process.argv.includes('--film-edge-only') && !process.argv.includes('--camera-only') && !process.argv.includes('--roll-home-only') && !process.argv.includes('--technical-only')) await runDarkroomSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
if (!process.argv.includes('--film-edge-only') && !process.argv.includes('--darkroom-only') && !process.argv.includes('--roll-home-only') && !process.argv.includes('--technical-only')) await runCameraSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
if (!process.argv.includes('--film-edge-only') && !process.argv.includes('--darkroom-only') && !process.argv.includes('--camera-only') && !process.argv.includes('--technical-only')) await runRollHomeSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
if (!process.argv.includes('--film-edge-only') && !process.argv.includes('--darkroom-only') && !process.argv.includes('--camera-only') && !process.argv.includes('--roll-home-only')) await runTechnicalDepthSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
if (!process.argv.includes('--film-edge-only') && !process.argv.includes('--darkroom-only') && !process.argv.includes('--camera-only') && !process.argv.includes('--roll-home-only') && !process.argv.includes('--technical-only')) await runWorkspaceUiSmoke({ send, sendTo, evaluate, waitFor, fail, port: PORT, root: ROOT });
if (process.env.AUTOFRAME_RAW_DIR) await runStudioRawAutoFrameSmoke({ send, evaluate, waitFor, fail, port: PORT, root: ROOT, directory: process.env.AUTOFRAME_RAW_DIR });

if (!process.argv.some(arg => arg.endsWith('-only'))) await runPositiveImportSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT });
if (!process.argv.some(arg => arg.endsWith('-only'))) await runBwRollImportSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT });
if (!process.argv.some(arg => arg.endsWith('-only'))) await runExpiredFilmSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
if (!process.argv.some(arg => arg.endsWith('-only'))) await runNativeFilmFontSmoke({ send, evaluate, waitFor, wait, fail, port: PORT, root: ROOT });
if (!process.argv.some(arg => arg.endsWith('-only'))) await runExportGainMapSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
if (!process.argv.some(arg => arg.endsWith('-only'))) await runPng16BandSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
if (!process.argv.some(arg => arg.endsWith('-only'))) await runExportOwnershipSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
if (!process.argv.some(arg => arg.endsWith('-only'))) await runRepairReleaseSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
if (!process.argv.some(arg => arg.endsWith('-only'))) await runDustUndoSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
if (!process.argv.some(arg => arg.endsWith('-only'))) await runBatchPipelineSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });

if (!process.argv.some(arg => arg.endsWith('-only'))) await runSimplicitySmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });

if (!process.argv.some(arg => arg.endsWith('-only'))) await runRollFilmTypeSmoke({send,evaluate,waitFor,wait,fail,installDialogAutoAccept,port:PORT});
if (!process.argv.some(arg => arg.endsWith('-only'))) await runFolderImportSmoke({send,evaluate,waitFor,wait,fail,installDialogAutoAccept,port:PORT,root:ROOT});
if (!process.argv.some(arg => arg.endsWith('-only'))) await runPhotoSortSmoke({send,evaluate,waitFor,wait,fail,installDialogAutoAccept,port:PORT,root:ROOT});
if (!process.argv.some(arg => arg.endsWith('-only'))) await runHiddenJobSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
if (!process.argv.some(arg => arg.endsWith('-only'))) await runMemoryBudgetSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
if (!process.argv.some(arg => arg.endsWith('-only'))) await runGeometrySmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
if (!process.argv.some(arg => arg.endsWith('-only'))) await runAutoFrameImportSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT });
if (!process.argv.some(arg => arg.endsWith('-only'))) await runPerfHarnessSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
if (!process.argv.some(arg => arg.endsWith('-only'))) await runTwoStageImportSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
if (!process.argv.some(arg => arg.endsWith('-only'))) await runFirstPhotoSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });
if (!process.argv.some(arg => arg.endsWith('-only'))) await runEmbeddedPreviewSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT });
if (!process.argv.some(arg => arg.endsWith('-only'))) await runCropApplySmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT });
if (!process.argv.some(arg => arg.endsWith('-only'))) await runIsolationSmoke({ send, sendTo, onCdpEvent, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, root: ROOT });

// ---- nothing the isolated page loads is blocked (#264) ----
if (isolationBlocks.length) fail(`requests blocked by COEP/CORP/COOP:\n${isolationBlocks.join('\n')}`);

// ---- no uncaught page errors across both scenarios ----
const realErrors = pageErrors.filter((e) => !/ResizeObserver loop/.test(e));
if (realErrors.length) {
  fail(`uncaught page errors:\n${realErrors.join('\n---\n')}`);
}

console.log('SMOKE PASS');
process.exit(0);
