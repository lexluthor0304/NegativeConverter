// Film edge reader smoke: a synthetic 35mm strip with DX edge barcodes
// (test-fixtures/negative-strip-dx.png, DX 95-7 = Kodak Ultra Max 400) is
// imported through the real file input. The import must decode the code, name
// the stock, offer its preset and the rebate film base, badge the file, and a
// plain frame without perforations (negative-plain.png) must report that no
// code was found. The older negative-sample fixtures carry the app's own
// rendered border with DX 82-3, so they are not usable as a negative control.
import { join } from 'node:path';

export async function runFilmEdgeSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const strip = join(root, 'negative2positive', 'test-fixtures', 'negative-strip-dx.png');
  const plain = join(root, 'negative2positive', 'test-fixtures', 'negative-plain.png');

  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('film edge workspace boot', `!!document.getElementById('fileInput') && !!document.getElementById('filmEdgeGroup')`);
  await installDialogAutoAccept();
  await wait(300);
  await evaluate(`(() => {
    window.__filmEdgeToasts = [];
    const container = document.getElementById('toastContainer');
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node.nodeType === 1) window.__filmEdgeToasts.push(node.textContent);
      }
    }).observe(container, { childList: true });
  })()`);

  const setFiles = async (files) => {
    const doc = await send('DOM.getDocument');
    const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
    if (!input.result?.nodeId) fail('#fileInput not found');
    await send('DOM.setFileInputFiles', { files, nodeId: input.result.nodeId });
  };

  await setFiles([strip, plain]);
  await waitFor('strip imported and converted',
    `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy && document.getElementById('studioFilename').textContent === 'negative-strip-dx.png'`,
    150_000);
  await wait(800);

  const detected = await evaluate(`(() => ({
    toasts: window.__filmEdgeToasts.slice(),
    groupVisible: document.getElementById('filmEdgeGroup').style.display !== 'none',
    status: document.getElementById('filmEdgeStatus').textContent,
    preset: document.getElementById('filmPreset').value,
    filmType: document.querySelector('.film-type-btn.active')?.dataset.type,
    filmBase: document.getElementById('filmBaseValues').textContent,
    badges: [...document.querySelectorAll('.file-list-badge.film-stock')].map((el) => el.textContent),
    applyVisible: document.getElementById('applyFilmEdgePresetBtn').style.display !== 'none',
    baseVisible: document.getElementById('useFilmEdgeBaseBtn').style.display !== 'none'
  }))()`);
  console.log('film edge evidence:', JSON.stringify(detected));
  if (!detected.groupVisible) fail('film edge group is hidden after importing a strip with DX codes');
  if (!/95-7/.test(detected.status) || !/ULTRA MAX 400/i.test(detected.status)) fail('film edge status does not name DX 95-7 / Ultra Max: ' + detected.status);
  if (!/frames 30–32/.test(detected.status)) fail('film edge status does not list the decoded frame range: ' + detected.status);
  if (!detected.toasts.some((t) => /Detected .*ULTRA MAX 400.*DX 95-7.*under Film edge/i.test(t))) fail('detection toast missing: ' + JSON.stringify(detected.toasts));
  if (detected.toasts.some((t) => /preset applied|film base from the rebate/i.test(t))) fail('detection must only suggest, not apply: ' + JSON.stringify(detected.toasts));
  // Detection suggests; the preset and the rebate base are applied only through the buttons.
  if (detected.preset !== 'none') fail('the detected preset was applied on import: ' + detected.preset);
  if (detected.filmType !== 'color') fail('film type changed unexpectedly: ' + detected.filmType);
  const readBase = (text) => {
    const m = text.match(/R: (\d+) G: (\d+) B: (\d+)/);
    if (!m) fail('film base values not shown: ' + text);
    return m.slice(1).map(Number);
  };
  const [r0, g0, b0] = readBase(detected.filmBase);
  // The synthetic rebate is (215,150,95); the import keeps the border auto-detect, which lands elsewhere.
  if (Math.abs(r0 - 215) <= 6 && Math.abs(g0 - 150) <= 6 && Math.abs(b0 - 95) <= 6) fail('film base was taken from the rebate on import: ' + detected.filmBase);
  if (!detected.badges.some((t) => /ULTRA MAX/i.test(t))) fail('file list has no film stock badge: ' + JSON.stringify(detected.badges));
  if (!detected.applyVisible) fail('apply detected film button hidden');
  if (!detected.baseVisible) fail('rebate film base button hidden');

  // Manual path: the buttons apply the rebate base and the detected film.
  await evaluate(`document.getElementById('useFilmEdgeBaseBtn').click()`);
  await waitFor('rebate base applied', `/Film base taken from the unexposed rebate/.test(window.__filmEdgeToasts.at(-1) || '')`, 20_000);
  const [r, g, b] = readBase(await evaluate(`document.getElementById('filmBaseValues').textContent`));
  if (Math.abs(r - 215) > 6 || Math.abs(g - 150) > 6 || Math.abs(b - 95) > 6) fail('film base button did not take the rebate: ' + [r, g, b]);
  await evaluate(`document.getElementById('applyFilmEdgePresetBtn').click()`);
  await waitFor('detected film applied', `document.getElementById('filmPreset').value === 'gold-warm'`, 20_000);
  const applied = await evaluate(`window.__filmEdgeToasts.at(-1)`);
  if (!/Applied the .*ULTRA MAX 400.* preset/i.test(applied)) fail('apply button toast missing: ' + applied);

  // A frame without perforations reports no code and gets no badge.
  await evaluate(`document.querySelectorAll('.file-list-name')[1].click()`);
  await waitFor('plain frame opened',
    `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy && document.getElementById('studioFilename').textContent === 'negative-plain.png'`,
    150_000);
  await wait(500);
  const plainResult = await evaluate(`(() => ({
    groupVisible: document.getElementById('filmEdgeGroup').style.display !== 'none',
    status: document.getElementById('filmEdgeStatus').textContent,
    badges: [...document.querySelectorAll('.file-list-item')].map((el) => el.querySelector('.file-list-badge.film-stock')?.textContent || null),
    applyVisible: document.getElementById('applyFilmEdgePresetBtn').style.display !== 'none'
  }))()`);
  console.log('film edge plain-frame evidence:', JSON.stringify(plainResult));
  if (!plainResult.groupVisible || !/No DX edge code found/.test(plainResult.status)) fail('plain frame did not report a missing code: ' + JSON.stringify(plainResult));
  if (plainResult.applyVisible) fail('apply button shown without a detected film');
  if (!plainResult.badges[0] || plainResult.badges[1]) fail('badges are not per file: ' + JSON.stringify(plainResult.badges));

  console.log('ok: film edge reader decodes DX 95-7 on import, offers the Ultra Max preset and rebate film base through the buttons, badges the strip and stays quiet on a plain frame');
}
