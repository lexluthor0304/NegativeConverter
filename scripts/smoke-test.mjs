// End-to-end smoke test: drives the real app in headless Chrome via CDP.
//
//   node scripts/smoke-test.mjs
//
// Vite 起動 → 実際の入力から写真を読み込み → Studio 自動変換 → 調整・一括書き出し。
// Asserts the canvas pixels actually changed (negative inverted) and that no
// uncaught page errors occurred. Requires Google Chrome on this machine.
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runStudioSmoke } from './studio-smoke.mjs';
import { runStudioAutoCropSmoke } from './studio-auto-crop-smoke.mjs';
import { runStudioColorAnalysisSmoke } from './studio-color-analysis-smoke.mjs';
import { runWorkspaceUiSmoke } from './workspace-ui-smoke.mjs';

// UPNG is already a runtime dependency of the app; reuse it to decode screenshots.
const UPNG = createRequire(import.meta.url)('upng-js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'negative2positive', 'test-fixtures', 'negative-sample.jpg');
const FIXTURE2 = join(ROOT, 'negative2positive', 'test-fixtures', 'negative-sample-2.jpg');
const PORT = 5197;
const CDP_PORT = 9224;
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
const chrome = execFile(chromeBin, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${chromeProfileDir}`,
  '--no-first-run', '--hide-scrollbars', '--window-size=1440,900',
  'about:blank',
]);
children.push(chrome);

async function getWsUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      const page = (await res.json()).find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await wait(250);
  }
  fail('chrome did not expose CDP');
}

const ws = new WebSocket(await getWsUrl());
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let msgId = 0;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push(msg.params?.exceptionDetails?.exception?.description
      || msg.params?.exceptionDetails?.text || 'unknown exception');
  }
  if (msg.method === 'Page.javascriptDialogOpening') {
    // The guide flow uses alert(); with the Page domain enabled the dialog
    // blocks the renderer until we acknowledge it.
    const text = msg.params?.message || '';
    console.log(`dialog auto-accepted: ${text.slice(0, 120)}`);
    if (/OpenCV/i.test(text)) {
      pageErrors.push(`OpenCV load failure dialog: ${text.slice(0, 200)}`);
    }
    ws.send(JSON.stringify({
      id: ++msgId,
      method: 'Page.handleJavaScriptDialog',
      params: { accept: true },
    }));
  }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++msgId;
  pending.set(id, (m) => resolve(m));
  ws.send(JSON.stringify({ id, method, params }));
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
await send('Runtime.enable');
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?lang=en` });
await waitFor('app boot', `!!document.getElementById('studioImportAutoCrop')`);
await installDialogAutoAccept();
await wait(1500); // let main.js finish wiring
await evaluate(`document.getElementById('studioImportAutoCrop').click()`);

