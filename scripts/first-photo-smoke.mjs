// #236 in a real browser: the first photo converts before its frame
// detection ends, no full-window "Detecting…" overlay covers an import or a
// photo switch, the filmstrip stays navigable during the detection tail, and a
// default import creates neither the MI-GAN repair worker nor (for a roll of
// three or more) a semantic worker. Opening the Repair tab loads MI-GAN.
// The colour photo of scenario 1 runs the semantic pass, which reads the same
// model store: the store check looks for MI-GAN's model in particular (R1-039).
// During the detection tail the toolbar, the brushes on the photo and the
// history keys edit nothing, Export stays disabled, and the photo settles on
// the recipe it gets without them (R1-034).
import { join } from 'node:path';

const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;

// Installed before the app's own scripts on every navigation of this scenario.
const PROBE = `(() => {
  if (window.__firstPhotoProbe) return;
  const probe = window.__firstPhotoProbe = { workers: [], databases: [], modelReads: [], overlay: [], detecting: [], maxOpacity: 0,
    hold: false, held: [] };
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url, options) { probe.workers.push(String(url)); super(url, options); }
  };
  // The import's frame and film-edge request waits here while probe.hold is
  // set, which keeps the photo in its detection tail until release().
  const post = NativeWorker.prototype.postMessage;
  window.Worker.prototype.postMessage = function (message, transfer) {
    if (probe.hold && message && message.type === 'analyze-import') { probe.held.push(() => post.call(this, message, transfer)); return; }
    return post.apply(this, arguments);
  };
  probe.release = () => { probe.hold = false; for (const deliver of probe.held.splice(0)) deliver(); };
  const open = indexedDB.open.bind(indexedDB);
  indexedDB.open = (name, ...rest) => { probe.databases.push(String(name)); return open(name, ...rest); };
  // Which model a read is for: IndexedDB keys and fetched URLs (modelCache.js).
  const get = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function (key) { probe.modelReads.push({ via: 'idb', key: String(key) }); return get.call(this, key); };
  const fetchPage = window.fetch;
  window.fetch = function (input, init) {
    const url = String(typeof input === 'string' ? input : input?.url || '');
    if (/\.onnx\b/.test(url)) probe.modelReads.push({ via: 'fetch', key: url });
    return fetchPage.apply(this, arguments);
  };
  new MutationObserver(records => {
    for (const record of records) {
      const target = record.target;
      if (record.attributeName === 'class' && target.classList?.contains('loading-overlay')) {
        const visible = target.classList.contains('visible');
        if (probe.overlay.at(-1)?.visible !== visible) {
          probe.overlay.push({ visible, title: target.querySelector('.loading-phase-text')?.textContent || '' });
        }
      }
      if (target === document.body && record.attributeName === 'data-studio-detecting' && document.body.dataset.studioDetecting) {
        // Optionally navigate from inside the tail, the way a user clicks the strip.
        if (probe.clickOnTail != null) {
          const index = probe.clickOnTail;
          probe.clickOnTail = null;
          setTimeout(() => {
            probe.overlay = [];
            probe.clickedDuring = Boolean(document.body.dataset.studioDetecting);
            document.querySelector('.file-list-name[data-index="' + index + '"]')?.click();
          }, 0);
        }
        probe.detecting.push({
          value: document.body.dataset.studioDetecting,
          file: document.getElementById('studioFilename')?.textContent || '',
          feedbackHidden: document.getElementById('studioPhotoSwitchFeedback')?.hidden,
          stripInert: document.getElementById('studioFilmstrip')?.inert,
          panelInert: document.getElementById('controlsPanel')?.inert,
          positive: document.body.classList.contains('studio-ready'),
          overlayVisible: Boolean(document.querySelector('.loading-overlay.visible'))
        });
      }
    }
  }).observe(document, { attributes: true, subtree: true, attributeFilter: ['class', 'data-studio-detecting'] });
  const sample = () => {
    const overlay = document.querySelector('.loading-overlay');
    if (overlay) probe.maxOpacity = Math.max(probe.maxOpacity, Number(getComputedStyle(overlay).opacity));
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
})()`;

const MIGAN = /migan_pipeline_v2/;
const SEMANTIC = /efficientvit-b1-ade20k/;

