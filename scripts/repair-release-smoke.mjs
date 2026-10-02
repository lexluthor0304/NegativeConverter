// The #229 review's repair-export exactness (R1-102, R1-078) in a real
// browser, on the bundled MI-GAN model and the WASM provider. #236's idle
// release and #241's hidden-window release drop the model session
// (releaseAiRepairSession, forced here through the ?debug=1 hook). A
// dust-brush stroke after the release patches the repair in place (#259),
// so the export must load the model again and repair from scratch: its PNG
// 8-bit and TIFF 16-bit files equal, byte for byte, those of a session that
// kept its model and brushed the same stroke. A settled repair is exported
// after a release as it is: no load, no tile inferred.
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
const exportIdle = `${ready} && !document.getElementById('exportSingleBtn').disabled && !document.querySelector('.loading-overlay.visible')`;

async function installDownloadCapture(evaluate) {
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
}

export async function runRepairReleaseSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const fixture = join(root, 'negative2positive', 'test-fixtures', 'negative-sample.jpg');
  const state = () => evaluate(`window.__ncAiRepair.state()`);

  const exportFile = async (label, format, bitDepth) => {
    await evaluate(`(() => {
      document.querySelector('.format-btn[data-format="${format}"]').click();
      document.querySelector('.bitdepth-btn[data-bitdepth="${bitDepth}"]').click();
      window.__repairTiles = 0;
      window.__downloads = [];
      document.getElementById('exportSingleBtn').click();
    })()`);
    await waitFor(`${label}: ${format}${bitDepth} file`, `window.__downloads.length > 0`, 300_000);
    const entry = await evaluate(`window.__downloads.shift()`);
    await waitFor(`${label}: ${format}${bitDepth} export finished`, exportIdle, 60_000);
    const bytes = Buffer.from(entry.dataUrl.split(',')[1], 'base64');
    return { name: entry.name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      tiles: await evaluate(`window.__repairTiles`) };
  };

  // The photo, MI-GAN on WASM and dust removal's MI-GAN commit; then
  // `beforeStroke`, one direct (Alt) dust-brush stroke at the centre, and the
  // exports.
  const session = async (label, beforeStroke) => {
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&debug=1` });
    await waitFor(`${label}: boot`, `!!document.getElementById('studioImportAutoCrop') && !!window.__ncAiRepair`);
    await installDialogAutoAccept();
    await installDownloadCapture(evaluate);
    await wait(300);
    const doc = await send('DOM.getDocument');
    const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
    await send('DOM.setFileInputFiles', { files: [fixture], nodeId: input.result.nodeId });
    await waitFor(`${label}: photo`, `${ready} && document.getElementById('studioFilename').textContent === 'negative-sample.jpg'`, 150_000);
    await evaluate(`window.__ncAiRepair.load('wasm')`);
    await waitFor(`${label}: MI-GAN on WASM`, `(() => { const s = window.__ncAiRepair.state(); return s.status === 'ready' && s.provider === 'wasm'; })()`, 300_000);
    await evaluate(`(() => {
      window.__repairTiles = 0;
      window.__dustStatusUpdates = 0;
      window.__strokes = 0;
      new MutationObserver((records) => {
        window.__dustStatusUpdates++;
        for (const record of records) for (const node of record.addedNodes) if (/AI repair: tile/.test(node.textContent)) window.__repairTiles++;
      }).observe(document.getElementById('dustStatus'), { childList: true });
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (message, ...args) {
        if (message?.type === 'stroke') window.__strokes++;
        return post.call(this, message, ...args);
      };
      document.getElementById('studioTab-repair').click();
      if (!document.getElementById('dustAiEnabled').checked) document.getElementById('dustAiEnabled').click();
      document.getElementById('dustRemovalEnabled').click();
    })()`);
    await waitFor(`${label}: MI-GAN dust commit`, `${ready} && /^Detected [0-9]+ dust particles$/.test(document.getElementById('dustStatus').textContent)
      && /last run [1-9][0-9]* tile/.test(document.getElementById('dustAiStatus').textContent)`, 300_000);
    const committed = await state();
    if (committed.provider !== 'wasm' || !committed.tiles) fail(`${label}: the dust commit did not run MI-GAN on WASM: ` + JSON.stringify(committed));
    if (beforeStroke) await beforeStroke(committed);
    await evaluate(`document.getElementById('dustShowMask').click()`);
    await waitFor(`${label}: dust worker pinned`, `(async () => {
      const { dustWorker } = await import('/src/app/dustWorkerClient.js');
      return dustWorker.pinned && dustWorker.maskTag !== null;
    })()`, 30_000);
    await wait(500);
    const stroke = await evaluate(`(() => {
      window.__dustStatusUpdates = 0;
      const surface = [...document.querySelectorAll('#canvas, #glCanvas')].find(el => getComputedStyle(el).display !== 'none');
      const rect = surface.getBoundingClientRect();
      const at = (dx) => ({ bubbles: true, cancelable: true, pointerId: 11, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
        clientX: rect.x + rect.width / 2 + dx, clientY: rect.y + rect.height / 2, altKey: true });
      surface.dispatchEvent(new PointerEvent('pointerdown', at(0)));
      surface.dispatchEvent(new PointerEvent('pointermove', at(4)));
      surface.dispatchEvent(new PointerEvent('pointermove', at(8)));
      surface.dispatchEvent(new PointerEvent('pointerup', { ...at(8), buttons: 0 }));
      return window.__ncBrush.state().photoRect;
    })()`);
    await waitFor(`${label}: stroke committed`, `window.__strokes === 1 && window.__dustStatusUpdates > 0
      && /^Detected [0-9]+ dust particles$/.test(document.getElementById('dustStatus').textContent)`, 60_000);
    // The model's learned refresh of the stroke (a ready model only) settles first.
    await wait(1500);
    await waitFor(`${label}: brush settled`, ready, 60_000);
    await evaluate(`document.getElementById('dustShowMask').click()`);
    await waitFor(`${label}: mask hidden`, ready, 30_000);
    const particles = await evaluate(`document.getElementById('dustStatus').textContent`);
    const before = await state();
    const png8 = await exportFile(label, 'png', 8);
    const afterPng = await state();
    const tiff16 = await exportFile(label, 'tiff', 16);
    return { stroke, particles, committed, before, afterPng, png8, tiff16 };
  };

  // Released before the stroke: the stroke patches with TELEA and no model
  // runs; the export loads the released model (same provider, same revision)
  // and repairs from scratch.
  const released = await session('released', async (committed) => {
    if (await evaluate(`window.__ncAiRepair.release()`) !== true) fail('the idle release did not run: ' + JSON.stringify(await state()));
    const after = await state();
    if (after.status !== 'idle' || !after.released || after.revision !== committed.revision) fail('release state: ' + JSON.stringify(after));
  });
  // The reference: the same photo, model and stroke, never released.
  const kept = await session('kept');
  console.log('repair release parity:', JSON.stringify({ released, kept }, (key, value) => key === 'committed' ? undefined : value));

  if (released.before.status !== 'idle') fail('the released session reloaded the model before its export: ' + JSON.stringify(released.before));
  if (released.afterPng.status !== 'ready' || released.afterPng.provider !== 'wasm' || released.afterPng.revision !== released.committed.revision) {
    fail('the export did not load the released model on its provider under its revision: ' + JSON.stringify(released.afterPng));
  }
  if (!released.png8.tiles || !kept.png8.tiles) fail('an export after a stroke must repair from scratch: ' + JSON.stringify({ released: released.png8, kept: kept.png8 }));
  if (released.tiff16.tiles || kept.tiff16.tiles) fail('the stamped from-scratch repair is exported again without inference: ' + JSON.stringify({ released: released.tiff16, kept: kept.tiff16 }));
  if (JSON.stringify(released.stroke) !== JSON.stringify(kept.stroke) || released.particles !== kept.particles) {
    fail('the two sessions brushed different strokes: ' + JSON.stringify({ released: [released.stroke, released.particles], kept: [kept.stroke, kept.particles] }));
  }
  if (released.png8.sha256 !== kept.png8.sha256) fail('PNG 8-bit after a release differs from the from-scratch MI-GAN export');
  if (released.tiff16.sha256 !== kept.tiff16.sha256) fail('TIFF 16-bit after a release differs from the from-scratch MI-GAN export');
  console.log(`ok: after an idle release, a dust-brush stroke exports the from-scratch MI-GAN repair on WASM (PNG8 ${released.png8.sha256.slice(0, 16)}, TIFF16 ${released.tiff16.sha256.slice(0, 16)}, ${released.png8.tiles} tile(s)), equal to a session that kept its model`);

  // A settled repair after a release (R1-078): exported as it is, with no
  // load and no inference, byte for byte the same file.
  if (await evaluate(`window.__ncAiRepair.release()`) !== true) fail('second release did not run: ' + JSON.stringify(await state()));
  const settled = await exportFile('settled', 'png', 8);
  const afterSettled = await state();
  if (afterSettled.status !== 'idle' || settled.tiles) fail('a settled repair after a release was repaired again: ' + JSON.stringify({ settled, afterSettled }));
  if (settled.sha256 !== kept.png8.sha256) fail('a settled repair after a release exported other pixels');
  console.log('ok: a settled repair exports after a release with no load and no inference, the same PNG8');
}
