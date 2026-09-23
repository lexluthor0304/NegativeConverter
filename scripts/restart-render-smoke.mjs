import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const UPNG = createRequire(import.meta.url)('upng-js');

// Delay delivery, not computation: the held pixels are an actual full-size
// conversion-worker response. All other workers, IDs and messages run normally.
function installRestartProbe() {
  const originalPost = Worker.prototype.postMessage;
  const originalClick = HTMLAnchorElement.prototype.click;
  const originalPicker = window.showSaveFilePicker;
  window.showSaveFilePicker = undefined;
  const workers = new Map();
  const probe = window.__restartRenderProbe = {
    phase: 'import', requests: [], delivered: [], exports: [], armed: false,
    target: null, held: null, released: 0, timedOut: false,
  };
  let heldEvent = null;
  let watchdog = null;
  probe.release = () => {
    if (!heldEvent) return false;
    const { event, record, request } = heldEvent;
    heldEvent = null;
    clearTimeout(watchdog);
    probe.released++;
    record.receive.call(record.worker, event);
    probe.delivered.push({ ...request, released: true });
    return true;
  };
  Worker.prototype.postMessage = function(message, ...args) {
    if (message?.type === 'convert') {
      let record = workers.get(this);
      if (!record) {
        record = { worker: this, number: workers.size + 1, receive: this.onmessage, requests: new Map() };
        record.wrapper = event => {
          const request = record.requests.get(event.data?.id);
          if (event.data?.type === 'result' && request && probe.target === request) {
            probe.held = { ...request, resultWidth: event.data.width, resultHeight: event.data.height,
              rgbaBytes: event.data.rgba?.byteLength, receivedAt: performance.now() };
            heldEvent = { event, record, request };
            // Always unblock the real client before its own ~32-second timeout.
            watchdog = setTimeout(() => { probe.timedOut = true; probe.release(); }, 15000);
            return;
          }
          record.receive.call(record.worker, event);
          if (event.data?.type === 'result' && request) probe.delivered.push({ ...request });
        };
        this.onmessage = record.wrapper;
        workers.set(this, record);
      }
      const request = { worker: record.number, id: message.id, phase: probe.phase,
        exposure: message.settings?.exposure, preview: message.options?.preview,
        width: message.width, height: message.height };
      record.requests.set(message.id, request);
      probe.requests.push(request);
      if (probe.armed && request.preview === false && request.exposure === 24) {
        probe.target = request;
        probe.armed = false;
      }
    }
    return originalPost.call(this, message, ...args);
  };
  HTMLAnchorElement.prototype.click = function(...args) {
    if (this.download?.endsWith('.png') && this.href.startsWith('blob:')) {
      const capture = { name: this.download };
      probe.exports.push(capture);
      fetch(this.href).then(response => response.blob()).then(blob => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      })).then(data => { capture.data = data; }, error => { capture.error = String(error); });
      return;
    }
    return originalClick.apply(this, args);
  };
  window.__restoreRestartRenderProbe = () => {
    probe.release();
    clearTimeout(watchdog);
    Worker.prototype.postMessage = originalPost;
    HTMLAnchorElement.prototype.click = originalClick;
    window.showSaveFilePicker = originalPicker;
    for (const record of workers.values()) {
      if (record.worker.onmessage === record.wrapper) record.worker.onmessage = record.receive;
    }
    delete window.__restartRenderProbe;
    delete window.__restoreRestartRenderProbe;
  };
}

function decodeExport(dataUrl) {
  const png = UPNG.decode(Buffer.from(dataUrl.split(',')[1], 'base64'));
  const rgba = Buffer.from(UPNG.toRGBA8(png)[0]);
  return { width: png.width, height: png.height, rgba,
    sha256: createHash('sha256').update(rgba).digest('hex') };
}

