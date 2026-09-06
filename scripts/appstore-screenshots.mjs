// Studio の実画面と RAW デコード結果を撮影。元写真は変更しない。
// NC_SHOT_FIXTURE=/path/L1009967.dng node scripts/appstore-screenshots.mjs [outputDir]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const UPNG = createRequire(import.meta.url)('upng-js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.argv[2] || join(ROOT, 'output/playwright/appstore/en-US'));
const FIXTURE = resolve(process.env.NC_SHOT_FIXTURE || join(ROOT, 'L1009967.dng'));
const PORT = 5199, CDP_PORT = 9226;
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (!existsSync(CHROME) || !existsSync(FIXTURE)) throw new Error('Chrome or RAW fixture missing');
mkdirSync(OUT, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'nc-store-'));
const children = [];
process.on('exit', () => {
  for (const child of children) { try { child.kill('SIGKILL'); } catch {} }
  rmSync(profile, { recursive: true, force: true });
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const vite = spawn(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), '--config', 'negative2positive/vite.config.js', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
children.push(vite);
let ready = false;
for (let i = 0; i < 60; i++) {
  if (vite.exitCode !== null) throw new Error('Screenshot server failed to start');
  try { ready = (await fetch(`http://127.0.0.1:${PORT}/`)).ok; } catch {}
  if (ready) break;
  await wait(500);
}
if (!ready) throw new Error('Screenshot server timeout');
children.push(spawn(CHROME, [
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--window-size=1456,1000', '--lang=en-US', '--force-color-profile=srgb', 'about:blank',
], { stdio: 'ignore' }));
let wsUrl;
for (let i = 0; i < 60; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).find(t => t.type === 'page')?.webSocketDebuggerUrl; } catch {}
  if (wsUrl) break;
  await wait(250);
}
if (!wsUrl) throw new Error('Chrome startup timeout');
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map(), pageErrors = [];
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message); pending.delete(message.id);
  }
  if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const requestId = ++id;
  const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`CDP timeout: ${method}`)); }, 60_000);
  pending.set(requestId, message => {
    clearTimeout(timer);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  });
  ws.send(JSON.stringify({ id: requestId, method, params }));
});
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
};
const waitFor = async (label, expression, timeout = 240_000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (pageErrors.length) throw new Error(JSON.stringify(pageErrors));
    if (await evaluate(expression)) return;
    await wait(500);
  }
  throw new Error(`Timeout: ${label}`);
};
const shoot = async name => {
  await evaluate('document.fonts.ready.then(() => true)');
  await wait(1500);
  if (pageErrors.length) throw new Error(JSON.stringify(pageErrors));
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const bytes = Buffer.from(shot.data, 'base64');
  const png = UPNG.decode(bytes);
  if (png.width !== 2880 || png.height !== 1800) throw new Error('Wrong screenshot dimensions');
  writeFileSync(join(OUT, name), bytes);
  console.log(`Captured ${name}: ${png.width} x ${png.height}`);
};
await send('Page.enable'); await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?lang=en` });
await waitFor('Studio', `!!document.getElementById('studioBasic')`);
// デスクトップ版と同じく自己ダウンロードリンクだけ非表示にする。
await evaluate(`document.getElementById('offlineDownloadLink').style.display = 'none'`);
await shoot('04-import.png');
const doc = await send('DOM.getDocument');
const input = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#fileInput' });
await send('DOM.setFileInputFiles', { files: [FIXTURE], nodeId: input.nodeId });
await waitFor('automatic RAW conversion', `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy && !document.querySelector('.loading-overlay.visible')`);
await wait(5000);
console.log('Ready:', await evaluate(`JSON.stringify({ body: document.body.className, canvas: [document.getElementById('canvas').width, document.getElementById('canvas').height] })`));
await shoot('01-color-workspace.png');
await evaluate(`document.querySelector('[data-jump="studioCurves"]').click()`);
await waitFor('curve editor', `document.getElementById('curveCanvas').width > 100`);
await shoot('02-curves.png');
await evaluate(`document.getElementById('studioTab-conversion').click()`);
await shoot('03-film-conversion.png');
console.log('DONE: real Studio screenshots; original RAW unchanged');
process.exit(0);
