// #298 P0: the device self-test. Runs when the page opens with ?p0=1 (the
// debug iOS build navigates there for NC_P0_SELFTEST=1, lib.rs). Each fixture
// of public/p0-fixtures/plan.json goes through the real file input; the time
// the Studio takes to settle, the frame on screen, the memory ledger and the
// Tauri save path are reported as JSON lines over log_webview_diagnostics (600
// characters each, reassembled by the Mac side). Progress is kept in
// sessionStorage, so a WebContent termination, which reloads the page, resumes
// with the next fixture instead of starting over.

const PROGRESS_KEY = 'nc_p0_progress_v1';
const LINE_LIMIT = 560;

const errors = [];
addEventListener('error', (event) => errors.push({ kind: 'error', message: String(event.message), source: event.filename, line: event.lineno }));
addEventListener('unhandledrejection', (event) => errors.push({ kind: 'unhandledrejection', message: String(event.reason && (event.reason.stack || event.reason.message) || event.reason) }));
const consoleError = console.error.bind(console);
console.error = (...args) => { errors.push({ kind: 'console.error', message: args.map((a) => (a && a.stack) || String(a)).join(' ').slice(0, 300) }); consoleError(...args); };
// The RAW loader's path and admission lines ([RAW] ..., the native decoder's
// timings), which no console reaches on the device.
const rawLog = [];
for (const level of ['info', 'warn', 'log']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    const head = typeof args[0] === 'string' ? args[0] : '';
    if (/^\[RAW\]|^\[native|native-raw|two-stage|\[memory\]/i.test(head)) {
      rawLog.push({ level, text: args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ').slice(0, 400) });
    }
    original(...args);
  };
}
function safeJson(value) { try { return JSON.stringify(value); } catch { return String(value); } }
const RAM_OVERRIDE_KEY = 'nc_memory_ram_gib_v1';

const invoke = (command, args) => window.__TAURI__?.core?.invoke ? window.__TAURI__.core.invoke(command, args) : Promise.reject(new Error('no tauri bridge'));

let sequence = 0;
async function report(event, payload = {}) {
  const json = JSON.stringify({ event, t: Math.round(performance.now()), ...payload });
  const parts = [];
  for (let offset = 0; offset < json.length; offset += LINE_LIMIT) parts.push(json.slice(offset, offset + LINE_LIMIT));
  const id = ++sequence;
  for (let index = 0; index < parts.length; index++) {
    const line = `P0 ${id} ${index + 1}/${parts.length} ${parts[index]}`;
    console.info(line);
    try { await invoke('log_webview_diagnostics', { line }); } catch { /* web: console only */ }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, test, timeoutMs) {
  const started = performance.now();
  for (;;) {
    let value = false;
    try { value = test(); } catch { value = false; }
    if (value) return Math.round(performance.now() - started);
    if (performance.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(200);
  }
}

const studioSettled = () => document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy;

function memorySnapshot() {
  const snapshot = window.__ncMemory?.snapshot?.();
  if (!snapshot) return null;
  const { budget, retained, reserved, foreground, user, background, ledger, baseBudget, ramBytes, ramSource, engine } = snapshot;
  return { budget, retained, reserved, foreground, user, background, ledger, baseBudget, ramBytes, ramSource, engine };
}

function frameFacts() {
  try { return window.__ncDisplay?.state?.() ?? null; } catch (error) { return String(error); }
}

function toasts() {
  return [...document.querySelectorAll('[class*="toast"]')].map((node) => node.textContent.trim()).filter(Boolean).slice(-4);
}

function webgl() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return null;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return { version: gl.getParameter(gl.VERSION), renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) };
  } catch (error) { return String(error); }
}

async function probe() {
  const facts = {
    href: location.href, userAgent: navigator.userAgent, platform: navigator.platform,
    viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, screen: [screen.width, screen.height],
    maxTouchPoints: navigator.maxTouchPoints, hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null, crossOriginIsolated: window.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer === 'function', webgpu: !!navigator.gpu,
    offscreenCanvas: typeof OffscreenCanvas === 'function', webgl: webgl(), lang: document.documentElement.lang,
    memory: memorySnapshot()
  };
  for (const [key, command] of [['memoryInfo', 'get_memory_info'], ['appVersion', 'get_app_version'], ['nativeRaw', 'native_raw_info'], ['updateCapability', 'get_desktop_update_capability']]) {
    try { facts[key] = await invoke(command); } catch (error) { facts[key] = `error: ${error}`; }
  }
  return facts;
}

async function importFixture(fixture, timeoutMs) {
  return importFixtures([fixture], timeoutMs);
}

async function importFixtures(fixtures, timeoutMs) {
  const t0 = performance.now();
  const transfer = new DataTransfer();
  let bytes = 0;
  for (const fixture of fixtures) {
    const url = `./p0-fixtures/${fixture.file}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const blob = await response.blob();
    bytes += blob.size;
    transfer.items.add(new File([blob], fixture.file, { type: fixture.type || blob.type || 'application/octet-stream' }));
  }
  const fetchMs = Math.round(performance.now() - t0);
  const input = document.getElementById('fileInput');
  input.files = transfer.files;
  const filenameBefore = document.getElementById('studioFilename')?.textContent ?? null;
  const photosBefore = document.querySelectorAll('.file-list-name').length;
  const errorsBefore = errors.length;
  const t1 = performance.now();
  input.dispatchEvent(new Event('change', { bubbles: true }));
  // The previous photo is already settled, so wait for the import itself to
  // show: the busy flag, a new list entry, a new current file or an error.
  const started = await waitFor('import to show', () => document.body.dataset.studioBusy
    || document.querySelectorAll('.file-list-name').length !== photosBefore
    || (document.getElementById('studioFilename')?.textContent ?? null) !== filenameBefore
    || errors.length > errorsBefore, 30_000).catch(() => null);
  const settledMs = await waitFor('studio to settle', studioSettled, timeoutMs);
  // A two-stage import shows the embedded preview first (#255); the full
  // decode lands later. Wait for it, so the export is of the real frame.
  const twoStageMs = await waitFor('two-stage decode', () => {
    const status = window.__ncTwoStage?.status?.();
    return !status || (!status.pending && !document.body.dataset.studioBusy);
  }, timeoutMs).catch(() => null);
  await sleep(1000);
  await waitFor('studio to settle again', studioSettled, timeoutMs);
  const filename = document.getElementById('studioFilename')?.textContent ?? null;
  const photos = document.querySelectorAll('.file-list-name').length;
  let twoStage = null;
  try { const s = window.__ncTwoStage?.status?.(); twoStage = s && { pending: s.pending, provisional: s.provisional, swapped: s.swapped, fullDecode: s.fullDecode, mode: s.mode, base: s.base }; } catch (error) { twoStage = String(error); }
  return { bytes, fetchMs, startedMs: started, importMs: Math.round(performance.now() - t1), settledMs, twoStageMs, twoStage, filename, photos, becameCurrent: filename !== filenameBefore || photos !== photosBefore, rawLog: rawLog.splice(0) };
}

async function exportCurrent(timeoutMs) {
  const button = document.getElementById('exportSingleBtn');
  const before = toasts();
  const t0 = performance.now();
  button.click();
  await sleep(500);
  const ms = await waitFor('export to settle', () => !document.body.dataset.studioBusy && !button.disabled, timeoutMs);
  return { ms: Math.round(performance.now() - t0), settledMs: ms, toastsBefore: before, toasts: toasts() };
}

export async function runP0SelfTest({ mobileRecovery } = {}) {
  // ?p0ram=<GiB> (NC_P0_SELFTEST=<GiB>): run the memory budget at that RAM
  // through the debug override main.js reads at boot; reload once to apply.
  const params = new URLSearchParams(location.search);
  const wantedRam = params.get('p0ram');
  const currentRam = localStorage.getItem(RAM_OVERRIDE_KEY);
  // ?p0native=off|on (NC_P0_NATIVE_RAW): the native RAW decoder override
  // nativeRawDecoder.js reads (localStorage nc_native_raw); a control run
  // without it goes through libraw-wasm or the embedded preview.
  const wantedNative = params.get('p0native');
  const currentNative = localStorage.getItem('nc_native_raw');
  if ((wantedRam || null) !== currentRam || (wantedNative || null) !== currentNative) {
    if (wantedRam) localStorage.setItem(RAM_OVERRIDE_KEY, wantedRam); else localStorage.removeItem(RAM_OVERRIDE_KEY);
    if (wantedNative) localStorage.setItem('nc_native_raw', wantedNative); else localStorage.removeItem('nc_native_raw');
    await report('override', { wantedRam, previousRam: currentRam, wantedNative, previousNative: currentNative, reloading: true });
    location.reload();
    return;
  }
  const progress = Number(sessionStorage.getItem(PROGRESS_KEY) || '0');
  await report(progress > 0 ? 'resumed' : 'start', { progress, errors: errors.splice(0) });
  await waitFor('studio boot', () => !!document.getElementById('fileInput') && !!document.getElementById('exportSingleBtn'), 60_000);
  await report('probe', await probe());
  let plan;
  try {
    plan = await (await fetch('./p0-fixtures/plan.json')).json();
  } catch (error) {
    await report('fatal', { message: `plan.json: ${error}` });
    return;
  }
  if (plan.deviceRecovery) {
    const { runDeviceRecovery } = await import('./p0DeviceRecovery.js');
    await runDeviceRecovery({ plan, mobileRecovery, invoke, report, waitFor,
      studioSettled, importFixtures, exportCurrent, frameFacts, memorySnapshot,
      takeRawLog: () => rawLog.splice(0), errors });
    return;
  }
  const fixtures = plan.fixtures || [];
  for (let index = progress; index < fixtures.length; index++) {
    const fixture = fixtures[index];
    sessionStorage.setItem(PROGRESS_KEY, String(index + 1));
    await report('importing', { index, file: fixture.file });
    try {
      const imported = await importFixture(fixture, fixture.timeoutMs || plan.timeoutMs || 240_000);
      await report('imported', { index, file: fixture.file, ...imported, frame: frameFacts(), memory: memorySnapshot(), errors: errors.splice(0) });
    } catch (error) {
      await report('import-failed', { index, file: fixture.file, message: String(error && error.message || error), busy: document.body.dataset.studioBusy ?? null, classes: document.body.className, memory: memorySnapshot(), errors: errors.splice(0), rawLog: rawLog.splice(0) });
      continue;
    }
    if (plan.export !== false && fixture.export !== false) {
      try {
        const exported = await exportCurrent(fixture.exportTimeoutMs || plan.exportTimeoutMs || 240_000);
        await report('exported', { index, file: fixture.file, ...exported, memory: memorySnapshot(), errors: errors.splice(0) });
      } catch (error) {
        await report('export-failed', { index, file: fixture.file, message: String(error && error.message || error), errors: errors.splice(0) });
      }
    }
    await sleep(plan.pauseMs || 1500);
    await report('idle', { index, file: fixture.file, memory: memorySnapshot() });
  }
  if (plan.screenshot) {
    // App Store screenshots (ios-ci.yml "Store screenshots", scripts/
    // ios-store-screenshots.sh): keep the converted photo on screen, hide the
    // ?debug=1 badge and widget (main.js recreates the widget, so hide it with
    // a rule rather than removing it), drop stale toasts, then tell the runner
    // the frame is ready; it screenshots the simulator on `screenshot-ready`.
    const style = document.createElement('style');
    style.textContent = '#debugWidget, #buildBadge { display: none !important; }';
    document.head.appendChild(style);
    document.getElementById('toastContainer')?.replaceChildren();
    document.activeElement?.blur?.();
    await sleep(plan.screenshotSettleMs || 1500);
    await report('screenshot-ready', { fixtures: fixtures.length, frame: frameFacts(), errors: errors.splice(0) });
  }
  sessionStorage.removeItem(PROGRESS_KEY);
  await report('done', { fixtures: fixtures.length, errors: errors.splice(0) });
}