export async function runRestartRenderSmoke({ send, evaluate, waitFor, fail, port }) {
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const until = async (description, expression, timeout = 30000) => {
    expect(await waitFor(description, expression, timeout, { soft: true }), `timeout waiting for ${description}`);
  };
  const oldOrigin = await evaluate('performance.timeOrigin');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await until('fresh restart regression document', `performance.timeOrigin !== ${oldOrigin} && document.readyState === 'complete' && !!document.getElementById('studioImportAutoCrop')`);
  let failure;
  try {
    await evaluate(`(${installRestartProbe.toString()})()`);
    await evaluate(`(async () => {
      for (const id of ['studioImportAutoCrop', 'importFilmTypeAuto']) {
        const input = document.getElementById(id); if (input.checked) input.click();
      }
      document.querySelector('.film-type-btn[data-type="color"]').click();
      const blob = await (await fetch('/test-fixtures/negative-sample.jpg')).blob();
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], 'restart-race.jpg', { type: 'image/jpeg' }));
      const input = document.getElementById('fileInput'); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await until('restart fixture imported', `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`, 60000);
    await evaluate(`(() => {
      document.querySelector('.format-btn[data-format="png"]').click();
      document.querySelector('.bitdepth-btn[data-bitdepth="8"]').click();
    })()`);
    const exportPixels = async () => {
      const index = await evaluate('window.__restartRenderProbe.exports.length');
      await evaluate(`document.getElementById('exportSingleBtn').click()`);
      await until('real PNG export', `!!window.__restartRenderProbe.exports[${index}]?.data && !document.getElementById('exportBtn').disabled`, 60000);
      return decodeExport(await evaluate(`window.__restartRenderProbe.exports[${index}].data`));
    };
    expect(await evaluate(`Number(document.getElementById('coreExposure').value) === 0 && !document.getElementById('dustRemovalEnabled').checked`), 'fixture must start at exposure 0 with dust disabled');
    const baseline = await exportPixels();
    await evaluate(`(() => {
      window.__restartRenderProbe.phase = 'edited';
      const input = document.getElementById('coreExposure'); input.value = '24';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const edited = await exportPixels();
    expect(!baseline.rgba.equals(edited.rgba), 'fixture does not distinguish exposure 0 from 24');
    await evaluate(`(() => {
      const probe = window.__restartRenderProbe; probe.phase = 'held'; probe.armed = true;
      const dust = document.getElementById('dustRemovalEnabled');
      // Same event turn cancels the scheduled detector, without running AI.
      dust.click(); dust.click();
    })()`);
    await until('actual exposure-24 full worker result held', '!!window.__restartRenderProbe.held');
    await evaluate(`(() => {
      window.__restartRenderProbe.phase = 'restart';
      document.getElementById('studioRestart').click();
    })()`);
    await until('restart confirmation', `!!document.querySelector('[data-app-dialog-confirm]')`, 5000);
    await evaluate(`document.querySelector('[data-app-dialog-confirm]').click()`);
    // Do not export yet: a correct export barrier must wait for the held full
    // request. The separate preview worker can finish the reset independently.
    await until('fresh exposure-0 reset preview', `Number(document.getElementById('coreExposure').value) === 0
      && document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy
      && window.__restartRenderProbe.delivered.some(r => r.phase === 'restart' && r.preview === true && r.exposure === 0)`, 10000);
    expect(await evaluate('window.__restartRenderProbe.release()'), 'the real held response was not released');
    const actual = await exportPixels();
    const evidence = await evaluate(`(() => {
      const p = window.__restartRenderProbe;
      return { control: Number(document.getElementById('coreExposure').value), held: p.held,
        released: p.released, timedOut: p.timedOut, requests: p.requests, delivered: p.delivered };
    })()`);
    const sameSize = actual.width === baseline.width && actual.height === baseline.height;
    const equalsBaseline = sameSize && actual.rgba.equals(baseline.rgba);
    const equalsEdited = actual.rgba.equals(edited.rgba);
    console.log('restart render:', JSON.stringify({ ...evidence, dimensions: [actual.width, actual.height],
      baselineSHA256: baseline.sha256, editedSHA256: edited.sha256, actualSHA256: actual.sha256,
      equalsBaseline, equalsEdited, comparedRGBABytes: actual.rgba.length }));
    expect(evidence.released === 1 && !evidence.timedOut && evidence.control === 0
      && evidence.held.rgbaBytes === baseline.rgba.length
      && evidence.held.resultWidth === baseline.width && evidence.held.resultHeight === baseline.height,
    'restart scenario did not release exactly one real full-resolution stale result at reset controls');
    expect(equalsBaseline && !equalsEdited, 'restart allowed stale exposure-24 pixels to replace the exposure-0 export');
    console.log('ok: restarted export matches every exposure-0 RGBA byte after delayed real worker delivery');
  } catch (error) {
    failure = error;
    const diagnostics = await evaluate(`(() => {
      const p = window.__restartRenderProbe;
      return { control: document.getElementById('coreExposure')?.value,
        held: p?.held, released: p?.released, timedOut: p?.timedOut,
        requests: p?.requests, delivered: p?.delivered,
        exports: p?.exports.map(e => ({ name: e.name, ready: !!e.data, error: e.error })) };
    })()`);
    console.error('restart diagnostics:', JSON.stringify(diagnostics));
  } finally {
    await evaluate('window.__restoreRestartRenderProbe?.()');
  }
  if (failure) fail(failure.stack || String(failure));
}