// ---- 1. load the fixture through the real file input ----
if (!process.argv.includes('--studio-only') && !process.argv.includes('--auto-crop-only') && !process.argv.includes('--color-analysis-only')) {
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
      this.addEventListener('message', event => {
        window.__frameResult = event.data;
        window.__frameDone = true;
        clearInterval(timer);
      }, { once: true });
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
    found: !!actual?.cropRegion, ticks: window.__frameTicks };
})()`);
if (!frameCheck.equal || !frameCheck.found || frameCheck.ticks < 2) fail('auto-frame worker mismatch or blocked UI');
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
const step3Expr = `document.getElementById('statusBadge').classList.contains('step3')`;
await waitFor('converted status', step3Expr, 150_000);
console.log('ok: reconversion finished in the current workspace');

// プレビュー表示直後に除塵を有効化しても原寸で処理する。
await evaluate(`(() => {
  document.getElementById('studioTab-repair').click();
  window.__dustSources = [];
  const original = window.cv.matFromImageData;
  window.cv.matFromImageData = function (image) {
    let hash = 2166136261;
    for (const value of image.data) hash = Math.imul(hash ^ value, 16777619);
    window.__dustSources.push({ width: image.width, height: image.height, hash });
    return original.call(this, image);
  };
  document.getElementById('dustRemovalEnabled').click();
})()`);
await waitFor('dust detection at full resolution', `window.__dustSources.length > 0`, 90_000);
const dustSource = await evaluate(`window.__dustSources[0]`);
if (dustSource.width !== fullSize.width || dustSource.height !== fullSize.height) {
  fail('dust detection used preview dimensions instead of full resolution');
}
await wait(500);

// クリア後も未修復の画素を使う。画像全体のハッシュで累積修復を検出する。
await evaluate(`window.__dustSources = []; document.getElementById('dustClearMaskBtn').click()`);
await waitFor('dust mask re-detection', `window.__dustSources.length > 0`, 30_000);
const clearedSource = await evaluate(`window.__dustSources[0]`);
if (clearedSource.hash !== dustSource.hash) fail('clear mask re-detected dust on an altered source');

// 直接ブラシが変換Workerを呼び直さずに修復することを確認する。
await evaluate(`(() => {
  window.__brushConversions = 0;
  window.__dustSources = [];
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (message, ...args) {
    if (message?.type === 'convert') window.__brushConversions++;
    return post.call(this, message, ...args);
  };
  document.getElementById('dustShowMask').click();
  const canvas = document.getElementById('canvas');
  const rect = canvas.getBoundingClientRect();
  const options = { bubbles: true, clientX: rect.x + rect.width / 2,
    clientY: rect.y + rect.height / 2, button: 0, altKey: true };
  canvas.dispatchEvent(new MouseEvent('mousedown', options));
  document.dispatchEvent(new MouseEvent('mouseup', options));
})()`);
await waitFor('dust brush inpaint', `window.__dustSources.length > 0`, 30_000);
if (await evaluate(`window.__brushConversions !== 0`)) fail('dust brush reconverted the full image');
if (await evaluate(`document.getElementById('dustStatus').textContent.startsWith('Error:')`)) {
  fail('dust brush reported an error');
}
console.log(`ok: dust detection ${dustSource.width}x${dustSource.height}, clean-source reset, brush without reconversion`);
// 後続の色調検証ではマスクの色を重ねない。
await evaluate(`document.getElementById('dustShowMask').click()`);

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
await evaluate(`document.getElementById('studioTab-edit').click(); document.getElementById('studioCurves').open = true; window.dispatchEvent(new Event('resize'));`);
await wait(300);
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
await evaluate(`document.querySelectorAll('.file-list-item')[1].click()`);
await waitFor('second file active',
  `document.querySelectorAll('.file-list-item')[1].classList.contains('active')`, 90_000);
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
await waitFor('full-resolution canvas before failed switch', `document.getElementById('canvas').width === ${failureProbeSize[0]} && document.getElementById('canvas').height === ${failureProbeSize[1]}`, 30_000);
const canvasFingerprint = `(() => {
  const c = document.getElementById('canvas');
  const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let hash = 2166136261;
  for (const value of data) hash = Math.imul(hash ^ value, 16777619);
  return [c.width, c.height, hash];
})()`;
const beforeFailure = await evaluate(canvasFingerprint);
await evaluate(`document.querySelectorAll('.file-list-item')[2].click()`);
await waitFor('failed file marked', `!!document.querySelectorAll('.file-list-item')[2]?.querySelector('.file-list-status.error')`);
const restoredIndex = await evaluate(`[...document.querySelectorAll('.file-list-item')].findIndex(item => item.classList.contains('active'))`);
const afterFailure = await evaluate(canvasFingerprint);
if (restoredIndex !== 1 || JSON.stringify(beforeFailure) !== JSON.stringify(afterFailure)) {
  fail('failed file switch changed the active image or queue index: ' + JSON.stringify({ beforeFailure, afterFailure, restoredIndex }));
}
console.log('ok: failed decode preserves the previous image and active file');
}

if (!process.argv.includes('--auto-crop-only') && !process.argv.includes('--color-analysis-only')) await runStudioSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT, fixtures: [FIXTURE, FIXTURE2], root: ROOT });
if (!process.argv.includes('--color-analysis-only')) await runStudioAutoCropSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT });
await runStudioColorAnalysisSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port: PORT });
await runWorkspaceUiSmoke({ send, evaluate, waitFor, fail, port: PORT, root: ROOT });

// ---- no uncaught page errors across both scenarios ----
const realErrors = pageErrors.filter((e) => !/ResizeObserver loop/.test(e));
if (realErrors.length) {
  fail(`uncaught page errors:\n${realErrors.join('\n---\n')}`);
}

console.log('SMOKE PASS');
process.exit(0);