export async function runFirstPhotoSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const fixtures = join(root, 'negative2positive', 'test-fixtures');
  const files = ['negative-sample.jpg', 'negative-sample-2.jpg', 'negative-plain.png'].map(name => join(fixtures, name));
  // Typed colour on import (orange mask), unlike negative-sample.jpg (positive).
  const colourPhoto = join(fixtures, 'negative-textured.png');
  const script = await send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
  let autoRollBefore;
  let learnedSeeded = false;
  try {
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
    await waitFor('first photo boot', `!!window.__firstPhotoProbe && !!document.getElementById('studioImportAutoCrop') && /No model loaded/.test(document.getElementById('dustAiStatus')?.textContent)`);
    await installDialogAutoAccept();
    await wait(300);
    const probeReset = `(() => { const p = window.__firstPhotoProbe; p.workers = []; p.databases = []; p.modelReads = []; p.overlay = []; p.detecting = []; p.maxOpacity = 0; })()`;
    const importFiles = async (paths) => {
      const doc = await send('DOM.getDocument');
      const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
      await send('DOM.setFileInputFiles', { files: paths, nodeId: input.result.nodeId });
    };
    const read = () => evaluate(`JSON.parse(JSON.stringify(window.__firstPhotoProbe))`);
    const checkTail = (probe, label) => {
      if (probe.overlay.some(entry => /Detecting the image area/.test(entry.title))) fail(`${label}: a full-window detection overlay appeared: ${JSON.stringify(probe.overlay)}`);
      for (const entry of probe.detecting) {
        if (!entry.positive || !entry.feedbackHidden || entry.stripInert || !entry.panelInert || entry.overlayVisible) {
          fail(`${label}: the detection tail must show the positive, keep the strip navigable and the panel locked: ${JSON.stringify(entry)}`);
        }
      }
    };

    // 1. One colour photo: convert first, detect in the background, no MI-GAN.
    // Its semantic colour pass reads the shared model store (#262), so the
    // store is checked for MI-GAN's model key, not for the database.
    await evaluate(probeReset);
    await importFiles([colourPhoto]);
    await waitFor('first photo settled', `${ready} && !!document.getElementById('studioFilename').textContent`, 150_000);
    const filmType = await evaluate(`window.__ncTwoStage.status().settings?.filmType`);
    if (filmType !== 'color') fail('the colour photo was not typed colour: ' + filmType);
    await waitFor('the colour photo\'s semantic pass', `window.__firstPhotoProbe.workers.some(url => /semanticWorker/.test(url)) && !window.__ncTwoStage.status().semanticPending`, 60_000);
    await wait(1000);
    let probe = await read();
    const reads = probe.modelReads.map(entry => `${entry.via}:${entry.key.split('/').pop()}`);
    console.log('first photo evidence:', JSON.stringify({ detecting: probe.detecting, overlay: probe.overlay, maxOpacity: probe.maxOpacity, workers: probe.workers.map(url => url.split('/').pop().split('?')[0]), reads }));
    if (!probe.detecting.length) fail('the first photo was not revealed before its detections ended');
    checkTail(probe, 'first photo');
    const shown = probe.overlay.filter(entry => entry.visible).length;
    if (shown > 1) fail('a first import shows the overlay at most once: ' + JSON.stringify(probe.overlay));
    if (probe.workers.some(url => /aiInpaintWorker/.test(url))) fail('a default import must not start the MI-GAN worker');
    if (probe.modelReads.some(entry => MIGAN.test(entry.key))) fail('a default import must not read the MI-GAN model: ' + JSON.stringify(reads));
    // The colour path ran: the semantic model came from the same store.
    if (!probe.modelReads.some(entry => SEMANTIC.test(entry.key))) fail('the colour import did not read the semantic model, so the store check saw no colour import: ' + JSON.stringify(reads));
    const idle = await evaluate(`document.getElementById('dustAiStatus').textContent`);
    if (!/No model loaded/.test(idle)) fail('MI-GAN loaded without intent: ' + idle);
    if (await evaluate(`[...document.querySelectorAll('.toast-message')].some(t => /AI repair model loaded/.test(t.textContent))`)) fail('an implicit model load must not toast');
    // Opening the Repair tab is the intent that loads it.
    await evaluate(`document.getElementById('studioTab-repair').click()`);
    await waitFor('Repair tab starts the MI-GAN load', `/Loading model|Model ready/.test(document.getElementById('dustAiStatus').textContent)`, 30_000);
    await waitFor('MI-GAN ready after the Repair tab', `/Model ready/.test(document.getElementById('dustAiStatus').textContent)`, 180_000);
    probe = await read();
    if (!probe.workers.some(url => /aiInpaintWorker/.test(url))) fail('the Repair tab did not start the MI-GAN worker');
    // The probe sees a MI-GAN read when there is one, so the check above holds.
    if (!probe.modelReads.some(entry => MIGAN.test(entry.key))) fail('the probe missed the MI-GAN model read of the Repair tab: ' + JSON.stringify(probe.modelReads));
    if (await evaluate(`[...document.querySelectorAll('.toast-message')].some(t => /AI repair model loaded/.test(t.textContent))`)) fail('an implicit model load must not toast');
    console.log('ok: a colour photo converts before detection ends, no detection overlay, its semantic pass reads the model store but not MI-GAN, which loads on the Repair tab only');

    // 2. The strip is clicked as soon as the first photo's provisional
    // positive shows (normally inside its detection tail). The unanalysed
    // second photo is a cold switch: its switch surface lifts at its own
    // provisional paint, and no full-window overlay appears.
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
    await waitFor('first photo reboot', `!!window.__firstPhotoProbe && !!document.getElementById('studioImportAutoCrop')`);
    await installDialogAutoAccept();
    await wait(300);
    await evaluate(`${probeReset}; window.__firstPhotoProbe.clickOnTail = 1`);
    await importFiles(files.slice(0, 2));
    await waitFor('cold switch from the detection tail settled', `(() => {
      const tails = window.__firstPhotoProbe.detecting;
      return ${ready} && tails.length >= 2 && tails.at(-1).file !== tails[0].file
        && document.getElementById('studioFilename').textContent === tails.at(-1).file;
    })()`, 150_000);
    probe = await read();
    console.log('cold switch evidence:', JSON.stringify({ clickedDuringTail: probe.clickedDuring, detecting: probe.detecting, overlay: probe.overlay }));
    checkTail(probe, 'cold switch');
    if (probe.overlay.some(entry => entry.visible)) fail('a cold switch must not raise the full-window overlay: ' + JSON.stringify(probe.overlay));
    console.log('ok: cold switch reveals the provisional positive with a navigable filmstrip');

    // 3. Three photos with automatic roll analysis: the first photo skips the
    // semantic inference whose result the roll would discard.
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
    await waitFor('roll boot', `!!window.__firstPhotoProbe && !!document.getElementById('studioImportAutoCrop')`);
    await installDialogAutoAccept();
    await wait(300);
    // Earlier scenarios switch the saved roll-import setting off; this step
    // needs the scheduled roll analysis, so switch it on and restore it after.
    autoRollBefore = await evaluate(`(() => {
      const key = 'nc_auto_roll_import_v1', before = localStorage.getItem(key);
      localStorage.setItem(key, 'on');
      document.getElementById('autoRollOnImport').checked = true;
      return before;
    })()`);
    await evaluate(probeReset);
    await importFiles(files);
    await waitFor('roll first photo settled', `${ready} && !!document.getElementById('studioFilename').textContent`, 150_000);
    await wait(2000);
    probe = await read();
    const semantic = probe.workers.filter(url => /semanticWorker/.test(url)).length;
    console.log('roll import evidence:', JSON.stringify({ semantic, workers: probe.workers.map(url => url.split('/').pop().split('?')[0]) }));
    if (semantic) fail('a roll import must not run the semantic model for its first photo');
    if (probe.workers.some(url => /aiInpaintWorker/.test(url))) fail('a roll import must not start the MI-GAN worker');
    console.log('ok: a three-photo import creates no semantic or MI-GAN worker');

    // 4. Editing stays locked during the detection tail (R1-034). The import's
    // frame and film-edge request is held, so the provisional photo stays in
    // its tail while real input arrives (CDP mouse and keys: hit-testing and
    // inert apply): an AI-brush stroke on the photo, +90°, Crop and Ctrl+Z.
    // None of them edits, Export stays disabled, and the photo settles on the
    // recipe the same import gets without them: its learned value applied and
    // the automatic values it was added to recorded. After the tail the same
    // input edits, so it does reach the controls.
    const point = id => evaluate(`(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    const click = async ({ x, y }) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    };
    const brush = async ({ x, y }) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 4; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + 8 * i, y: y + 4 * i, button: 'left', buttons: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x + 32, y: y + 16, button: 'left', clickCount: 1 });
    };
    const undoKey = async () => {
      for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'z', code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers: 2 });
    };
    const cropMode = `document.getElementById('canvasContainer').classList.contains('crop-mode')`;
    const record = `({ settings: window.__ncTwoStage.status().settings, import: window.__ncAnalysis.importRecord(), cropping: ${cropMode},
      exportDisabled: document.getElementById('exportBtn').disabled })`;
    const settled = `${ready} && !document.body.dataset.studioDetecting && !window.__ncAnalysis.converting() && !window.__ncTwoStage.status().semanticPending`;
    const boot = async label => {
      await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
      await waitFor(label + ': boot', `!!window.__firstPhotoProbe && !!document.getElementById('studioImportAutoCrop') && !!document.getElementById('resetLearnedDefaults')`);
      await installDialogAutoAccept();
      await wait(300);
    };
    const resetLearned = async () => {
      await evaluate(`document.getElementById('resetLearnedDefaults').click()`);
      await waitFor('learned defaults reset', `/: 0 /.test(document.getElementById('learnedDefaultsCount').textContent)`, 30_000);
    };
    // A learned value for this stock through the app's own flow: one roll's
    // exported cyan edit of +12 is +3 on the next import (n / (n + 3)).
    await boot('learned value');
    learnedSeeded = true;
    await resetLearned();
    await evaluate(`(() => {
      window.showSaveFilePicker = undefined;
      HTMLAnchorElement.prototype.click = function () { if (!this.download) return; };
    })()`);
    await importFiles([colourPhoto]);
    await waitFor('learned value: photo settled', settled, 150_000);
    await evaluate(`(() => { const el = document.getElementById('cyan'); el.value = '12'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await evaluate(`document.querySelector('.format-btn[data-format="png"]').click(); document.querySelector('.bitdepth-btn[data-bitdepth="8"]').click(); document.getElementById('exportSingleBtn').click()`);
    await waitFor('learned value recorded', `/: [1-9]/.test(document.getElementById('learnedDefaultsCount').textContent)`, 120_000);

    const tailRun = async (interact) => {
      const label = interact ? 'tail with input' : 'tail without input';
      await boot(label);
      // The brush that paints on the photo: Retouch tab, AI brush on, model ready.
      await evaluate(`document.getElementById('studioTab-repair').click()`);
      await waitFor(label + ': MI-GAN ready', `/Model ready/.test(document.getElementById('dustAiStatus').textContent)`, 180_000);
      await evaluate(`(() => { const box = document.getElementById('aiBrushEnabled'); if (!box.checked) box.click(); })()`);
      await evaluate(`${probeReset}; window.__firstPhotoProbe.hold = true`);
      await importFiles([colourPhoto]);
      await waitFor(label + ': provisional photo in its tail', `document.body.classList.contains('studio-ready') && !!document.body.dataset.studioDetecting && window.__firstPhotoProbe.held.length > 0`, 150_000);
      await wait(300);
      const before = await evaluate(record);
      const armed = await evaluate(`({ retouch: document.getElementById('studioTab-repair').getAttribute('aria-selected'), brush: document.getElementById('aiBrushEnabled').checked,
        model: document.getElementById('dustAiStatus').textContent })`);
      if (interact) {
        await brush(await point('canvasContainer'));
        await click(await point('rotateRightBtn'));
        await click(await point('cropBtn'));
        await undoKey();
      }
      await wait(800);
      const during = await evaluate(`({ ...${record}, held: window.__firstPhotoProbe.held.length, detecting: document.body.dataset.studioDetecting || null,
        toolbarInert: document.getElementById('previewToolbar').inert, surfaceInert: document.getElementById('canvasTransformWrapper').inert,
        toasts: [...document.querySelectorAll('.toast-message')].map(t => t.textContent) })`);
      await evaluate(`window.__firstPhotoProbe.release()`);
      await waitFor(label + ': tail ended', settled, 120_000);
      await wait(1500);
      await waitFor(label + ': settled', settled, 60_000);
      const after = await evaluate(record);
      return { label, armed, before, during, after };
    };
    const quiet = await tailRun(false);
    const busy = await tailRun(true);
    console.log('tail lock evidence:', JSON.stringify({ armed: busy.armed, during: { ...busy.during, settings: undefined },
      before: busy.before.settings && { rotationAngle: busy.before.settings.rotationAngle, cyan: busy.before.settings.cyan },
      after: { cyan: busy.after.settings?.cyan, learned: busy.after.settings?.learnedDefaults, import: { ...busy.after.import, automaticDefaults: Boolean(busy.after.import?.automaticDefaults) } } }));
    if (busy.armed.retouch !== 'true' || !busy.armed.brush || !/Model ready/.test(busy.armed.model)) fail('the AI brush was not armed for the tail: ' + JSON.stringify(busy.armed));
    const lockedDuring = busy.during;
    if (!lockedDuring.detecting || lockedDuring.held < 1) fail('the input did not land inside the detection tail: ' + JSON.stringify({ detecting: lockedDuring.detecting, held: lockedDuring.held }));
    // Every problem at once, what the user sees first.
    const problems = [];
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (lockedDuring.import.repairStrokes || lockedDuring.import.history || lockedDuring.import.userEdited) problems.push('an edit was made during the tail: ' + JSON.stringify(lockedDuring.import));
    if (lockedDuring.settings.rotationAngle !== busy.before.settings.rotationAngle) problems.push('+90° rotated the photo during the tail: ' + JSON.stringify([busy.before.settings.rotationAngle, lockedDuring.settings.rotationAngle]));
    if (lockedDuring.cropping) problems.push('Crop opened crop mode during the tail');
    if (lockedDuring.toasts.some(text => /undo|Undone/i.test(text))) problems.push('Ctrl+Z reached the history during the tail: ' + JSON.stringify(lockedDuring.toasts));
    if (!lockedDuring.exportDisabled || !quiet.during.exportDisabled) problems.push('Export must stay disabled during the tail');
    for (const run of [quiet, busy]) {
      if (run.after.exportDisabled) problems.push(`${run.label}: Export is still disabled after the tail`);
      if (!run.after.import?.automaticDefaults) problems.push(`${run.label}: the final settings did not record their automatic values`);
      if (!run.after.settings?.learnedDefaults || !(run.after.settings.cyan > 0)) problems.push(`${run.label}: the learned value was not applied: ` + JSON.stringify({ learned: run.after.settings?.learnedDefaults, cyan: run.after.settings?.cyan }));
    }
    if (!same(busy.after.settings, quiet.after.settings)) {
      const keys = Object.keys({ ...busy.after.settings, ...quiet.after.settings }).filter(key => !same(busy.after.settings?.[key], quiet.after.settings?.[key]));
      problems.push('input during the tail changed the settled recipe: ' + JSON.stringify(Object.fromEntries(keys.map(key => [key, [quiet.after.settings?.[key], busy.after.settings?.[key]]]))));
    }
    if (!same(busy.after.import, quiet.after.import)) problems.push('input during the tail changed the import record: ' + JSON.stringify({ quiet: quiet.after.import, busy: busy.after.import }));
    if (!lockedDuring.toolbarInert || !lockedDuring.surfaceInert) problems.push('the toolbar and the photo surface must be inert during the tail: ' + JSON.stringify({ toolbar: lockedDuring.toolbarInert, surface: lockedDuring.surfaceInert }));
    if (problems.length) fail(problems.join('\n'));
    // The same input once the tail has ended: it reaches the controls.
    await brush(await point('canvasContainer'));
    await waitFor('the brush paints after the tail', `window.__ncAnalysis.importRecord().repairStrokes === 1`, 30_000);
    await waitFor('ready after the stroke', settled, 120_000);
    const rotationBefore = await evaluate(`window.__ncTwoStage.status().settings.rotationAngle`);
    await click(await point('rotateRightBtn'));
    await waitFor('+90° rotates after the tail', `window.__ncTwoStage.status().settings.rotationAngle !== ${JSON.stringify(rotationBefore)}`, 30_000);
    await waitFor('ready after the rotation', settled, 120_000);
    await click(await point('cropBtn'));
    await waitFor('Crop opens crop mode after the tail', cropMode, 30_000);
    await evaluate(`document.getElementById('cancelCropBtn').click()`);
    await waitFor('crop mode closed', `!${cropMode}`, 30_000);
    console.log('ok: during the detection tail an AI-brush stroke, +90°, Crop and Ctrl+Z edit nothing and Export stays disabled; the photo settles on the recipe it gets without them (learned value applied, automatic values recorded); after the tail the same input edits');
  } finally {
    if (learnedSeeded) {
      // Later steps import colour photos too: leave no learned value behind.
      await evaluate(`document.getElementById('resetLearnedDefaults')?.click()`).catch(() => {});
      await waitFor('learned defaults reset after the tail check', `/: 0 /.test(document.getElementById('learnedDefaultsCount')?.textContent || '')`, 30_000, { soft: true });
    }
    if (autoRollBefore !== undefined) {
      await evaluate(`(() => {
        const key = 'nc_auto_roll_import_v1', before = ${JSON.stringify(autoRollBefore ?? null)};
        if (before === null) localStorage.removeItem(key); else localStorage.setItem(key, before);
      })()`).catch(() => {});
    }
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script.result.identifier });
  }
}
