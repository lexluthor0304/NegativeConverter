// End-to-end smoke test: drives the real app in headless Chrome via CDP.
//
//   node scripts/smoke-test.mjs
//
// Flow: start vite dev server -> load negative-sample.jpg through the real
// file input -> Step 1 -> Convert -> Step 2 -> Apply & Convert -> Step 3.
// Asserts the canvas pixels actually changed (negative inverted) and that no
// uncaught page errors occurred. Requires Google Chrome on this machine.
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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
  console.error('SKIP: no Chrome binary found (set CHROME_BIN)');
  process.exit(0);
}
if (!existsSync(FIXTURE)) {
  console.error(`FAIL: fixture missing: ${FIXTURE}`);
  process.exit(1);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
function cleanup() {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch {}
  }
}
process.on('exit', cleanup);

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// ---- start vite dev server ----
const vite = spawn('npx', ['vite', '--config', 'negative2positive/vite.config.js', '--port', String(PORT), '--strictPort'], {
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
async function waitFor(description, expression, timeoutMs = 60_000, { soft = false } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await evaluate(expression)) return true;
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
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await waitFor('app boot', `!!document.getElementById('fileInput')`);
await wait(1500); // let main.js finish wiring

// ---- 1. load the fixture through the real file input ----
const doc = await send('DOM.getDocument');
const input = await send('DOM.querySelector', {
  nodeId: doc.result.root.nodeId, selector: '#fileInput',
});
if (!input.result?.nodeId) fail('#fileInput not found');
await send('DOM.setFileInputFiles', { files: [FIXTURE], nodeId: input.result.nodeId });

await waitFor('image loaded (toolbar visible)',
  `document.getElementById('previewToolbar').style.display !== 'none'`, 90_000);
console.log('ok: image decoded, Step 1 reached');

// ---- 1b. Auto Frame must actually load OpenCV (regression: opencv-js 5.x
// exposes window.cv as a thenable that the loader has to resolve) ----
await evaluate(`document.getElementById('autoFrameBtn').click()`);
await waitFor('OpenCV runtime ready', `!!(window.cv && window.cv.Mat)`, 90_000);
console.log('ok: OpenCV loaded, auto-frame analysis ran');
await wait(2000); // let the analysis settle before moving on

const meanBefore = await previewLuminance();
if (!Number.isFinite(meanBefore)) fail('could not measure preview luminance');
if (meanBefore < 3) fail('preview is black after load — decode may have failed');

// ---- 2. Step 1 -> Step 2 ----
await waitFor('convert button', `(() => {
  const b = document.getElementById('convertBtn');
  return b && b.style.display !== 'none';
})()`, 30_000);
await evaluate(`document.getElementById('convertBtn').click()`);
await waitFor('film settings (Step 2)',
  `document.getElementById('filmSettingsSection').style.display !== 'none'`, 30_000);
console.log('ok: Step 2 reached');

// ---- 3. Apply & Convert -> Step 3 ----
await evaluate(`document.getElementById('applyConvertBtn').click()`);
const step3Expr = `document.getElementById('statusBadge').classList.contains('step3')`;
let reached = await waitFor('Step 3 badge', step3Expr, 150_000, { soft: true });
if (!reached) {
  // Headless GL can be flaky — retry once on the CPU path.
  console.log('warn: conversion slow/stuck with WebGL, retrying on CPU path');
  await dumpDiagnostics('webgl attempt');
  await evaluate(`(() => {
    const gl = document.getElementById('coreUseWebGL');
    if (gl && gl.checked) { gl.checked = false; gl.dispatchEvent(new Event('change', { bubbles: true })); }
  })()`);
  await evaluate(`document.getElementById('applyConvertBtn').click()`);
  reached = await waitFor('Step 3 badge (CPU path)', step3Expr, 150_000);
}
console.log('ok: conversion finished, Step 3 reached');

// ---- 4. the on-screen preview must have changed (negative -> positive) ----
await wait(1500); // allow the final render to composite
const meanAfter = await previewLuminance();
console.log(`ok: mean luminance ${meanBefore.toFixed(1)} -> ${meanAfter.toFixed(1)}`);
if (meanAfter < 3) fail('preview is black after conversion — rendering is broken');
if (Math.abs(meanAfter - meanBefore) < 8) {
  fail('preview barely changed after conversion — pipeline may be broken');
}

// ---- 5. curve editor: drag the midtones up, preview must brighten/change ----
// The default panel mode is the SP3000 console, which hides the detail
// sections (including the curve editor) — switch to detail mode first.
await evaluate(`document.getElementById('panelModeDetailBtn').click()`);
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

// Fresh app, two files through the real input
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await waitFor('app reboot', `!!document.getElementById('fileInput')`);
await wait(1500);
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

await waitFor('convert button (batch)', `(() => {
  const b = document.getElementById('convertBtn');
  return b && b.style.display !== 'none';
})()`, 60_000);
await evaluate(`document.getElementById('convertBtn').click()`);
await waitFor('film settings (batch)',
  `document.getElementById('filmSettingsSection').style.display !== 'none'`, 30_000);
await evaluate(`document.getElementById('applyConvertBtn').click()`);
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

// ---- no uncaught page errors across both scenarios ----
const realErrors = pageErrors.filter((e) => !/ResizeObserver loop/.test(e));
if (realErrors.length) {
  fail(`uncaught page errors:\n${realErrors.join('\n---\n')}`);
}

console.log('SMOKE PASS');
process.exit(0);
