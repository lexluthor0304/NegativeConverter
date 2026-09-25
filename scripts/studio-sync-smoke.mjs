// Studio chrome sync, layout observers, curve canvas and loading overlay
// (#261), on the real app with ?debugCounters=1:
// - every synchronous burst of sync() calls is one flush (slider release,
//   curve release, undo, warm photo switch), and an unchanged flush writes no DOM;
// - the export buttons' labels have one writer and no data-i18n, and read the
//   same in zh, en and ja for PNG, JPEG, TIFF and DNG;
// - drawers, tabs and jump buttons that keep the viewer's size neither refit
//   nor redraw it; panel, strip and light-table toggles refit without a GL draw;
// - the curve draws when first revealed, and a hover or drag never reallocates it;
// - the visible overlay animates in 8 steps, its hide fade keeps its duration
//   and steps, then it leaves rendering with every animation stopped.
import { expectLoadingOverlayIdle } from './loading-overlay-idle.mjs';

const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy`;

export async function runStudioSyncSmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port }) {
  const expect = (condition, message) => { if (!condition) fail(message); };
  const origin = await evaluate('performance.timeOrigin');
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&debugCounters=1` });
  await waitFor('studio sync workspace', `performance.timeOrigin !== ${origin} && document.readyState === 'complete' && !!window.__ncDebug && !!document.getElementById('studioImportAutoCrop')`);
  await installDialogAutoAccept();

  // ---- Loading overlay: animated while visible, idle once hidden ----
  const motion = await evaluate(`(async () => {
    const { getLoadingOverlay } = await import('/src/ui/LoadingOverlay.js');
    const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));
    const overlay = getLoadingOverlay();
    await overlay.show({ title: 'Sync smoke' });
    overlay.updateIndeterminate('Sync smoke');
    await frame(); await frame();
    const node = document.querySelector('.loading-overlay');
    const reel = node.querySelector('.loading-reel'), fill = node.querySelector('.loading-film-fill');
    // The infinite CSS animations (not the fill's width transition).
    const states = element => element.getAnimations().filter(animation => 'animationName' in animation).map(animation => animation.playState);
    const visible = { reel: states(reel), strip: states(fill), visibility: getComputedStyle(node).visibility,
      reelTiming: getComputedStyle(reel).animationTimingFunction, status: document.querySelector('.loading-status')?.textContent };
    overlay.hide();
    const style = getComputedStyle(node);
    const hiding = { visibility: style.visibility, easing: style.transitionTimingFunction,
      transitions: node.getAnimations().map(animation => ({ property: animation.transitionProperty,
        duration: animation.effect.getTiming().duration, delay: animation.effect.getTiming().delay })),
      reel: states(reel), strip: states(fill), status: document.querySelector('.loading-status')?.textContent };
    const opacity = hiding.transitions.find(transition => transition.property === 'opacity');
    await new Promise(resolve => setTimeout(resolve, (opacity?.duration || 300) + 300));
    return { visible, hiding };
  })()`);
  const fade = motion.hiding.transitions.find(transition => transition.property === 'opacity');
  const leave = motion.hiding.transitions.find(transition => transition.property === 'visibility');
  expect(motion.visible.visibility === 'visible' && motion.visible.reel.includes('running') && motion.visible.strip.includes('running')
    && motion.visible.reelTiming.startsWith('steps(8') && motion.visible.status === 'Sync smoke',
  'the visible overlay does not animate its reel and strip in 8 steps or announce its phase: ' + JSON.stringify(motion));
  expect(fade && fade.duration > 0 && fade.delay === 0 && leave && leave.duration === 0 && leave.delay === fade.duration
    && motion.hiding.visibility === 'visible' && motion.hiding.easing.startsWith('steps(3'),
  'the hide fade changed, or visibility turns hidden before it ends: ' + JSON.stringify(motion.hiding));
  expect(motion.hiding.reel.every(state => state === 'paused') && motion.hiding.strip.every(state => state === 'paused') && motion.hiding.status === '',
  'hiding the overlay did not pause its animations or clear its status: ' + JSON.stringify(motion.hiding));
  await expectLoadingOverlayIdle({ evaluate, waitFor, fail }, 'shown and hidden once');
  console.log('ok: loading overlay steps while visible, fades ' + fade.duration + ' ms in 3 steps, then leaves rendering with no animation running');

  // ---- Two negatives ----
  await evaluate(`(async () => {
    for (const id of ['studioImportAutoCrop', 'importFilmTypeAuto', 'autoRollOnImport']) {
      const input = document.getElementById(id); if (input?.checked) input.click();
    }
    document.querySelector('.film-type-btn[data-type="color"]').click();
    const transfer = new DataTransfer();
    for (const [index, name] of ['negative-plain.png', 'negative-textured.png'].entries()) {
      const blob = await (await fetch('/test-fixtures/' + name)).blob();
      transfer.items.add(new File([blob], 'sync-' + name, { type: 'image/png', lastModified: 1_700_000_000_000 - index * 1000 }));
    }
    const input = document.getElementById('fileInput'); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor('sync fixtures imported', `${ready} && document.getElementById('studioFilename').textContent === 'sync-negative-plain.png'`, 150_000);
  await expectLoadingOverlayIdle({ evaluate, waitFor, fail }, 'import');
  const settle = async label => {
    await waitFor(label, ready, 120_000);
    await wait(3500);
  };
  await settle('first photo idle');

  // One synchronous burst. The flush it queued runs before this continuation,
  // which is queued at the end of the burst; flushes after it come from sync()
  // calls behind an await (reported as "later", not counted).
  const burst = action => evaluate(`(async () => {
    const before = window.__ncDebug.counters().sync;
    ${action}
    await Promise.resolve();
    const after = window.__ncDebug.counters().sync;
    const filename = document.getElementById('studioFilename').textContent;
    for (let i = 0; i < 10; i++) await Promise.resolve();
    return { syncs: after.syncs - before.syncs, flushes: after.flushes - before.flushes, rowWalks: after.rowWalks - before.rowWalks,
      later: window.__ncDebug.counters().sync.flushes - after.flushes, filename, switching: document.body.dataset.photoSwitching || null };
  })()`);

  // ---- An unchanged flush writes nothing ----
  const idleFlush = await evaluate(`(async () => {
    const hop = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
    window.__ncDebug.sync(); await hop();
    const first = window.__ncDebug.counters().sync;
    window.__ncDebug.sync(); await hop();
    const second = window.__ncDebug.counters().sync;
    return { firstWrites: first.lastFlushWrites, secondWrites: second.lastFlushWrites, flushes: second.flushes - first.flushes };
  })()`);
  expect(idleFlush.flushes === 1 && idleFlush.secondWrites === 0, 'a flush with nothing changed wrote to the DOM: ' + JSON.stringify(idleFlush));

  // ---- Export labels: one writer, no data-i18n, same text as before ----
  const labels = [];
  for (const lang of ['zh', 'ja', 'en']) {
    await evaluate(`document.querySelector('.lang-btn[data-lang="${lang}"]').click()`);
    for (const format of ['png', 'jpeg', 'tiff', 'dng']) {
      await evaluate(`document.querySelector('.format-btn[data-format="${format}"]').click()`);
      labels.push(await evaluate(`(async () => {
        const { studioText } = await import('/src/app/studioWorkspace.js');
        const text = studioText['${lang}'];
        const buttons = ['exportBtn', 'exportSprocketBtn', 'exportSingleBtn'].map(id => document.getElementById(id));
        const expected = [text.export, text.borderExportAction, '${format}' === 'dng' ? text.exportCurrentDng : text.exportCurrent];
        return { lang: '${lang}', format: '${format}', labels: buttons.map(button => button.textContent),
          ok: buttons.every((button, index) => button.textContent === expected[index] && !button.hasAttribute('data-i18n')),
          sprocketDisabled: buttons[1].disabled, exportDisabled: buttons[0].disabled };
      })()`));
    }
  }
  const wrongLabel = labels.find(entry => !entry.ok || entry.sprocketDisabled !== (entry.format === 'dng') || entry.exportDisabled);
  expect(!wrongLabel, 'export button label, data-i18n or disabled state wrong: ' + JSON.stringify(wrongLabel));
  await evaluate(`document.querySelector('.format-btn[data-format="png"]').click()`);
  console.log('ok: export buttons have one writer and read the same in zh/ja/en for PNG/JPEG/TIFF/DNG');

  // ---- Layout changes: refit and redraw only for a real viewer resize ----
  await settle('layout checks idle');
  const layout = await evaluate(`(async () => {
    const afterObservers = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    const container = document.getElementById('canvasContainer');
    const size = () => container.clientWidth + 'x' + container.clientHeight;
    const counters = () => window.__ncDebug.counters();
    const steps = [];
    const step = async (label, action) => {
      const before = counters(), sizeBefore = size();
      action();
      await afterObservers(); await afterObservers();
      const after = counters();
      steps.push({ label, resized: size() !== sizeBefore, refits: after.adjustCanvasDisplay - before.adjustCanvasDisplay,
        draws: after.renderWebGL - before.renderWebGL, curveResizes: after.curveCanvasResizes - before.curveCanvasResizes });
    };
    const curves = document.getElementById('studioCurves');
    const more = document.getElementById('studioMore');
    const curve = document.getElementById('curveCanvas');
    const first = { open: curves.open, width: curve.width };
    await step('curves drawer opened (first reveal)', () => { curves.open = true; });
    const revealed = { width: curve.width, height: curve.height, cssWidth: curve.offsetWidth, cssHeight: curve.offsetHeight,
      alpha: curve.width ? curve.getContext('2d').getImageData(curve.width >> 1, curve.height >> 1, 1, 1).data[3] : 0 };
    await step('curves drawer closed', () => { curves.open = false; });
    await step('curves drawer reopened', () => { curves.open = true; });
    await step('more drawer', () => { more.open = !more.open; });
    await step('more drawer back', () => { more.open = !more.open; });
    await step('conversion tab', () => document.getElementById('studioTab-conversion').click());
    await step('edit tab', () => document.getElementById('studioTab-edit').click());
    await step('colour jump', () => document.querySelector('[data-jump="studioBasic"]').click());
    await step('panel hidden', () => document.getElementById('studioTogglePanel').click());
    await step('panel shown', () => document.getElementById('studioTogglePanel').click());
    await step('strip hidden', () => document.getElementById('studioToggleStrip').click());
    await step('strip shown', () => document.getElementById('studioToggleStrip').click());
    await step('light table', () => document.getElementById('studioToggleLightTable').click());
    await step('film strip', () => document.getElementById('studioToggleLightTable').click());
    return { first, revealed, steps };
  })()`);
  const revealed = layout.revealed;
  expect(!layout.first.open && revealed.cssWidth > 0 && revealed.width === revealed.cssWidth * 2
    && revealed.height === revealed.cssHeight * 2 && revealed.alpha === 255,
  'the curve is not drawn when its drawer is first opened: ' + JSON.stringify(layout));
  const kept = layout.steps.filter(entry => !entry.resized);
  const resized = layout.steps.filter(entry => entry.resized);
  expect(kept.length >= 6 && kept.every(entry => entry.refits === 0 && entry.draws === 0),
    'a layout change that kept the viewer size refit or redrew it: ' + JSON.stringify(layout.steps));
  expect(resized.every(entry => entry.refits >= 1 && entry.draws === 0),
    'a viewer resize redrew WebGL although its buffer follows the texture, or did not refit: ' + JSON.stringify(layout.steps));
  expect(layout.steps.find(entry => entry.label === 'curves drawer reopened').curveResizes === 0,
    'reopening the curve at the same size reallocated its canvas: ' + JSON.stringify(layout.steps));
  console.log('ok: layout changes refit only real viewer resizes and never redraw WebGL for it ' + JSON.stringify(layout.steps.map(({ label, resized, refits, draws }) => ({ label, resized, refits, draws }))));

  // ---- Curve: hover and drag never reallocate; release is one flush ----
  await evaluate(`(() => { const curves = document.getElementById('studioCurves'); curves.open = true; document.getElementById('curveCanvas').scrollIntoView({ block: 'center' }); })()`);
  await wait(300);
  const pointer = `const curve = document.getElementById('curveCanvas'), rect = curve.getBoundingClientRect();
    const fire = (type, x, y) => curve.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: rect.left + rect.width * x, clientY: rect.top + rect.height * y }));`;
  const drag = await evaluate(`(() => {
    ${pointer}
    const before = window.__ncDebug.counters().curveCanvasResizes;
    for (let i = 1; i < 10; i++) fire('mousemove', i / 10, 0.5);
    fire('mousedown', 0.5, 0.5);
    for (let i = 1; i < 6; i++) fire('mousemove', 0.5, 0.5 - i * 0.04);
    return window.__ncDebug.counters().curveCanvasResizes - before;
  })()`);
  const curveRelease = await burst(`${pointer} fire('mouseup', 0.5, 0.3);`);
  expect(drag === 0, `a curve hover or drag reallocated the canvas ${drag} time(s)`);
  expect(curveRelease.flushes === 1 && curveRelease.syncs >= 2, 'curve release is not one flush: ' + JSON.stringify(curveRelease));

  // ---- Slider release, undo: one flush each ----
  await evaluate(`(() => {
    const slider = document.getElementById('cyan');
    slider.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    slider.value = String(Number(slider.value) + 6);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const sliderRelease = await burst(`document.getElementById('cyan').dispatchEvent(new Event('change', { bubbles: true }));`);
  expect(sliderRelease.flushes === 1 && sliderRelease.syncs >= 2, 'slider release is not one flush: ' + JSON.stringify(sliderRelease));
  const undo = await burst(`document.getElementById('undoBtn').click();`);
  expect(undo.flushes === 1 && undo.syncs >= 1, 'undo is not one flush: ' + JSON.stringify(undo));

  // ---- Photo switches: one flush and one row reconcile in the click's turn ----
  await settle('edits idle');
  const cold = await burst(`document.querySelector('.file-list-name[data-index="1"]').click();`);
  expect(cold.flushes === 1 && cold.rowWalks === 1 && cold.filename === 'sync-negative-textured.png',
    'a cold switch did not announce its target in one flush: ' + JSON.stringify(cold));
  await waitFor('second photo open', `${ready} && document.getElementById('studioFilename').textContent === 'sync-negative-textured.png'`, 150_000);
  await settle('second photo idle');
  const warm = await burst(`document.querySelector('.file-list-name[data-index="0"]').click();`);
  expect(warm.flushes === 1 && warm.rowWalks === 1 && warm.filename === 'sync-negative-plain.png',
    'a photo switch is not one flush: ' + JSON.stringify(warm));
  console.log('ok: one flush per burst ' + JSON.stringify({ idleFlush, curveRelease, sliderRelease, undo, cold, warm, warmSwitch: warm.switching === null }));
  await waitFor('first photo back', `${ready} && document.getElementById('studioFilename').textContent === 'sync-negative-plain.png'`, 150_000);
  await expectLoadingOverlayIdle({ evaluate, waitFor, fail }, 'photo switches');
}
