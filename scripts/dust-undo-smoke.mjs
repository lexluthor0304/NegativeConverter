// Undo across a step that converts the frame again (#259, #229 review
// R1-105) in a real browser, with TELEA (AI repair off) on the 1.8 MP
// negative-sample.jpg: dust removal, one direct dust-brush stroke (a
// refinement no detection makes), then an Exposure drag, which converts the
// frame again and detects dust on it. Undo converts the frame again but
// detects nothing: the particle count and the stroke's refinement come back,
// and the PNG 8-bit and TIFF 16-bit exports equal, byte for byte, those made
// before the drag. Redo brings the drag's state back, and a second undo the
// state before it, again without a detection.
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
const exportIdle = `${ready} && !document.getElementById('exportSingleBtn').disabled && !document.querySelector('.loading-overlay.visible')`;
const detected = `/^Detected [0-9]+ dust particles$/.test(document.getElementById('dustStatus').textContent)`;

export async function runDustUndoSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const fixture = join(root, 'negative2positive', 'test-fixtures', 'negative-sample.jpg');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('dust undo: boot', `!!document.getElementById('studioImportAutoCrop')`);
  await installDialogAutoAccept();
  await evaluate(`(() => {
    window.__downloads = [];
    const pendingUrls = new Set();
    const origRevoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => { if (!pendingUrls.has(url)) origRevoke(url); };
    HTMLAnchorElement.prototype.click = function () {
      if (this.download && this.href.startsWith('blob:')) {
        const href = this.href; const name = this.download;
        pendingUrls.add(href);
        window.__downloads.push(fetch(href).then((r) => r.blob()).then((blob) => new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => { pendingUrls.delete(href); origRevoke(href); resolve({ name, dataUrl: reader.result }); };
          reader.readAsDataURL(blob);
        })));
      }
    };
  })()`);
  await wait(300);
  const doc = await send('DOM.getDocument');
  const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
  await send('DOM.setFileInputFiles', { files: [fixture], nodeId: input.result.nodeId });
  await waitFor('dust undo: photo', `${ready} && document.getElementById('studioFilename').textContent === 'negative-sample.jpg'`, 150_000);

  // Dust-worker detections, conversions and dust status writes.
  await evaluate(`(() => {
    window.__undoProbe = { detect: 0, convert: 0, status: 0 };
    new MutationObserver(() => window.__undoProbe.status++).observe(document.getElementById('dustStatus'), { childList: true });
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...args) {
      if (message?.type === 'detect') window.__undoProbe.detect++;
      if (message?.type === 'convert') window.__undoProbe.convert++;
      return post.call(this, message, ...args);
    };
    document.getElementById('studioTab-repair').click();
    if (document.getElementById('dustAiEnabled').checked) document.getElementById('dustAiEnabled').click();
    document.getElementById('dustRemovalEnabled').click();
  })()`);
  await waitFor('dust undo: first detection', `${ready} && ${detected} && window.__undoProbe.detect > 0`, 120_000);

  const resetProbe = () => evaluate(`(() => { Object.assign(window.__undoProbe, { detect: 0, convert: 0, status: 0 }); })()`);
  const probe = () => evaluate(`({ ...window.__undoProbe, status: window.__undoProbe.status,
    text: document.getElementById('dustStatus').textContent, exposure: document.getElementById('coreExposureValue').value })`);
  // After a step: its conversion, then the dust pass it schedules (Processing,
  // then the count), and the app idle again.
  const settled = async (label, { conversion = true } = {}) => {
    await waitFor(`${label}: settled`, `${ready} && ${detected} && window.__undoProbe.status >= 2
      && (${!conversion} || window.__undoProbe.convert > 0)`, 120_000);
    await wait(1500);
    await waitFor(`${label}: idle`, `${ready} && ${detected}`, 60_000);
    return probe();
  };
  const exportFile = async (label, format, bitDepth) => {
    await evaluate(`(() => {
      document.querySelector('.format-btn[data-format="${format}"]').click();
      document.querySelector('.bitdepth-btn[data-bitdepth="${bitDepth}"]').click();
      window.__downloads = [];
      document.getElementById('exportSingleBtn').click();
    })()`);
    await waitFor(`${label}: ${format}${bitDepth} file`, `window.__downloads.length > 0`, 120_000);
    const entry = await evaluate(`window.__downloads.shift()`);
    await waitFor(`${label}: ${format}${bitDepth} export finished`, exportIdle, 60_000);
    const bytes = Buffer.from(entry.dataUrl.split(',')[1], 'base64');
    return createHash('sha256').update(bytes).digest('hex');
  };
  const exportBoth = async (label) => {
    const detections = (await probe()).detect;
    const files = { png8: await exportFile(label, 'png', 8), tiff16: await exportFile(label, 'tiff', 16) };
    if ((await probe()).detect !== detections) fail(`${label}: the export detected dust again`);
    return files;
  };

  // One direct (Alt) stroke away from the centre: mask pixels no detection sets.
  await evaluate(`document.getElementById('dustShowMask').click()`);
  await waitFor('dust undo: dust worker pinned', `(async () => {
    const { dustWorker } = await import('/src/app/dustWorkerClient.js');
    return dustWorker.pinned && dustWorker.maskTag !== null;
  })()`, 30_000);
  await wait(500);
  await resetProbe();
  await evaluate(`(() => {
    const surface = [...document.querySelectorAll('#canvas, #glCanvas')].find(el => getComputedStyle(el).display !== 'none');
    const rect = surface.getBoundingClientRect();
    const at = (dx) => ({ bubbles: true, cancelable: true, pointerId: 13, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
      clientX: rect.x + rect.width * 0.4 + dx, clientY: rect.y + rect.height * 0.45, altKey: true });
    surface.dispatchEvent(new PointerEvent('pointerdown', at(0)));
    surface.dispatchEvent(new PointerEvent('pointermove', at(6)));
    surface.dispatchEvent(new PointerEvent('pointermove', at(12)));
    surface.dispatchEvent(new PointerEvent('pointerup', { ...at(12), buttons: 0 }));
  })()`);
  await waitFor('dust undo: stroke committed', `window.__undoProbe.status > 0 && ${detected}`, 60_000);
  await evaluate(`document.getElementById('dustShowMask').click()`);
  await wait(500);
  await waitFor('dust undo: stroke settled', `${ready} && ${detected}`, 60_000);
  const before = await probe();
  const exportedBefore = await exportBoth('before the drag');

  // An Exposure drag: its undo entry is taken on pointerdown, committed on change.
  await resetProbe();
  await evaluate(`(async () => {
    const slider = document.getElementById('coreExposure');
    slider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    for (const value of [10, 25, 40]) {
      slider.value = String(value);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const dragged = await settled('exposure drag');
  if (!(dragged.detect > 0) || dragged.exposure !== '40') fail('the drag did not convert and detect again: ' + JSON.stringify(dragged));

  const step = async (label, button) => {
    await resetProbe();
    await evaluate(`document.getElementById('${button}').click()`);
    const after = await settled(label);
    if (after.detect !== 0) fail(`${label}: dust was detected again after the conversion: ` + JSON.stringify(after));
    return after;
  };
  const undone = await step('undo', 'undoBtn');
  if (undone.exposure !== before.exposure || undone.text !== before.text) {
    fail('undo did not bring the state before the drag back: ' + JSON.stringify({ before, undone }));
  }
  const exportedAfter = await exportBoth('after the undo');
  if (exportedAfter.png8 !== exportedBefore.png8 || exportedAfter.tiff16 !== exportedBefore.tiff16) {
    fail('the export after the undo differs from the one before the drag: ' + JSON.stringify({ exportedBefore, exportedAfter }));
  }
  const redone = await step('redo', 'redoBtn');
  if (redone.exposure !== dragged.exposure || redone.text !== dragged.text) fail('redo: ' + JSON.stringify({ dragged, redone }));
  const again = await step('second undo', 'undoBtn');
  if (again.exposure !== before.exposure || again.text !== before.text) fail('second undo: ' + JSON.stringify({ before, again }));
  const exportedAgain = { png8: await exportFile('second undo', 'png', 8) };
  if (exportedAgain.png8 !== exportedBefore.png8) fail('the export after the second undo differs: ' + JSON.stringify({ exportedBefore, exportedAgain }));
  console.log(`ok: undo across an Exposure drag keeps the dust state (${before.text}; ${dragged.text} after the drag) with no detection after its conversion (${undone.convert}/${redone.convert}/${again.convert} conversion messages for undo/redo/undo); PNG8 ${exportedBefore.png8.slice(0, 16)} and TIFF16 ${exportedBefore.tiff16.slice(0, 16)} equal the exports before the drag`);
}
