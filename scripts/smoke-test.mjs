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
    console.log(`dialog auto-accepted: ${msg.params?.message?.slice(0, 120)}`);
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

// ---- 5. no uncaught page errors ----
const realErrors = pageErrors.filter((e) => !/ResizeObserver loop/.test(e));
if (realErrors.length) {
  fail(`uncaught page errors:\n${realErrors.join('\n---\n')}`);
}

console.log('SMOKE PASS');
process.exit(0);
