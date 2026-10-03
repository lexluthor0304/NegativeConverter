import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const UPNG = createRequire(import.meta.url)('upng-js');

// Interaction, undo and zoom stay on the preview path, and full-resolution
// conversions run only when pixels are stale (#237). `?largeImagePixels=`
// makes the 1800x1200 synthetic negative count as a >16 MP frame, so the
// large-image rules run on a small fixture; a second pass without it checks
// the 16 MP-or-less routing. Every assertion counts real worker messages:
// preview conversions (the cacheInput client), full-resolution conversions
// (any other conversion larger than a light-table tile), and dust-worker
// detect/inpaint/refine requests.
const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
const SOURCE = { width: 1800, height: 1200 };

function installPreviewPathProbe() {
  const original = {
    post: Worker.prototype.postMessage, terminate: Worker.prototype.terminate,
    click: HTMLAnchorElement.prototype.click,
    revoke: URL.revokeObjectURL, picker: window.showSaveFilePicker,
  };
  // WebGL2 (#239) and the WebGL1 fallback have separate prototypes.
  const glDraws = [WebGLRenderingContext.prototype, window.WebGL2RenderingContext?.prototype].filter(Boolean)
    .map(proto => ({ proto, draw: proto.drawArrays }));
  const workers = new Map();
  const heldUrls = new Set();
  const probe = window.__previewPathProbe = {
    events: [], exports: [], draws: 0, inFlight: 0, lastActivity: performance.now(), inputs: [],
  };
  const note = (type, detail = {}) => {
    probe.events.push({ type, time: performance.now(), ...detail });
    probe.lastActivity = performance.now();
  };
  const track = (worker, id) => {
    let record = workers.get(worker);
    if (!record) {
      record = { pending: new Set() };
      record.receive = event => {
        if (record.pending.delete(event.data?.id)) { probe.inFlight--; note('reply'); }
      };
      worker.addEventListener('message', record.receive);
      workers.set(worker, record);
    }
    record.pending.add(id);
    probe.inFlight++;
  };
  Worker.prototype.postMessage = function(message, ...args) {
    if (message?.type === 'convert') {
      track(this, message.id);
      // Light-table lanes convert tiles of at most 288 px of other photos.
      const tile = message.width * message.height <= 300 * 300;
      const kind = message.cacheInput ? 'preview' : (tile ? 'lane' : 'full');
      note(kind, { width: message.width, height: message.height });
      // A check that acts while a full-resolution conversion is in flight:
      // it runs right after this post, before any reply can arrive.
      if (kind === 'full' && probe.onFull) {
        const run = probe.onFull;
        probe.onFull = null;
        queueMicrotask(run);
      }
    } else if (['detect', 'inpaint', 'refine'].includes(message?.type) && typeof message.reuseSource === 'boolean') {
      track(this, message.id);
      note(`dust:${message.type}`);
    }
    return original.post.call(this, message, ...args);
  };
  Worker.prototype.terminate = function(...args) {
    const record = workers.get(this);
    if (record) { probe.inFlight -= record.pending.size; record.pending.clear(); note('terminate'); }
    return original.terminate.apply(this, args);
  };
  for (const { proto, draw } of glDraws) {
    proto.drawArrays = function(...args) {
      const result = draw.apply(this, args);
      // The GPU preview's self-test draws into its own framebuffer.
      if (this.canvas?.id === 'glCanvas' && this.getParameter(this.FRAMEBUFFER_BINDING) === null) { probe.draws++; note('draw'); }
      return result;
    };
  }
  window.showSaveFilePicker = undefined;
  URL.revokeObjectURL = function(url) { if (!heldUrls.has(url)) original.revoke.call(URL, url); };
  HTMLAnchorElement.prototype.click = function(...args) {
    if (!/\.(png|tiff)$/.test(this.download || '') || !this.href.startsWith('blob:')) return original.click.apply(this, args);
    const href = this.href, capture = { name: this.download };
    heldUrls.add(href); probe.exports.push(capture);
    fetch(href).then(response => response.blob()).then(blob => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    })).then(data => { capture.data = data; }, error => { capture.error = String(error); })
      .finally(() => { heldUrls.delete(href); original.revoke.call(URL, href); });
  };
  const status = document.getElementById('dustStatus');
  probe.dustProcessing = 0;
  probe.statusObserver = new MutationObserver(() => {
    if (/^Processing/.test(status.textContent)) probe.dustProcessing++;
  });
  probe.statusObserver.observe(status, { childList: true, subtree: true, characterData: true });
  probe.count = (since = 0) => {
    const out = { preview: 0, full: 0, lane: 0, detect: 0, inpaint: 0, refine: 0 };
    for (const event of probe.events) {
      if (event.time < since) continue;
      if (event.type === 'preview' || event.type === 'full' || event.type === 'lane') out[event.type]++;
      else if (event.type.startsWith('dust:')) out[event.type.slice(5)]++;
    }
    return out;
  };
  probe.restore = () => {
    Worker.prototype.postMessage = original.post; Worker.prototype.terminate = original.terminate;
    for (const { proto, draw } of glDraws) proto.drawArrays = draw;
    HTMLAnchorElement.prototype.click = original.click; URL.revokeObjectURL = original.revoke;
    window.showSaveFilePicker = original.picker;
    for (const [worker, record] of workers) worker.removeEventListener('message', record.receive);
    probe.statusObserver.disconnect();
    delete window.__previewPathProbe;
  };
}

