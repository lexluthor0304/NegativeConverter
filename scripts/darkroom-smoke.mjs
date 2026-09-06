// Darkroom smoke: test strip, enlarger paradigm, paper emulation and the
// dodge & burn brush on the synthetic Ultra Max strip fixture.
import { join } from 'node:path';
import { createRequire } from 'node:module';

const UPNG = createRequire(import.meta.url)('upng-js');

export async function runDarkroomSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const fixture = join(root, 'negative2positive', 'test-fixtures', 'negative-strip-dx.png');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('darkroom workspace boot', `!!document.getElementById('fileInput') && !!document.getElementById('testStripRenderBtn')`);
  await installDialogAutoAccept();
  await wait(300);
  await evaluate(`(() => {
    window.__darkroomToasts = [];
    new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) window.__darkroomToasts.push(node.textContent);
    }).observe(document.getElementById('toastContainer'), { childList: true });
  })()`);
  const doc = await send('DOM.getDocument');
  const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
  if (!input.result?.nodeId) fail('#fileInput not found');
  await send('DOM.setFileInputFiles', { files: [fixture], nodeId: input.result.nodeId });
  const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;
  await waitFor('darkroom fixture converted', `${ready} && document.getElementById('studioFilename').textContent === 'negative-strip-dx.png'`, 150_000);
  await wait(800);

  const setInput = (id, value) => evaluate(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    el.value = ${JSON.stringify(String(value))};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  })()`);
  // Mean luminance of a region (fractions of the visible preview canvas),
  // taken from a screenshot so it works for the WebGL and the 2D canvas alike.
  const canvasLuminance = async (region) => {
    const r = region || { x: 0, y: 0, w: 1, h: 1 };
    const rect = await evaluate(`(() => {
      const gl = document.getElementById('glCanvas');
      const el = gl && getComputedStyle(gl).display !== 'none' ? gl : document.getElementById('canvas');
      const b = el.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    })()`);
    const clip = { x: rect.x + rect.width * r.x, y: rect.y + rect.height * r.y, width: Math.max(2, rect.width * r.w), height: Math.max(2, rect.height * r.h), scale: 1 };
    const shot = await send('Page.captureScreenshot', { format: 'png', clip });
    const png = UPNG.decode(Buffer.from(shot.result.data, 'base64'));
    const d = new Uint8Array(UPNG.toRGBA8(png)[0]);
    let sum = 0; let n = 0;
    for (let i = 0; i < d.length; i += 4) { sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
    return sum / n;
  };

  // ---- 1. Test strip ----
  await evaluate(`document.getElementById('studioTab-edit').click(); document.getElementById('studioTestStrip').open = true;`);
  await setInput('testStripAxis', 'coreExposure');
  await setInput('testStripStep', '20');
  await evaluate(`document.getElementById('testStripRenderBtn').click()`);
  await waitFor('test strip rendered', `document.querySelectorAll('#testStripTiles .test-strip-tile').length === 5`, 30_000);
  const strip = await evaluate(`(() => ({
    labels: [...document.querySelectorAll('#testStripTiles .test-strip-tile span')].map((el) => el.textContent),
    current: [...document.querySelectorAll('#testStripTiles .test-strip-tile')].map((el) => el.classList.contains('current')),
    canvases: [...document.querySelectorAll('#testStripTiles canvas')].map((c) => c.width > 40 && c.height > 20),
    exposure: document.getElementById('coreExposureValue').value
  }))()`);
  console.log('darkroom test strip:', JSON.stringify(strip));
  if (strip.labels.join(',') !== '-40,-20,0,+20,+40' || !strip.current[2] || strip.canvases.some((ok) => !ok)) fail('test strip patches wrong: ' + JSON.stringify(strip));
  // The patches differ from each other (a real render, not five copies).
  const patchMeans = await evaluate(`[...document.querySelectorAll('#testStripTiles canvas')].map((c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return s / (d.length / 4) / 3; })`);
  console.log('darkroom patch means:', JSON.stringify(patchMeans.map((m) => m.toFixed(1))));
  if (!(patchMeans[4] > patchMeans[0] + 4)) fail('brightness patches do not brighten along the strip: ' + JSON.stringify(patchMeans));
  await evaluate(`document.querySelectorAll('#testStripTiles .test-strip-tile')[3].click()`);
  await waitFor('test strip applied', `document.getElementById('coreExposureValue').value === '20'`, 10_000);
  if (!(await evaluate(`window.__darkroomToasts.some((t) => /Applied \\+20/.test(t))`))) fail('test strip apply toast missing');
  await waitFor('test strip re-rendered around 20', `[...document.querySelectorAll('#testStripTiles .test-strip-tile span')].map((el) => el.textContent).join(',') === '-20,0,+20,+40,+60'`, 30_000);
  // Shift-click narrows the step.
  await evaluate(`document.querySelectorAll('#testStripTiles .test-strip-tile')[2].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))`);
  await waitFor('test strip narrowed', `document.getElementById('testStripStep').value === '10'`, 10_000);
  await evaluate(`document.getElementById('undoBtn').click(); document.getElementById('undoBtn').click();`);
  await waitFor('test strip undone', `document.getElementById('coreExposureValue').value === '0'`, 10_000);

  // ---- 2. Enlarger paradigm ----
  const before = await canvasLuminance();
  await evaluate(`document.getElementById('paradigmEnlargerBtn').click()`);
  const paradigm = await evaluate(`(() => ({
    enlarger: document.body.classList.contains('studio-enlarger'),
    slidersHidden: getComputedStyle(document.getElementById('studioSliders')).display === 'none',
    controlsShown: getComputedStyle(document.getElementById('enlargerControls')).display !== 'none',
    magenta: document.getElementById('enlargerMagenta').value,
    yellow: document.getElementById('enlargerYellow').value,
    cyan: document.getElementById('enlargerCyan').value,
    gradeHidden: getComputedStyle(document.getElementById('enlargerGradeControl')).display === 'none'
  }))()`);
  console.log('darkroom paradigm:', JSON.stringify(paradigm));
  if (!paradigm.enlarger || !paradigm.slidersHidden || !paradigm.controlsShown) fail('enlarger paradigm did not switch: ' + JSON.stringify(paradigm));
  if (paradigm.magenta !== '50' || paradigm.yellow !== '40' || paradigm.cyan !== '20') fail('reference pack is not shown for neutral sliders: ' + JSON.stringify(paradigm));
  if (!paradigm.gradeHidden) fail('paper grade must be hidden for colour film');
  await wait(300);
  const afterToggle = await canvasLuminance();
  if (Math.abs(afterToggle - before) > 0.5) fail(`switching paradigm changed the image: ${before} -> ${afterToggle}`);
  await setInput('enlargerMagenta', '60');
  await waitFor('magenta filtration applied', `document.getElementById('coreTintValue').value === '-10'`, 10_000);
  await setInput('enlargerYellow', '30');
  await waitFor('yellow filtration applied', `document.getElementById('coreTemperatureValue').value === '10'`, 10_000);
  await setInput('enlargerExposure', '0.5');
  // +0.5 stop at mid grey inverts to about 39 slider units (1 - (1-x)^(1+0.02e)).
  await waitFor('exposure in stops applied', `Number(document.getElementById('coreExposureValue').value) >= 30 && Number(document.getElementById('coreExposureValue').value) <= 50`, 10_000);
  // Digital sliders feed back into the head.
  await evaluate(`document.getElementById('paradigmDigitalBtn').click()`);
  await setInput('coreTintValue', '0');
  await wait(300);
  const feedback = await evaluate(`document.getElementById('enlargerMagenta').value`);
  if (feedback !== '50') fail('digital tint change did not update the magenta filtration: ' + feedback);
  await setInput('coreTemperatureValue', '0');
  await setInput('coreExposureValue', '0');
  await wait(1500);

  // ---- 3. Paper emulation ----
  await evaluate(`document.getElementById('studioLooks').open = true;`);
  const paperOptions = await evaluate(`[...document.getElementById('corePaper').options].map((o) => o.value)`);
  if (!paperOptions.includes('endura') || paperOptions.includes('multigrade-rc')) fail('colour film must offer RA-4 papers only: ' + JSON.stringify(paperOptions));
  const plain = await canvasLuminance({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  await setInput('corePaper', 'crystal-archive-matte');
  await wait(1800);
  const printed = await canvasLuminance({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  console.log('darkroom paper:', JSON.stringify({ plain, printed }));
  if (Math.abs(printed - plain) < 1) fail(`paper emulation did not change the print: ${plain} -> ${printed}`);
  await setInput('corePaper', 'none');
  await wait(1800);
  const restored = await canvasLuminance({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  if (Math.abs(restored - plain) > 1) fail(`paper "none" did not restore the image: ${plain} -> ${restored}`);

  // ---- 4. Dodge and burn ----
  await evaluate(`document.getElementById('studioTab-repair').click(); document.getElementById('studioDodgeBurn').open = true;`);
  await evaluate(`(() => { const el = document.getElementById('dodgeBurnEnabled'); el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor('dodge burn active', `document.body.classList.contains('dodge-burn-active')`, 5_000);
  await evaluate(`(() => { const el = document.getElementById('dodgeBurnShowOverlay'); el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await setInput('dodgeBurnStops', '1.5');
  await setInput('dodgeBurnSize', '30');
  await wait(500);
  const region = { x: 0.3, y: 0.3, w: 0.4, h: 0.4 };
  const untouched = await canvasLuminance(region);
  const rect = await evaluate(`(() => { const r = document.getElementById('canvas').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: type === 'mousePressed' ? 1 : 0, buttons: type === 'mouseReleased' ? 0 : 1 });
  const y = rect.y + rect.height * 0.5;
  await mouse('mousePressed', rect.x + rect.width * 0.35, y);
  for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', rect.x + rect.width * (0.35 + 0.3 * i / 8), y); await wait(30); }
  await mouse('mouseReleased', rect.x + rect.width * 0.65, y);
  await waitFor('stroke recorded', `/1 stroke/.test(document.getElementById('dodgeBurnStatus').textContent)`, 10_000);
  await wait(2500);
  const burned = await canvasLuminance(region);
  console.log('darkroom burn:', JSON.stringify({ untouched, burned }));
  if (!(burned < untouched - 3)) fail(`burn stroke did not darken the region: ${untouched} -> ${burned}`);
  await evaluate(`document.getElementById('dodgeBurnUndoStrokeBtn').click()`);
  await waitFor('stroke removed', `/No strokes/.test(document.getElementById('dodgeBurnStatus').textContent)`, 10_000);
  await wait(2500);
  const cleared = await canvasLuminance(region);
  if (Math.abs(cleared - untouched) > 1.5) fail(`removing the stroke did not restore the region: ${untouched} -> ${cleared}`);
  await evaluate(`(() => { const el = document.getElementById('dodgeBurnEnabled'); el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor('dodge burn inactive', `!document.body.classList.contains('dodge-burn-active')`, 5_000);

  console.log('ok: test strip renders and applies with undo, enlarger filtration maps to the core sliders both ways, paper emulation changes and restores the print, a burn stroke darkens its region and can be removed');
}
