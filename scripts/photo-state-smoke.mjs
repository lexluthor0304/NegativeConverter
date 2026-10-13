import assert from 'node:assert/strict';
import { bootPhotoSession } from './photo-session-smoke.mjs';

const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy && !document.body.dataset.studioPreparing`;

export async function runPhotoStateSmoke({ send, evaluate, waitFor, installDialogAutoAccept, port }) {
  const until = async (label, expression, timeout = 120000) => {
    assert.ok(await waitFor(label, expression, timeout, { soft: true }), `timeout: ${label}`);
  };
  await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 680, deviceScaleFactor: 1, mobile: false });
  await bootPhotoSession({ send, evaluate, until, installDialogAutoAccept, port, query: '&debug=1&largeImagePixels=100000' });
  await evaluate(`(async () => {
    document.querySelector('.film-type-btn[data-type="bw"]').click();
    const transfer = new DataTransfer();
    for (const [fixture, name] of [['negative-gradient-16.png', 'state-a.png'], ['negative-plain.png', 'state-b.png']]) {
      const blob = await (await fetch('/test-fixtures/' + fixture)).blob();
      transfer.items.add(new File([blob], name, { type: 'image/png' }));
    }
    const input = document.getElementById('fileInput'); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const idle = () => until('photo state idle', `${ready} && window.__photoSessionProbe.inFlight === 0 && performance.now() - window.__photoSessionProbe.lastActivity > 1200`);
  const open = async index => {
    await evaluate(`document.querySelector('.file-list-name[data-index="${index}"]').click()`);
    await until(`photo ${index} active`, `${ready} && document.querySelector('.file-list-name[aria-current="true"]')?.dataset.index === '${index}'`);
    await idle();
  };
  await idle();
  await evaluate(`document.getElementById('studioTab-composition').click(); document.getElementById('cropBtn').click()`);
  await until('crop draft open', `document.getElementById('cropOverlay').style.display === 'block'`);
  const corner = await evaluate(`(() => {
    const r = document.getElementById('cropOverlay').getBoundingClientRect();
    return { x: r.right - 2, y: r.bottom - 2, toX: r.left + r.width * .7, toY: r.top + r.height * .75 };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: corner.x, y: corner.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: corner.toX, y: corner.toY, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: corner.toX, y: corner.toY, button: 'left', buttons: 0, clickCount: 1 });
  await evaluate(`document.getElementById('applyCropBtn').click()`);
  await until('crop applied', `${ready} && document.getElementById('cropOverlay').style.display === 'none' && !window.__ncAnalysis.pendingDetection()`);
  await idle();
  const cropBefore = await evaluate('window.__ncTwoStage.status().settings.cropRegion');
  assert.ok(cropBefore, 'the test applies a real crop');
  const keys = ['coreExposure', 'coreContrast', 'coreTemperature', 'coreTint', 'cyan', 'coreSaturation'];
  const edited = [13, 17, 11, -9, 18, 23];
  const recipe = () => evaluate(`Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, window.__ncTwoStage.status().settings[key]]))`);
  const inputs = () => evaluate(`Object.fromEntries(${JSON.stringify(keys)}.map(key => [key, Number(document.getElementById(key).value)]))`);
  for (const tier of [null, 'A', 'B', 'spill', 'cold']) {
    await evaluate(`(() => {
      window.__ncGeometry.diagnostics.coldSessions = ${tier === 'cold'};
      window.__ncDisplaySessions.force(${JSON.stringify(tier === 'cold' ? null : tier)});
      for (const [key, value] of ${JSON.stringify(keys.map((key, i) => [key, edited[i]]))}) {
        const input = document.getElementById(key); input.value = String(value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`);
    const before = await recipe();
    // Leave without exporting or clicking Save. The switch owns persistence.
    await open(1);
    const b = await recipe();
    assert.notDeepEqual(b, before, `B must keep its own settings (${tier})`);
    await open(0);
    assert.deepEqual(await recipe(), before, `A's unsaved settings survive (${tier})`);
    assert.deepEqual(await inputs(), before, `A's controls reflect its settings (${tier})`);
    assert.deepEqual(await evaluate('window.__ncTwoStage.status().settings.cropRegion'), cropBefore, `A's crop survives (${tier})`);
    console.log(`ok: unsaved A/B/A settings: ${tier || 'full'}`);
  }

  // Navigating away is not Cancel: retain the unapplied crop box separately
  // from the already-applied recipe, without applying it to B or exports.
  await evaluate(`document.getElementById('cropBtn').click()`);
  await until('second crop draft open', `document.getElementById('cropOverlay').style.display === 'block'`);
  await evaluate(`(async () => {
    document.getElementById('rotateRightBtn').click();
    await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
  })()`);
  const draftCorner = await evaluate(`(() => {
    const r = document.getElementById('cropOverlay').getBoundingClientRect();
    return { x: r.right - 2, y: r.bottom - 2, toX: r.left + r.width * .65, toY: r.top + r.height * .8 };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: draftCorner.x, y: draftCorner.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: draftCorner.toX, y: draftCorner.toY, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: draftCorner.toX, y: draftCorner.toY, button: 'left', buttons: 0, clickCount: 1 });
  const draftBox = () => evaluate(`(() => {
    const r = document.getElementById('cropOverlay').getBoundingClientRect();
    const c = document.getElementById('cropCanvas').getBoundingClientRect();
    return [(r.left - c.left) / c.width, (r.top - c.top) / c.height, r.width / c.width, r.height / c.height];
  })()`);
  const draftBefore = await draftBox();
  await open(1);
  assert.equal(await evaluate(`document.getElementById('cropOverlay').style.display`), 'none', 'A draft does not leak to B');
  await open(0);
  await until('A crop draft resumed', `document.getElementById('cropOverlay').style.display === 'block'`, 10000);
  const draftAfter = await draftBox();
  assert.ok(draftBefore.every((value, i) => Math.abs(value - draftAfter[i]) < .005), `crop draft changed: ${draftBefore} -> ${draftAfter}`);
  assert.deepEqual(await evaluate('window.__ncTwoStage.status().settings.cropRegion'), cropBefore, 'resuming a draft does not apply it');
  await evaluate(`document.getElementById('cancelCropBtn').click()`);
  await open(1); await open(0);
  assert.equal(await evaluate(`document.getElementById('cropOverlay').style.display`), 'none', 'Cancel discards the retained draft');
  console.log('ok: crop draft resumes on its own photo and explicit Cancel discards it');

  // B has already been viewed with the brush off. Returning to it with the
  // brush ON must prepare its full-resolution plane without a checkbox event.
  await evaluate(`(() => {
    window.__ncGeometry.diagnostics.coldSessions = false;
    window.__ncDisplaySessions.force(null);
    document.getElementById('studioTab-repair').click();
  })()`);
  await evaluate(`window.__ncAiRepair.load('wasm')`);
  await evaluate(`document.getElementById('aiBrushEnabled').click()`);
  await idle();
  await open(1);
  const strokeCount = await evaluate('window.__ncAiRepair.state().strokes');
  const point = await evaluate(`(() => {
    const surface = ['glCanvas', 'canvas'].map(id => document.getElementById(id)).find(el => el && getComputedStyle(el).display !== 'none');
    const rect = surface.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
  await until('armed brush accepts first stroke after switch', `window.__ncAiRepair.state().strokes === ${strokeCount + 1}`, 10000);
  const strokesB = await evaluate('window.__ncTwoStage.status().settings.repairStrokes');
  await open(0);
  assert.deepEqual(await evaluate('window.__ncTwoStage.status().settings.repairStrokes'), [], 'B strokes do not leak into A');
  assert.deepEqual(await evaluate('window.__ncTwoStage.status().settings.cropRegion'), cropBefore, 'A crop survives a repaired B');
  await open(1);
  assert.deepEqual(await evaluate('window.__ncTwoStage.status().settings.repairStrokes'), strokesB, 'B retains its repair strokes after returning');
  console.log('ok: armed AI repair brush accepts a stroke after switching without toggling');
}
