// Camera-scanning smoke: a blank light-pad frame becomes the roll's flat
// field and flattens a negative shot on the same pad.
import { join } from 'node:path';
import { createRequire } from 'node:module';

const UPNG = createRequire(import.meta.url)('upng-js');

export async function runCameraSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const fixtures = ['lightpad-blank.png', 'negative-vignetted.png'].map((name) => join(root, 'negative2positive', 'test-fixtures', name));
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('camera workspace boot', `!!document.getElementById('fileInput') && !!document.getElementById('flatFieldUseCurrentBtn')`);
  await installDialogAutoAccept();
  await wait(300);
  await evaluate(`(() => {
    window.__cameraToasts = [];
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) window.__cameraToasts.push(node.textContent);
    }).observe(document.getElementById('toastContainer'), { childList: true });
  })()`);
  const doc = await send('DOM.getDocument');
  const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
  if (!input.result?.nodeId) fail('#fileInput not found');
  await send('DOM.setFileInputFiles', { files: fixtures, nodeId: input.result.nodeId });
  const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
  await waitFor('blank frame opened', `${ready} && document.getElementById('studioFilename').textContent === 'lightpad-blank.png'`, 150_000);
  await wait(600);

  const luminance = async (region) => {
    const rect = await evaluate(`(() => {
      const gl = document.getElementById('glCanvas');
      const el = gl && getComputedStyle(gl).display !== 'none' ? gl : document.getElementById('canvas');
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    })()`);
    const clip = { x: rect.x + rect.width * region.x, y: rect.y + rect.height * region.y, width: Math.max(2, rect.width * region.w), height: Math.max(2, rect.height * region.h), scale: 1 };
    const shot = await send('Page.captureScreenshot', { format: 'png', clip });
    const png = UPNG.decode(Buffer.from(shot.result.data, 'base64'));
    const d = new Uint8Array(UPNG.toRGBA8(png)[0]);
    let sum = 0; let n = 0;
    for (let i = 0; i < d.length; i += 4) { sum += Math.pow((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255, 2.2); n++; }
    return sum / n;
  };
  // Corner patches versus a patch at the top edge centre: the same negative
  // density everywhere, so the only difference is the pad's falloff.
  const deviation = async () => {
    const reference = await luminance({ x: 0.45, y: 0.03, w: 0.1, h: 0.08 });
    const corners = [];
    for (const [x, y] of [[0.02, 0.02], [0.88, 0.02], [0.02, 0.88], [0.88, 0.88]]) corners.push(await luminance({ x, y, w: 0.1, h: 0.1 }));
    return Math.max(...corners.map((c) => Math.abs(c / reference - 1)));
  };

  await evaluate(`document.getElementById('studioTab-repair').click(); document.getElementById('studioFlatField').open = true;`);
  const initial = await evaluate(`(() => ({
    status: document.getElementById('flatFieldStatus').textContent,
    useEnabled: !document.getElementById('flatFieldUseCurrentBtn').disabled,
    checkboxDisabled: document.getElementById('flatFieldEnabled').disabled
  }))()`);
  if (!/No flat field yet/.test(initial.status) || !initial.useEnabled || !initial.checkboxDisabled) fail('flat field initial state wrong: ' + JSON.stringify(initial));
  await evaluate(`document.getElementById('flatFieldUseCurrentBtn').click()`);
  await waitFor('flat field built', `/corner falloff \\d+ %/.test(document.getElementById('flatFieldStatus').textContent)`, 20_000);
  const built = await evaluate(`document.getElementById('flatFieldStatus').textContent`);
  console.log('camera flat field:', built);
  const falloff = Number((built.match(/corner falloff (\d+) %/) || [])[1]);
  if (!(falloff >= 20 && falloff <= 40)) fail('measured falloff is not the 30 % of the fixture: ' + built);
  if (!(await evaluate(`window.__cameraToasts.some((t) => /Flat field applied to 1 photo/.test(t))`))) fail('flat field apply toast missing');

  await evaluate(`document.querySelectorAll('.file-list-name')[1].click()`);
  await waitFor('vignetted negative opened', `${ready} && document.getElementById('studioFilename').textContent === 'negative-vignetted.png'`, 150_000);
  await wait(1500);
  const applied = await evaluate(`document.getElementById('flatFieldEnabled').checked`);
  if (!applied) fail('the negative did not receive the flat field');
  const corrected = await deviation();
  await evaluate(`(() => { const el = document.getElementById('flatFieldEnabled'); el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await wait(2500);
  const raw = await deviation();
  console.log('camera flat field deviation:', JSON.stringify({ raw, corrected }));
  if (!(raw > 0.12)) fail(`fixture without correction should show corner falloff: ${raw}`);
  if (!(corrected < raw * 0.5 && corrected < 0.08)) fail(`flat field did not flatten the corners: raw ${raw} corrected ${corrected}`);
  await evaluate(`(() => { const el = document.getElementById('flatFieldEnabled'); el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await wait(2500);
  const again = await deviation();
  if (!(again < 0.08)) fail(`re-enabling the flat field did not restore the correction: ${again}`);

  await evaluate(`document.getElementById('flatFieldClearBtn').click()`);
  await waitFor('flat field cleared', `/No flat field yet/.test(document.getElementById('flatFieldStatus').textContent) && document.getElementById('flatFieldEnabled').disabled`, 10_000);
  await wait(2500);
  const cleared = await deviation();
  if (!(cleared > 0.12)) fail(`clearing the flat field did not bring the falloff back: ${cleared}`);

  console.log('ok: a blank light-pad frame becomes the flat field, flattens the vignetted negative when applied, and clears cleanly');
}