function decodePng(dataUrl) {
  const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
  const png = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const pixels = png.depth === 16 ? Buffer.from(png.data) : Buffer.from(UPNG.toRGBA8(png)[0]);
  return { width: png.width, height: png.height, depth: png.depth,
    sha256: createHash('sha256').update(pixels).digest('hex') };
}

export async function runPreviewPathSmoke({ send, evaluate, waitFor, fail, installDialogAutoAccept, port }) {
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const until = async (description, expression, timeout = 90_000) => {
    expect(await waitFor(description, expression, timeout, { soft: true }), `timeout waiting for ${description}`);
  };
  const now = () => evaluate('performance.now()');
  const counts = since => evaluate(`window.__previewPathProbe.count(${since})`);
  // No worker reply outstanding and no conversion, dust request or draw for
  // `ms`. The call itself counts as activity, so work that an action starts
  // after a timer (70 ms full gate, 100 ms display resize) is waited for.
  const quiet = async (description, ms = 1500) => {
    await evaluate('window.__previewPathProbe.lastActivity = Math.max(window.__previewPathProbe.lastActivity, performance.now())');
    await until(description, `${ready} && window.__previewPathProbe.inFlight === 0 && performance.now() - window.__previewPathProbe.lastActivity > ${ms}`);
  };
  const exportPng = async (depth, label) => {
    const index = await evaluate('window.__previewPathProbe.exports.length');
    await evaluate(`(() => {
      document.querySelector('.format-btn[data-format="png"]').click();
      document.querySelector('.bitdepth-btn[data-bitdepth="${depth}"]').click();
      document.getElementById('exportSingleBtn').click();
    })()`);
    await until(`${label}: ${depth}-bit PNG captured`, `!!window.__previewPathProbe.exports[${index}]?.data && !document.getElementById('exportBtn').disabled`, 120_000);
    return decodePng(await evaluate(`window.__previewPathProbe.exports[${index}].data`));
  };
  // A 16-bit TIFF, compared byte for byte (the encoder writes no timestamp).
  const exportTiff16 = async label => {
    const index = await evaluate('window.__previewPathProbe.exports.length');
    await evaluate(`(() => {
      document.querySelector('.format-btn[data-format="tiff"]').click();
      document.querySelector('.bitdepth-btn[data-bitdepth="16"]').click();
      document.getElementById('exportSingleBtn').click();
    })()`);
    await until(`${label}: 16-bit TIFF captured`, `!!window.__previewPathProbe.exports[${index}]?.data && !document.getElementById('exportBtn').disabled`, 120_000);
    const bytes = Buffer.from((await evaluate(`window.__previewPathProbe.exports[${index}].data`)).split(',')[1], 'base64');
    return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const same = (a, b) => a.width === b.width && a.height === b.height && a.depth === b.depth && a.sha256 === b.sha256;
  // pointerdown takes the undo snapshot, as a real drag does.
  const setSlider = (id, value) => evaluate(`(() => {
    const input = document.getElementById(${JSON.stringify(id)});
    input.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    input.value = ${JSON.stringify(String(value))};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const wheel = async deltaY => {
    const center = await evaluate(`(() => {
      const rect = document.getElementById('canvasContainer').getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    for (let step = 0; step < 6; step++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: center.x, y: center.y, deltaX: 0, deltaY });
      await new Promise(resolve => setTimeout(resolve, 16));
    }
  };
  const zoomInAndOut = async label => {
    await wheel(-60);
    await quiet(`${label}: zoomed in`);
    const zoomed = await evaluate(`document.getElementById('zoomIndicator').textContent`);
    expect(zoomed && zoomed !== '100%', `${label}: the wheel did not zoom: ${zoomed}`);
    await wheel(60);
    await wheel(60);
    await quiet(`${label}: zoomed back`);
  };
  const resizeDisplay = async (label, height, previews = 0, dpr = null) => {
    const before = await evaluate(`({ state: window.__ncDisplay.state(), token: window.__ncDisplay.state().token, at: performance.now() })`);
    if (dpr) await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: dpr, mobile: false });
    await evaluate(`Object.assign(document.getElementById('canvasContainer').style, { flex: '0 0 ${height}px', height: '${height}px' })`);
    await until(label + ': target changed', `JSON.stringify(window.__ncDisplay.state().target) !== ${JSON.stringify(JSON.stringify(before.state.target))}`);
    await quiet(label);
    const after = await evaluate(`({ state: window.__ncDisplay.state(), token: window.__ncDisplay.state().token })`);
    const work = await counts(before.at);
    expect(work.full === 0 && work.preview === previews && work.detect === 0 && work.inpaint === 0,
      label + ': unexpected work ' + JSON.stringify(work));
    expect(after.token === before.token, label + ': token changed');
    if (!previews) expect(after.state.counters.workerRebuilds + after.state.counters.bandedRebuilds >
      before.state.counters.workerRebuilds + before.state.counters.bandedRebuilds, label + ': no rebuild');
    expect(after.state.shown.width === after.state.target.width && after.state.shown.height === after.state.target.height,
      label + ': new target not displayed ' + JSON.stringify(after));
    console.log('ok: ' + label + ' ' + JSON.stringify({ work, token: after.token, counters: after.state.counters }));
  };
  const boot = async (query, fileName) => {
    const origin = await evaluate('performance.timeOrigin');
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/${query}` });
    await until('fresh preview-path workspace', `performance.timeOrigin !== ${origin} && document.readyState === 'complete' && !!document.getElementById('studioImportAutoCrop')`);
    await installDialogAutoAccept();
    await evaluate(`(${installPreviewPathProbe.toString()})()`);
    await evaluate(`(async () => {
      for (const id of ['studioImportAutoCrop', 'importFilmTypeAuto', 'autoRollOnImport']) {
        const input = document.getElementById(id); if (input?.checked) input.click();
      }
      document.querySelector('.film-type-btn[data-type="color"]').click();
      // Rebate, a textured image area and a few specks for dust detection.
      const surface = document.createElement('canvas');
      surface.width = ${SOURCE.width}; surface.height = ${SOURCE.height};
      const context = surface.getContext('2d');
      context.fillStyle = 'rgb(215,150,100)'; context.fillRect(0, 0, surface.width, surface.height);
      const gradient = context.createLinearGradient(90, 90, surface.width - 90, surface.height - 90);
      gradient.addColorStop(0, 'rgb(190,125,80)'); gradient.addColorStop(1, 'rgb(120,80,50)');
      context.fillStyle = gradient; context.fillRect(90, 90, surface.width - 180, surface.height - 180);
      context.fillStyle = 'rgb(70,45,28)'; context.fillRect(300, 300, 400, 300);
      context.fillStyle = 'rgb(250,250,250)';
      for (const [x, y] of [[520, 820], [980, 410], [1300, 760], [1450, 300], [760, 980]]) context.fillRect(x, y, 3, 3);
      const blob = await new Promise(resolve => surface.toBlob(resolve, 'image/png'));
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], ${JSON.stringify(fileName)}, { type: 'image/png' }));
      const input = document.getElementById('fileInput'); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until(`${fileName} converted`, `${ready} && document.getElementById('studioFilename').textContent === ${JSON.stringify(fileName)}`, 120_000);
    await evaluate(`(() => {
      document.getElementById('studioTab-edit').click();
      const more = document.getElementById('studioMore'); if (more) more.open = true;
      const gl = document.getElementById('coreUseWebGL'); if (!gl.checked) gl.click();
    })()`);
  };

  let failure;
  try {
    // ---- Part 1: large-image rules (the fixture counts as >16 MP) ----
    await boot('?lang=en&largeImagePixels=1000000', 'preview-path-large.png');
    await quiet('large fixture idle', 3500);
    await resizeDisplay('branch 3 preview-only resize', 410, 1);
    let mark = await now();
    expect((await counts(0)).full === 0, 'a >16 MP import converted at full resolution before export: ' + JSON.stringify(await counts(0)));

    await setSlider('coreExposure', 20);
    await quiet('exposure edit settled');
    const undo = await evaluate(`(() => {
      const probe = window.__previewPathProbe, draws = probe.draws;
      document.getElementById('undoBtn').click();
      return { paintedInTask: probe.draws - draws, exposure: document.getElementById('coreExposure').value };
    })()`);
    expect(undo.paintedInTask >= 1 && undo.exposure === '0', 'Undo did not paint the restored preview in its own task: ' + JSON.stringify(undo));
    await quiet('undo settled');
    const redo = await evaluate(`(() => {
      const probe = window.__previewPathProbe, draws = probe.draws;
      document.getElementById('redoBtn').click();
      return { paintedInTask: probe.draws - draws, exposure: document.getElementById('coreExposure').value };
    })()`);
    expect(redo.paintedInTask >= 1 && redo.exposure === '20', 'Redo did not paint the restored preview in its own task: ' + JSON.stringify(redo));
    await quiet('redo settled');
    await evaluate(`document.getElementById('studioTab-conversion')?.click(); document.getElementById('studioResetAll').click()`);
    await until('reset all confirmed', `document.getElementById('coreExposure').value === '0'`, 10_000);
    await quiet('reset settled');
    await evaluate(`document.getElementById('studioTab-edit').click()`);
    for (const id of ['coreEnhancedProfile', 'coreWbMode', 'coreCurvePrecision']) {
      await evaluate(`(() => {
        const select = document.getElementById(${JSON.stringify(id)});
        const next = [...select.options].find(option => option.value !== select.value);
        select.value = next.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await quiet(`${id} settled`);
    }
    const actions = await counts(mark);
    expect(actions.full === 0 && actions.preview >= 6,
      'Undo, Redo, Reset or an engine control converted at full resolution above 16 MP: ' + JSON.stringify(actions));
    console.log('ok: >16 MP undo/redo/reset/engine controls stay on the preview path ' + JSON.stringify({ undo, redo, actions }));

    mark = await now();
    await evaluate(`document.getElementById('coreUseWebGL').click()`);
    await quiet('WebGL off');
    await evaluate(`document.getElementById('coreUseWebGL').click()`);
    await quiet('WebGL on');
    const toggled = await counts(mark);
    expect(toggled.full === 0 && toggled.preview === 0, 'the WebGL toggle converted: ' + JSON.stringify(toggled));
    console.log('ok: the WebGL toggle converts nothing');

    mark = await now();
    const first = await exportPng(8, 'first export');
    const firstExport = await counts(mark);
    const rendered = await evaluate(`window.__previewPathProbe.events.filter(event => event.type === 'full').at(-1)`);
    expect(firstExport.full === 1 && rendered && first.width === SOURCE.width && first.height === SOURCE.height
      && rendered.width === SOURCE.width && rendered.height === SOURCE.height,
    'the first export did not render the original exactly once: ' + JSON.stringify({ firstExport, rendered, first }));

    // Step-3 edits after an export invalidate nothing; a zoom neither.
    mark = await now();
    await setSlider('cyan', 25);
    await setSlider('wbR', 1.1);
    await quiet('step-3 edits after export', 2500);
    const step8 = await exportPng(8, 'step-3 export');
    const step16 = await exportPng(16, 'step-3 export');
    await zoomInAndOut('no repairs');
    await resizeDisplay('branch 1 exact plane DPR and container resize', 550, 0, 1.5);
    const zoomed8 = await exportPng(8, 'export after zoom');
    const reused = await counts(mark);
    expect(reused.full === 0 && reused.preview === 0,
      'a Step-3 edit or a zoom made export convert again: ' + JSON.stringify(reused));
    expect(same(step8, zoomed8), 'zoom changed the exported pixels: ' + JSON.stringify({ step8, zoomed8 }));
    // The same settings converted from scratch give the same bytes.
    await setSlider('coreExposure', 4);
    await quiet('core change');
    await setSlider('coreExposure', 0);
    await quiet('core change back');
    mark = await now();
    const fresh8 = await exportPng(8, 'fresh conversion');
    const fresh16 = await exportPng(16, 'fresh conversion');
    const reconverted = await counts(mark);
    expect(reconverted.full === 1, 'a core change did not make export convert again: ' + JSON.stringify(reconverted));
    expect(same(step8, fresh8) && same(step16, fresh16),
      'a reused full-resolution plane exported other pixels than a fresh conversion: ' + JSON.stringify({ step8, fresh8, step16, fresh16 }));
    console.log('ok: Step-3 edits and zoom reuse the exported plane; 8/16-bit bytes equal a fresh conversion');

    // ---- Part 1b: repairs settle on idle ----
    await evaluate(`(() => {
      document.getElementById('studioTab-repair').click();
      // TELEA keeps this scenario independent of the learned model.
      if (document.getElementById('dustAiEnabled').checked) document.getElementById('dustAiEnabled').click();
      document.getElementById('dustRemovalEnabled').click();
    })()`);
    await until('dust repair settled', `/^(Detected [0-9]+ dust particles|No dust detected)$/.test(document.getElementById('dustStatus').textContent)`, 90_000);
    await quiet('dust idle', 3500);
    const settledBefore = await exportPng(8, 'repaired export');
    mark = await now();
    const processing = await evaluate('window.__previewPathProbe.dustProcessing');
    await zoomInAndOut('repairs');
    await resizeDisplay('branch 1 repaired plane resize', 410);
    await quiet('resize with repairs');
    const afterZoom = await exportPng(8, 'repaired export after zoom');
    const zoomRepairs = await counts(mark);
    const zoomProcessing = await evaluate('window.__previewPathProbe.dustProcessing') - processing;
    expect(zoomRepairs.full === 0 && zoomRepairs.preview === 0 && zoomRepairs.detect === 0 && zoomRepairs.inpaint === 0 && zoomProcessing === 0,
      'a zoom or resize with repairs converted or detected again: ' + JSON.stringify({ zoomRepairs, zoomProcessing }));
    expect(same(settledBefore, afterZoom), 'zoom changed the repaired export: ' + JSON.stringify({ settledBefore, afterZoom }));
    console.log('ok: zoom and resize with repairs on convert and detect nothing; the repaired export is unchanged');

    // A dust-on drag paints preview frames only; one exact pass and one
    // detection follow the last input after the idle delay.
    await evaluate(`document.getElementById('studioTab-edit').click()`);
    const drag = values => evaluate(`(async () => {
      const probe = window.__previewPathProbe, slider = document.getElementById('coreExposure');
      const start = performance.now(), draws = probe.draws;
      for (const value of ${JSON.stringify(values)}) {
        slider.value = String(value);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => requestAnimationFrame(() => resolve()));
      }
      const last = performance.now();
      slider.dispatchEvent(new Event('change', { bubbles: true }));
      return { start, last, draws: probe.draws - draws, during: probe.count(start) };
    })()`);
    const ramp = (from, to) => Array.from({ length: 30 }, (_, i) => Math.round(from + (to - from) * Math.sin(Math.PI * i / 29)));
    const dragged = await drag(ramp(20, 40));
    expect(dragged.during.full === 0 && dragged.during.detect === 0 && dragged.during.inpaint === 0 && dragged.draws >= 10,
      'a dust-on drag converted at full resolution, detected, or painted too little while input continued: ' + JSON.stringify(dragged));
    await until('drag preview landed before branch 2', 'window.__previewPathProbe.inFlight === 0', 1500);
    const repairMark = await now();
    const repairToken = await evaluate('window.__ncDisplay.state().token');
    const repairTarget = await evaluate('JSON.stringify(window.__ncDisplay.state().target)');
    await evaluate(`Object.assign(document.getElementById('canvasContainer').style, { flex: '0 0 550px', height: '550px' })`);
    await until('branch 2 repair target changed', `JSON.stringify(window.__ncDisplay.state().target) !== ${JSON.stringify(repairTarget)}`);
    expect(await evaluate('window.__ncDisplay.state().token') === repairToken, 'branch 2 changed the token');
    const repairResizeWork = await counts(repairMark);
    expect(repairResizeWork.full === 0 && repairResizeWork.preview === 0 && repairResizeWork.detect === 0,
      'branch 2 resize added work before its existing repair pass: ' + JSON.stringify(repairResizeWork));
    await until('idle repair pass', `window.__previewPathProbe.count(${dragged.last}).detect >= 1`, 60_000);
    await quiet('idle repair settled', 3500);
    const idle = await evaluate(`(() => {
      const probe = window.__previewPathProbe;
      const firstFull = probe.events.find(event => event.type === 'full' && event.time > ${dragged.last});
      return { counts: probe.count(${dragged.last}), delay: firstFull ? Math.round(firstFull.time - ${dragged.last}) : null };
    })()`);
    expect(idle.counts.full === 1 && idle.counts.detect === 1 && idle.delay >= 2400,
      'the idle repair pass did not run exactly once after the idle delay: ' + JSON.stringify(idle));
    const settled = await exportPng(8, 'settled repaired export');
    console.log('ok: dust-on drag painted ' + dragged.draws + ' frames with no full-resolution or dust work; one idle pass ' + JSON.stringify(idle));
    // Exports fired 0 ms, 500 ms and 3 s after a drag are cleaned exactly like
    // the settled frame.
    for (const delay of [0, 500, 3000]) {
      await drag(ramp(20, 35));
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      const raced = await exportPng(8, `export ${delay} ms after a drag`);
      expect(same(raced, settled), `an export ${delay} ms after a dust-on drag differs from the settled export: ` + JSON.stringify({ raced, settled }));
      await quiet(`after the ${delay} ms export`, 3500);
    }
    console.log('ok: exports 0/500/3000 ms after a dust-on drag equal the settled, cleaned export');

    // ---- Part 1c: Reset All and Clear mask in the idle repair window (#229 review R1-040, R1-041) ----
    // Reset All while the idle repair pass converts the previous exposure:
    // that pass is abandoned, so a 16-bit TIFF exported right after equals a
    // fresh export of the reset settings (5f23eb0 exported the previous
    // exposure under them).
    await setSlider('coreExposure', 25);
    const reset = await evaluate(`new Promise(resolve => {
      const probe = window.__previewPathProbe;
      const timeout = setTimeout(() => { probe.onFull = null; resolve({ timeout: true }); }, 30_000);
      probe.onFull = () => {
        clearTimeout(timeout);
        const inFlight = probe.inFlight;
        document.getElementById('studioTab-conversion')?.click();
        document.getElementById('studioResetAll').click();
        // Answered at once: the smoke's dialog auto-accept polls.
        document.querySelector('[data-app-dialog-confirm]')?.click();
        resolve({ inFlight });
      };
    })`);
    expect(!reset.timeout && reset.inFlight >= 1, 'Reset All did not land while the idle repair pass converted: ' + JSON.stringify(reset));
    await until('reset during the idle repair pass', `document.getElementById('coreExposure').value === '0'`, 10_000);
    const afterReset = await exportTiff16('export right after Reset during the idle pass');
    await quiet('after the reset export', 3500);
    await setSlider('coreExposure', 4);
    await quiet('core change after reset', 3500);
    await setSlider('coreExposure', 0);
    await quiet('back to the default exposure', 3500);
    const freshDefault = await exportTiff16('fresh export at the reset settings');
    expect(afterReset.sha256 === freshDefault.sha256,
      'an export after Reset All during the idle repair pass differs from a fresh export of the reset settings: ' + JSON.stringify({ afterReset, freshDefault }));
    console.log('ok: Reset All during the idle repair pass exports the reset settings (TIFF16 ' + afterReset.sha256.slice(0, 16) + ')');

    // Clear mask after a nudge, then an export, inside the idle window: the
    // clean source put back still lags the new exposure, so that export
    // equals the one made after the idle pass (5f23eb0 exported the previous
    // exposure).
    const nudged = await evaluate(`(async () => {
      const probe = window.__previewPathProbe, start = performance.now();
      const input = document.getElementById('coreExposure');
      input.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      input.value = '6';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      // The nudge's preview frame lands first, as it does before a human click.
      while (!(probe.count(start).preview >= 1 && probe.inFlight === 0)) {
        if (performance.now() - start > 1500) break;
        await new Promise(resolve => setTimeout(resolve, 4));
      }
      await new Promise(resolve => setTimeout(resolve, 20));
      document.getElementById('studioTab-repair').click();
      document.getElementById('dustClearMaskBtn').click();
      const cleared = performance.now();
      const index = probe.exports.length;
      document.querySelector('.format-btn[data-format="png"]').click();
      document.querySelector('.bitdepth-btn[data-bitdepth="8"]').click();
      document.getElementById('exportSingleBtn').click();
      return { start, cleared, exported: performance.now(), index, counts: probe.count(start) };
    })()`);
    // The idle pass is armed when the nudge's frame lands: no full-resolution
    // conversion yet means the export started inside its window.
    expect(nudged.counts.preview >= 1 && nudged.counts.full === 0 && nudged.exported - nudged.start < 2500,
      'Clear mask and the export did not fall inside the idle repair window: ' + JSON.stringify(nudged));
    await until('export right after Clear mask: 8-bit PNG captured', `!!window.__previewPathProbe.exports[${nudged.index}]?.data && !document.getElementById('exportBtn').disabled`, 120_000);
    const quick = decodePng(await evaluate(`window.__previewPathProbe.exports[${nudged.index}].data`));
    await quiet('after the quick export', 3500);
    const waited = await exportPng(8, 'export after the idle window');
    expect(same(quick, waited), 'an export right after Clear mask differs from the export after the idle window: ' + JSON.stringify({ quick, waited, nudged }));
    console.log('ok: Clear mask inside the idle repair window exports the new exposure ' + JSON.stringify({
      cleared: Math.round(nudged.cleared - nudged.start), exported: Math.round(nudged.exported - nudged.start) }));
    await evaluate(`document.getElementById('studioTab-repair').click(); document.getElementById('dustRemovalEnabled').click()`);
    await quiet('dust off');
    await evaluate('window.__previewPathProbe.restore()');

    // ---- Part 2: 16 MP or less, Step-3 commits start no render ----
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await boot('?lang=en', 'preview-path-small.png');
    await quiet('small fixture idle (initial full render done)', 3500);
    expect((await counts(0)).full >= 1, 'the 16 MP-or-less fixture never rendered at full resolution: ' + JSON.stringify(await counts(0)));
    const commits = [
      ['WB gain', () => setSlider('wbG', 1.08)],
      ['C/M/Y slider', () => setSlider('magenta', 15)],
      ['C/M/Y console key', () => evaluate(`(() => {
        const key = document.querySelector('.console-key[data-channel="yellow"][data-dir="1"]');
        if (key && !key.disabled) key.click();
      })()`)],
      ['curve preset', () => evaluate(`document.querySelector('.curve-preset-btn')?.click()`)],
      ['curve reset', () => evaluate(`document.getElementById('resetCurveBtn').click()`)],
    ];
    for (const [label, commit] of commits) {
      const since = await now();
      await commit();
      await quiet(`${label} settled`, 2500);
      const after = await counts(since);
      expect(after.full === 0, `${label} started a full-resolution render: ` + JSON.stringify(after));
    }
    const since = await now();
    await setSlider('coreExposure', 10);
    await quiet('core change on a small scan', 3500);
    expect((await counts(since)).full === 1, 'a core change on a 16 MP-or-less scan did not render at full resolution on idle: ' + JSON.stringify(await counts(since)));
    console.log('ok: Step-3 commits on a 16 MP-or-less scan start no full-resolution render; a core change still does');
  } catch (error) {
    failure = error;
    const diagnostics = await evaluate(`(() => {
      const probe = window.__previewPathProbe;
      return probe && { counts: probe.count(0), inFlight: probe.inFlight, exports: probe.exports.length,
        dust: document.getElementById('dustStatus')?.textContent, tail: probe.events.slice(-40) };
    })()`).catch(() => null);
    console.error('preview-path diagnostics:', JSON.stringify(diagnostics));
  } finally {
    await evaluate('window.__previewPathProbe?.restore()').catch(() => {});
  }
  if (failure) fail(failure.stack || String(failure));
}
