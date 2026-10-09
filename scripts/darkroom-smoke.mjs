// Darkroom smoke: test strip, enlarger paradigm, paper emulation and the
// dodge & burn brush on the synthetic Ultra Max strip fixture.
import { join } from 'node:path';
import { createRequire } from 'node:module';

const UPNG = createRequire(import.meta.url)('upng-js');

export async function runDarkroomSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const cpuDisplay = process.env.NC_DARKROOM_CPU === '1';
  const fixture = join(root, 'negative2positive', 'test-fixtures', 'negative-strip-dx.png');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
  await waitFor('darkroom workspace boot', `!!document.getElementById('studioImportAutoCrop') && (!!document.getElementById('fileInput') && !!document.getElementById('testStripRenderBtn'))`);
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
  // Compare the rendered photo itself. Screenshot brightness can change when
  // the controls resize the preview or a background render replaces it.
  // Export waits for the full-resolution render, including the preceding undo.
  await evaluate(`(() => {
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (!this.download || !this.href.startsWith('blob:')) return click.call(this);
      fetch(this.href).then(r => r.blob()).then(blob => {
        const reader = new FileReader();
        reader.onload = () => { window.__darkroomExport = reader.result; };
        reader.readAsDataURL(blob);
      });
    };
    document.querySelector('.format-btn[data-format="png"]').click();
    document.querySelector('.bitdepth-btn[data-bitdepth="8"]').click();
  })()`);
  const exportedPixels = async () => {
    await evaluate(`window.__darkroomExport = null; document.getElementById('exportSingleBtn').click()`);
    await waitFor('darkroom full-resolution export', `!!window.__darkroomExport`, 120_000);
    const dataUrl = await evaluate(`window.__darkroomExport`);
    const png = UPNG.decode(Buffer.from(dataUrl.split(',')[1], 'base64'));
    return { width: png.width, height: png.height, pixels: Buffer.from(UPNG.toRGBA8(png)[0]) };
  };
  const before = await exportedPixels();
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
  const afterToggle = await exportedPixels();
  if (before.width !== afterToggle.width || before.height !== afterToggle.height || !before.pixels.equals(afterToggle.pixels)) fail('switching paradigm changed the exported photo');
  console.log('ok: switching darkroom paradigm preserves every exported pixel');
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
  if (cpuDisplay) {
    await evaluate(`(() => { const input = document.getElementById('coreUseWebGL'); if (input.checked) input.click(); })()`);
    await waitFor('CPU darkroom display', `window.__ncDisplay.frame().surface === 'cpu'`);
    await wait(1200);
  }
  const webglBeforeTool = await evaluate(`window.__ncBrush.state().webgl`);
  await evaluate(`document.getElementById('studioTab-repair').click(); document.getElementById('studioDodgeBurn').open = true;`);
  await evaluate(`(() => { const el = document.getElementById('dodgeBurnEnabled'); el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor('dodge burn active', `document.body.classList.contains('dodge-burn-active')`, 5_000);
  await evaluate(`(() => { const el = document.getElementById('dodgeBurnShowOverlay'); el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await setInput('dodgeBurnStops', '1.5');
  await setInput('dodgeBurnSize', '30');
  await wait(500);
  const region = { x: 0.3, y: 0.3, w: 0.4, h: 0.4 };
  const untouched = await canvasLuminance(region);
  // The dodge tool keeps the GPU display (#253); the stroke is drawn on the
  // feedback overlay and its exposure change shows under the brush while it is
  // painted (#254). Paint on the canvas on screen.
  const toolState = await evaluate(`window.__ncBrush.state()`);
  if (webglBeforeTool && toolState.webgl !== true) {
    fail('the dodge-and-burn tool turned the GPU display off: ' + JSON.stringify(toolState));
  }
  const rect = await evaluate(`(() => {
    const surface = [...document.querySelectorAll('#canvas, #glCanvas')].find(el => getComputedStyle(el).display !== 'none');
    const r = surface.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`);
  const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: type === 'mousePressed' ? 1 : 0, buttons: type === 'mouseReleased' ? 0 : 1 });
  const y = rect.y + rect.height * 0.5;
  // The frame on screen before the stroke, to compare outside its box mid-drag.
  await evaluate(`(() => { window.__darkroomBeforeStroke = window.__ncDisplay.shownFrame(); })()`);
  await evaluate('window.__ncBrush.resetCounters()');
  await mouse('mousePressed', rect.x + rect.width * 0.35, y);
  for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', rect.x + rect.width * (0.35 + 0.3 * i / 8), y); await wait(30); }
  // Mid-stroke: the live rectangles land (overlay hidden for the measurement).
  await waitFor('live dodge rectangles', `window.__ncBrush.state().live.rects > 0 && window.__ncBrush.state().live.session?.touched`, 10_000);
  await wait(300);
  const during = await evaluate(`window.__ncBrush.state()`);
  // Pixels outside the rectangles the stroke drew are unchanged mid-drag: no
  // redraw of the photo, no WB or curve flash.
  const outside = await evaluate(`(() => {
    const before = window.__darkroomBeforeStroke, now = window.__ncDisplay.shownFrame(), box = window.__ncBrush.state().live.box;
    delete window.__darkroomBeforeStroke;
    if (!before || !now || before.width !== now.width || before.height !== now.height || !box) return { error: 'frames', box, sizes: [before?.width, now?.width] };
    let changed = 0, inside = 0;
    for (let y = 0; y < now.height; y++) for (let x = 0; x < now.width; x++) {
      const i = (y * now.width + x) * 4;
      if (before.data[i] === now.data[i] && before.data[i + 1] === now.data[i + 1] && before.data[i + 2] === now.data[i + 2]) continue;
      if (x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height) inside++; else changed++;
    }
    return { changed, inside, box, surface: now.surface };
  })()`);
  if (outside.error || outside.changed || !outside.inside) fail('the photo changed outside the stroke while painting: ' + JSON.stringify(outside));
  await evaluate(`document.getElementById('brushFeedback').style.visibility = 'hidden'`);
  const live = await canvasLuminance(region);
  await evaluate(`document.getElementById('brushFeedback').style.visibility = ''`);
  console.log('darkroom live burn:', JSON.stringify({ untouched, live, surface: during.surface, live: during.live, writes: during.canvasWrites, outside }));
  if (!(live < untouched - 3)) fail(`the burn did not show under the brush while painting: ${untouched} -> ${live}`);
  if (!during.feedback.drawing || during.feedback.counters.frames < 2) fail('the stroke is not drawn frame by frame on the overlay: ' + JSON.stringify(during.feedback));
  if (during.surface === 'gl' && (during.canvasWrites.put || during.canvasWrites.draw)) {
    fail('#canvas was written during a stroke on the GPU display: ' + JSON.stringify(during.canvasWrites));
  }
  if (cpuDisplay && during.surface !== 'cpu') fail('CPU live-dodge run did not use the CPU display');
  if (during.surface === 'cpu') {
    const display = await evaluate(`window.__ncDisplay.frame().display`);
    const diameter = 0.3 * Math.min(display[0], display[1]);
    if (during.canvasWrites.draw || during.canvasWrites.maxPutPixels > (2 * diameter) ** 2) {
      fail('a CPU-display stroke wrote more than its rectangles: ' + JSON.stringify(during.canvasWrites));
    }
  }
  await mouse('mouseReleased', rect.x + rect.width * 0.65, y);
  await waitFor('stroke recorded', `/1 stroke/.test(document.getElementById('dodgeBurnStatus').textContent)`, 10_000);
  await wait(2500);
  const burned = await canvasLuminance(region);
  console.log('darkroom burn:', JSON.stringify({ untouched, live, burned }));
  if (!(burned < untouched - 3)) fail(`burn stroke did not darken the region: ${untouched} -> ${burned}`);
  // The settled frame replaces the live rectangles without a visible jump.
  if (Math.abs(burned - live) > 1.5) fail(`the settled burn differs from the live one: ${live} -> ${burned}`);
  // #234: per-frame settings rebuilds hit the stroke sanitiser caches after
  // the first frame, and preview requests carry no repair strokes.
  const strokeFrames = await evaluate(`(async () => {
    const { strokeSanitizerStats } = await import('/src/app/localExposure.js');
    const post = Worker.prototype.postMessage, requests = [];
    Worker.prototype.postMessage = function (message, ...args) {
      if (message?.type === 'convert') requests.push({ repairs: Object.hasOwn(message.settings || {}, 'repairStrokes'),
        strokes: message.settings?.localExposure?.strokes?.length || 0, retained: Boolean(message.reuseLocalExposure) });
      return post.call(this, message, ...args);
    };
    const slider = document.getElementById('coreExposure'), start = slider.value;
    let firstFrame = null;
    try {
      for (let i = 0; i < 40; i++) {
        slider.value = String(Number(start) + (i % 10) * 2 + 2);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 40));
        if (i === 0) firstFrame = strokeSanitizerStats.misses;
      }
      await new Promise(resolve => setTimeout(resolve, 600));
      return { misses: strokeSanitizerStats.misses - firstFrame, requests: requests.length,
        repairs: requests.filter(request => request.repairs).length,
        strokes: requests.filter(request => request.strokes > 0 || request.retained).length,
        retained: requests.filter(request => request.retained).length };
    } finally {
      Worker.prototype.postMessage = post;
      slider.value = start;
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    }
  })()`);
  console.log('darkroom stroke frames:', JSON.stringify(strokeFrames));
  if (!(strokeFrames.requests > 0 && strokeFrames.strokes === strokeFrames.requests)) fail('exposure drag did not convert with the stroke: ' + JSON.stringify(strokeFrames));
  if (!strokeFrames.retained) fail('preview requests re-posted unchanged dodge-and-burn strokes: ' + JSON.stringify(strokeFrames));
  if (strokeFrames.repairs) fail('preview requests carried repair strokes: ' + JSON.stringify(strokeFrames));
  if (strokeFrames.misses) fail('stroke sanitiser missed its cache during the drag: ' + JSON.stringify(strokeFrames));
  await wait(2500);
  await evaluate(`document.getElementById('dodgeBurnUndoStrokeBtn').click()`);
  await waitFor('stroke removed', `/No strokes/.test(document.getElementById('dodgeBurnStatus').textContent)`, 10_000);
  await wait(2500);
  const cleared = await canvasLuminance(region);
  if (Math.abs(cleared - untouched) > 1.5) fail(`removing the stroke did not restore the region: ${untouched} -> ${cleared}`);

  // #254 follow-up: what is on screen once a stroke's pen-up frame has landed,
  // and once its exact frame (the full-resolution render's display) has,
  // against its last live frame. Inside the box of the rectangles drawn live:
  // the pixels the stroke changed (the live or the compared frame differs from
  // the frame before the stroke), within 2/255 in 99.9 % (#254's acceptance).
  // Outside it: every pixel, none more than 2/255 off. Frames stay in the
  // page; only the numbers come back.
  await evaluate(`(() => {
    window.__darkroomCompare = (pre, live, other, box) => {
      if (!pre || !live || !other || !box || pre.width !== other.width || live.width !== other.width
        || pre.height !== other.height || live.height !== other.height) return { error: 'frames', box, sizes: [pre?.width, live?.width, other?.width] };
      const inside = { area: 0, within2: 0, max: 0 }, outside = { pixels: 0, changed: 0, over2: 0, max: 0 };
      for (let y = 0; y < other.height; y++) for (let x = 0; x < other.width; x++) {
        const i = (y * other.width + x) * 4;
        let changed = false, d = 0;
        for (let c = 0; c < 3; c++) {
          if (pre.data[i + c] !== live.data[i + c] || pre.data[i + c] !== other.data[i + c]) changed = true;
          d = Math.max(d, Math.abs(live.data[i + c] - other.data[i + c]));
        }
        if (x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height) {
          if (!changed) continue;
          inside.area++;
          if (d <= 2) inside.within2++;
          inside.max = Math.max(inside.max, d);
        } else {
          outside.pixels++;
          if (d) outside.changed++;
          if (d > 2) outside.over2++;
          outside.max = Math.max(outside.max, d);
        }
      }
      inside.within2 = inside.area ? +(100 * inside.within2 / inside.area).toFixed(3) : 0;
      return { inside, outside };
    };
  })()`);
  // Paints a stroke (`paint`, then `release`), then compares its last live
  // frame with the frame on screen after its pen-up frame (`penUp`) and after
  // its exact frame (`exact`; `settle` waits for anything that comes before it).
  const strokeAtPenUp = async (label, { paint, release, settle = null }) => {
    await evaluate(`(() => { window.__darkroomFrames = { pre: window.__ncDisplay.shownFrame() }; })()`);
    await evaluate('window.__ncBrush.resetCounters()');
    await paint();
    await waitFor(`${label} painted live`, `(() => { const s = window.__ncBrush.state().live.session;
      return Boolean(s && s.touched && !s.inFlight && s.sent === s.points && s.applied === s.points); })()`, 30_000);
    await wait(300);
    const painting = await evaluate(`window.__ncBrush.state().live`);
    await evaluate(`(() => { window.__darkroomFrames.live = window.__ncDisplay.shownFrame(); })()`);
    await release();
    await waitFor(`${label} recorded`, `/1 stroke/.test(document.getElementById('dodgeBurnStatus').textContent)`, 10_000);
    const token = await evaluate('window.__ncDisplay.state().token');
    await waitFor(`${label} pen-up frame landed`, `window.__ncDisplay.state().displayed >= ${token}`, 30_000);
    const box = JSON.stringify(painting.box);
    const penUp = await evaluate(`(() => { const f = window.__darkroomFrames; f.penUp = window.__ncDisplay.shownFrame();
      return { ...window.__darkroomCompare(f.pre, f.live, f.penUp, ${box}), display: window.__ncBrush.state().live.display }; })()`);
    await waitFor(`${label} exact frame on screen`, `(() => { const d = window.__ncBrush.state().live.display; return !d.composite && d.exact; })()`, 30_000);
    if (settle) await settle();
    await wait(300);
    const exact = await evaluate(`(() => { const f = window.__darkroomFrames; delete window.__darkroomFrames;
      return window.__darkroomCompare(f.pre, f.live, window.__ncDisplay.shownFrame(), ${box}); })()`);
    const live = painting.session || {};
    const result = { label, mode: live.mode ?? null, points: live.points, rects: painting.rects, exactRects: painting.exactRects,
      deltaRects: painting.deltaRects, adopted: (await evaluate('window.__ncBrush.state().live')).adopted, box: painting.box, penUp, exact,
      strokePoints: await evaluate('window.__ncBrush.state().strokePoints') };
    console.log(`darkroom pen-up (${label}):`, JSON.stringify(result));
    if (penUp.error || exact.error || !(penUp.inside.area > 1000)) fail(`${label}: the stroke did not paint: ` + JSON.stringify(result));
    // At pen-up nothing on screen moves: what the rectangles left there stays.
    if (penUp.outside.over2 || penUp.outside.max > 2) fail(`${label}: pixels outside the stroke changed at pen-up: ` + JSON.stringify(result));
    if (!(penUp.inside.within2 >= 99.9)) fail(`${label}: the stroke jumped at pen-up: ` + JSON.stringify(result));
    // Outside the stroke the exact frame is the frame on screen before it.
    if (exact.outside.over2 || exact.outside.max > 2) fail(`${label}: pixels outside the stroke changed when its exact frame landed: ` + JSON.stringify(result));
    return result;
  };
  const removeStroke = async (label) => {
    await evaluate(`document.getElementById('dodgeBurnUndoStrokeBtn').click()`);
    await waitFor(`${label} removed`, `/No strokes/.test(document.getElementById('dodgeBurnStatus').textContent)`, 10_000);
    // The full-resolution display of the photo without it, as before the stroke.
    await waitFor(`${label}: exact frame without it`, `(() => { const d = window.__ncBrush.state().live.display; return !d.composite && d.exact; })()`,
      30_000, { soft: true });
    await wait(1000);
  };

  // #280: a long pen stroke of 522 samples, all but the last 1.2 px apart,
  // with pen pressure that changes fast. Its first 400 samples are kept as
  // recorded, then one per eighth of the brush radius, and the live effect
  // paints exactly the points stored: more than 400 (resampled to 400, as
  // before #280, its feather edge jumped at pen-up). The last sample lies a
  // jump away, so the recorder keeps it while painting and the frame read
  // before pen-up is the last live frame. The frame on screen is the
  // full-resolution render's display (the photo is idle): the stroke gets that
  // display's own pixels (exact rectangles, #254 follow-up), so its pen-up and
  // its exact frame both meet the acceptance bound inside and outside its box.
  // Then the same stroke by delta (the path of repaired frames): nothing moves
  // at its pen-up or outside its box, and the exact frame refines the inside.
  const pen = (type, x, y, force) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', pointerType: 'pen', force,
    clickCount: type === 'mousePressed' ? 1 : 0, buttons: type === 'mouseReleased' ? 0 : 1 });
  const cx = rect.x + rect.width * 0.5, cy = rect.y + rect.height * 0.5;
  const radius = Math.min(rect.width, rect.height) * 0.25;
  const at = (i) => [cx + radius * Math.cos(i * 1.2 / radius), cy + radius * Math.sin(i * 1.2 / radius)];
  const [lx, ly] = at(520);
  // Outwards by a fifth of the photo's short side, far more than an eighth of the brush radius.
  const end = [cx + (lx - cx) * 1.8, cy + (ly - cy) * 1.8];
  const longPenStroke = {
    paint: async () => {
      await pen('mousePressed', ...at(0), 0.5);
      for (let i = 1; i <= 520; i++) await pen('mouseMoved', ...at(i), 0.3 + 0.7 * Math.abs(Math.sin(i / 20)));
      await pen('mouseMoved', ...end, 0.6);
    },
    release: () => pen('mouseReleased', ...end, 0)
  };
  const exactStroke = await strokeAtPenUp('long pen stroke', longPenStroke);
  if (!(exactStroke.strokePoints?.length === 1 && exactStroke.strokePoints[0] > 400 && exactStroke.strokePoints[0] === exactStroke.points)) {
    fail('the long pen stroke was not stored as painted (the points painted live, more than 400): ' + JSON.stringify(exactStroke));
  }
  if (exactStroke.mode !== 'display' || !exactStroke.exactRects || exactStroke.deltaRects) {
    fail('the long pen stroke over the full-resolution display was not painted with exact rectangles: ' + JSON.stringify(exactStroke));
  }
  if (!(exactStroke.exact.inside.within2 >= 99.9)) fail('the long pen stroke jumped when its exact frame landed: ' + JSON.stringify(exactStroke));
  await removeStroke('long pen stroke');
  await evaluate('window.__ncBrush.setExactDisplays(false)');
  const deltaStroke = await strokeAtPenUp('long pen stroke by delta', longPenStroke);
  await evaluate('window.__ncBrush.setExactDisplays(true)');
  if (deltaStroke.mode !== 'delta' || !deltaStroke.deltaRects || !deltaStroke.adopted) fail('the delta pass did not paint by delta: ' + JSON.stringify(deltaStroke));
  await removeStroke('long pen stroke by delta');

  // #254's third brush session: dodge with dust removal on. The frame on
  // screen is the repaired full-resolution frame's display. This fixture has
  // no dust, so nothing was repaired and its display is the exact one: the
  // stroke gets exact rectangles, the dust pass after it finds nothing, and
  // the frame stays put inside and outside the stroke. (Where dust is found,
  // the pass after the stroke may change repairs outside it: its threshold is a
  // quantile of the whole frame; docs/darkroom.md, Limits.)
  await evaluate(`(() => {
    window.__darkroomDustUpdates = 0;
    window.__darkroomDustObserver = new MutationObserver(() => window.__darkroomDustUpdates++);
    window.__darkroomDustObserver.observe(document.getElementById('dustStatus'), { childList: true });
    document.getElementById('dustRemovalEnabled').click();
  })()`);
  await waitFor('dust removal settled under the dodge tool', `window.__darkroomDustUpdates > 0
    && /^(Detected [0-9]+ dust particles|No dust detected)/.test(document.getElementById('dustStatus').textContent)`, 90_000);
  await wait(2500);
  const repairedRect = await evaluate(`(() => {
    const surface = [...document.querySelectorAll('#canvas, #glCanvas')].find(el => getComputedStyle(el).display !== 'none');
    const r = surface.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`);
  const ry = repairedRect.y + repairedRect.height * 0.5;
  const dustBefore = await evaluate(`document.getElementById('dustStatus').textContent`);
  let repairedLive = null;
  const repaired = await strokeAtPenUp('repaired-frame stroke', {
    paint: async () => {
      await mouse('mousePressed', repairedRect.x + repairedRect.width * 0.35, ry);
      for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', repairedRect.x + repairedRect.width * (0.35 + 0.3 * i / 8), ry); await wait(30); }
      await waitFor('live dodge rectangles over the repaired frame', `window.__ncBrush.state().live.rects > 0 && window.__ncBrush.state().live.session?.touched`, 30_000);
      repairedLive = await evaluate(`window.__ncBrush.state()`);
    },
    release: () => mouse('mouseReleased', repairedRect.x + repairedRect.width * 0.65, ry),
    // The repair pass after the stroke's exact frame: detection on it.
    settle: async () => {
      const updates = await evaluate('window.__darkroomDustUpdates');
      await waitFor('dust pass after the stroke', `window.__darkroomDustUpdates > ${updates}
        && /^(Detected [0-9]+ dust particles|No dust detected)/.test(document.getElementById('dustStatus').textContent)`, 30_000, { soft: true });
    }
  });
  const dustAfter = await evaluate(`document.getElementById('dustStatus').textContent`);
  console.log('darkroom repaired live burn:', JSON.stringify({ surface: repairedLive.surface, live: repairedLive.live, writes: repairedLive.canvasWrites, dustBefore, dustAfter }));
  if (repairedLive.surface === 'gl' && (repairedLive.canvasWrites.put || repairedLive.canvasWrites.draw)) {
    fail('#canvas was written during a repaired-frame stroke on the GPU display: ' + JSON.stringify(repairedLive.canvasWrites));
  }
  if (/^No dust detected/.test(dustBefore) && /^No dust detected/.test(dustAfter) && !(repaired.exact.inside.within2 >= 99.9)) {
    fail('the repaired-frame stroke jumped when its exact frame landed, with nothing repaired: ' + JSON.stringify(repaired));
  }
  await removeStroke('repaired-frame stroke');
  await evaluate(`window.__darkroomDustObserver.disconnect(); document.getElementById('dustRemovalEnabled').click()`);
  await wait(3000);

  await evaluate(`(() => { const el = document.getElementById('dodgeBurnEnabled'); el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor('dodge burn inactive', `!document.body.classList.contains('dodge-burn-active')`, 5_000);

  console.log('ok: test strip renders and applies with undo, enlarger filtration maps to the core sliders both ways, paper emulation changes and restores the print, a burn stroke shows under the brush (also over a repaired frame), darkens its region and can be removed');
}
