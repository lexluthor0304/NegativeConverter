import { createHash } from 'node:crypto';

// Runs on geometry-smoke's genuine 16-bit tilted scan (4.08 MP), after its
// original checks. Exercise real IndexedDB and the editor/export/history paths.
export async function runGeometryArchiveSmoke({ evaluate, waitFor, wait, fail }) {
  const idle = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy
    && document.body.dataset.photoSwitching !== 'true' && !document.querySelector('.loading-overlay.visible')`;
  const detected = `/^Detected [0-9]+ dust particles$/.test(document.getElementById('dustStatus').textContent)`;
  await evaluate(`document.getElementById('mirrorBtn').click()`);
  await waitFor('archive geometry mirror', idle, 120_000);
  const geometry = await evaluate(`window.__ncGeometry.inspect({ chain: true })`);
  if (!geometry.descriptor || !geometry.mirrored || geometry.hash16 !== geometry.chainHash16) {
    fail('archive fixture must have genuine rotated/mirrored/cropped 16-bit geometry: ' + JSON.stringify(geometry));
  }
  await evaluate(`(() => {
    window.__geometryDownloads = [];
    const pending = new Set(), revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = url => { if (!pending.has(url)) revoke(url); };
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download || !this.href.startsWith('blob:')) return;
      const url = this.href; pending.add(url);
      window.__geometryDownloads.push(fetch(url).then(r => r.blob()).then(blob => new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => { pending.delete(url); revoke(url); resolve(reader.result); };
        reader.readAsDataURL(blob);
      })));
    };
    document.getElementById('studioTab-repair').click();
    if (document.getElementById('dustAiEnabled').checked) document.getElementById('dustAiEnabled').click();
    if (!document.getElementById('dustRemovalEnabled').checked) document.getElementById('dustRemovalEnabled').click();
  })()`);
  await waitFor('archive geometry dust settled', `${idle} && ${detected}`, 120_000);
  const exportBoth = async label => {
    const hashes = {};
    for (const format of ['png', 'tiff']) {
      await evaluate(`(() => {
        document.querySelector('.format-btn[data-format="${format}"]').click();
        document.querySelector('.bitdepth-btn[data-bitdepth="16"]').click();
        window.__geometryDownloads = [];
        document.getElementById('exportSingleBtn').click();
      })()`);
      await waitFor(`${label}: ${format}16 download`, `window.__geometryDownloads.length > 0`, 120_000);
      const url = await evaluate(`window.__geometryDownloads.shift()`);
      await waitFor(`${label}: export complete`, `${idle} && !document.getElementById('exportSingleBtn').disabled`, 60_000);
      hashes[format] = createHash('sha256').update(Buffer.from(url.split(',')[1], 'base64')).digest('hex');
    }
    return hashes;
  };
  const beforeStroke = await exportBoth('geometry before stroke');
  await evaluate(`(() => { if (!document.getElementById('dustShowMask').checked) document.getElementById('dustShowMask').click(); })()`);
  await waitFor('archive geometry dust worker pinned', `(async () => {
    const { dustWorker } = await import('/src/app/dustWorkerClient.js'); return dustWorker.pinned && dustWorker.maskTag !== null;
  })()`, 30_000);
  await wait(500);
  await evaluate(`(() => {
    const surface = [...document.querySelectorAll('#canvas, #glCanvas')].find(el => getComputedStyle(el).display !== 'none');
    const r = surface.getBoundingClientRect();
    const at = dx => ({ bubbles: true, cancelable: true, pointerId: 29, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
      clientX: r.x + r.width * 0.4 + dx, clientY: r.y + r.height * 0.45, altKey: true });
    surface.dispatchEvent(new PointerEvent('pointerdown', at(0)));
    surface.dispatchEvent(new PointerEvent('pointermove', at(12)));
    surface.dispatchEvent(new PointerEvent('pointerup', { ...at(12), buttons: 0 }));
  })()`);
  await wait(500);
  await waitFor('archive geometry stroke committed', `${idle} && ${detected}`, 60_000);
  await evaluate(`document.getElementById('dustShowMask').click()`);
  const afterStroke = await exportBoth('geometry after stroke');
  if (JSON.stringify(afterStroke) === JSON.stringify(beforeStroke)) fail('geometry brush stroke did not change the exported pixels');
  const parked = await evaluate(`(async () => {
    const previous = localStorage.getItem('nc_hidden_park_v1');
    localStorage.setItem('nc_hidden_park_v1', 'on');
    const sync = window.__ncGeometry.diagnostics.frameSyncReads;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      const before = window.__ncHiddenJobs.status().residentBytes;
      const parked = await window.__ncHiddenJobs.parkOpenPhoto();
      return { parked, before, after: window.__ncHiddenJobs.status().residentBytes,
        sync, afterSync: window.__ncGeometry.diagnostics.frameSyncReads };
    } finally {
      delete document.visibilityState; document.dispatchEvent(new Event('visibilitychange'));
      if (previous === null) localStorage.removeItem('nc_hidden_park_v1'); else localStorage.setItem('nc_hidden_park_v1', previous);
    }
  })()`);
  if (!parked.parked || parked.after >= parked.before || parked.sync !== parked.afterSync) fail('geometry parking expanded or retained planes: ' + JSON.stringify(parked));
  await waitFor('archive geometry restored', `${idle} && ${detected}`, 120_000);
  const restoredGeometry = await evaluate(`window.__ncGeometry.inspect({ chain: true })`);
  if (!restoredGeometry.descriptor || restoredGeometry.hash16 !== geometry.hash16 || restoredGeometry.hash16 !== restoredGeometry.chainHash16) {
    fail('parking lost lazy geometry or exact 16-bit pixels: ' + JSON.stringify(restoredGeometry));
  }
  const restored = await exportBoth('geometry restored');
  if (JSON.stringify(restored) !== JSON.stringify(afterStroke)) fail('geometry parking changed PNG16/TIFF16 exports');
  await evaluate(`document.getElementById('undoBtn').click()`); await wait(500);
  await waitFor('archive geometry brush undo', `${idle} && ${detected}`, 60_000);
  if (JSON.stringify(await exportBoth('geometry brush undo')) !== JSON.stringify(beforeStroke)) fail('archived geometry brush undo changed 16-bit exports');
  await evaluate(`document.getElementById('redoBtn').click()`); await wait(500);
  await waitFor('archive geometry brush redo', `${idle} && ${detected}`, 60_000);
  if (JSON.stringify(await exportBoth('geometry brush redo')) !== JSON.stringify(afterStroke)) fail('archived geometry brush redo changed 16-bit exports');
  if (await evaluate(`window.__ncGeometry.diagnostics.frameSyncReads`) !== parked.sync) fail('archive restoration forced lazy frame materialization');
  console.log('ok: real IndexedDB preserves lazy transformed geometry, exact PNG16/TIFF16 brush undo/redo and releases planes', JSON.stringify(parked));
}
