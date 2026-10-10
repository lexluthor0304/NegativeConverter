// Geometry chain off the main thread (#244), on a synthetic 16-bit scan whose
// frame is tilted: the import rotates it once (in the pool; the auto-frame
// worker sends sizes only since #251), rotate/mirror show the new framing at
// once and build their planes in the pool, the planes equal the export chain
// built from the base, undo of the latest geometry edit is a reference swap,
// crop mode never builds the whole rotated frame, and the synchronous
// fallback (workers disabled) produces the same planes.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { crc32, deflateSync } from 'node:zlib';
import { runGeometryArchiveSmoke } from './geometry-archive-smoke.mjs';

// An 8-bit RGB PNG (filter 0 rows) from a per-pixel function: a scan whose
// geometry has no 16-bit plane, so its tilt is rotated on a 2D canvas.
function writePng8(path, width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const o = row + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 3 })), chunk('IEND', Buffer.alloc(0))
  ]));
  return path;
}

// Timing budgets hold on a real Mac; shared CI runners (software GL, noisy
// CPUs) check the behaviour and log the time, which the benchmark measures.
const TIMING_BUDGETS = !process.env.CI;

export async function runGeometrySmoke({ send, evaluate, waitFor, wait, fail, installDialogAutoAccept, port, root }) {
  const second = join(root, 'negative2positive', 'test-fixtures', 'negative-sample.jpg');
  const pako = createRequire(join(root, 'package.json'))('pako');
  const { encodePng16Blob } = await import(join(root, 'negative2positive', 'src', 'workers', 'imageEncoders.js'));
  // Orange rebate around a dark, textured frame turned by 4 degrees. The
  // samples are not multiples of 257, so the 16-bit kernel is exercised.
  const W = 2400, H = 1700, frameW = 1800, frameH = 1200, angle = 4 * Math.PI / 180;
  const rgba = new Uint16Array(W * H * 4);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x + 0.5 - W / 2, dy = y + 0.5 - H / 2;
      const u = dx * cos + dy * sin, v = -dx * sin + dy * cos;
      const i = (y * W + x) * 4;
      if (Math.abs(u) < frameW / 2 && Math.abs(v) < frameH / 2) {
        const n = ((Math.floor(u / 6) * 17 + Math.floor(v / 6) * 23) % 90 + 90) % 90;
        rgba[i] = (40 + n) * 257 + (x % 97); rgba[i + 1] = (22 + n / 2) * 257 + (y % 89); rgba[i + 2] = (18 + n / 3) * 257 + ((x + y) % 83);
      } else {
        rgba[i] = 232 * 257 + (y % 61); rgba[i + 1] = 155 * 257 + (x % 53); rgba[i + 2] = 91 * 257 + 7;
      }
      rgba[i + 3] = 65535;
    }
  }
  const directory = mkdtempSync(join(tmpdir(), 'nc-geometry-'));
  const fixture = join(directory, 'geometry-tilted-16.png');
  writeFileSync(fixture, Buffer.from(await encodePng16Blob(rgba, W, H, pako).arrayBuffer()));
  // The same scan as an 8-bit PNG (#293): its rotation runs on a canvas.
  const fixture8 = writePng8(join(directory, 'geometry-tilted-8.png'), W, H, (x, y) => {
    const i = (y * W + x) * 4;
    return [rgba[i] >>> 8, rgba[i + 1] >>> 8, rgba[i + 2] >>> 8];
  });

  try {
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
    await waitFor('geometry workspace boot', `!!document.getElementById('studioImportAutoCrop') && !!window.__ncGeometry`);
    await installDialogAutoAccept();
    await wait(300);
    const counters = `(() => {
      const g = window.__ncGeometry;
      return { ...g.diagnostics, poolJobs: g.pool.jobs, poolRotations: g.pool.rotations, poolCopies: g.pool.copies,
        syncBands: g.pool.syncBands, workerBands: g.pool.workerBands, fallbacks: g.pool.fallbacks };
    })()`;
    const before = await evaluate(counters);
    const doc = await send('DOM.getDocument');
    const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#fileInput' });
    await send('DOM.setFileInputFiles', { files: [fixture], nodeId: input.result.nodeId });
    const ready = `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy && !window.__ncGeometry.pending()`;
    await waitFor('tilted 16-bit import converted', `${ready} && document.getElementById('studioFilename').textContent === 'geometry-tilted-16.png'`, 120_000);
    await wait(500);
    const imported = await evaluate(counters);
    const importState = await evaluate(`window.__ncGeometry.inspect({ chain: true })`);
    const status = await evaluate(`document.getElementById('studioFrameNotice').dataset.status`);
    if (status !== 'crop' || Math.abs(Math.abs(importState.rotationAngle) - 4) > 0.5) fail('the tilted 16-bit fixture was not straightened and cropped on import: ' + JSON.stringify({ status, importState }));
    const rotations = (imported.workerRotations - before.workerRotations) + (imported.poolRotations - before.poolRotations) + (imported.mainRotations - before.mainRotations);
    if (rotations !== 1 || imported.mainRotations !== before.mainRotations || imported.poolRotations - before.poolRotations !== 1
      || imported.workerRotations !== before.workerRotations || imported.adoptedRotations !== before.adoptedRotations) {
      fail('a tilted import must rotate exactly once, in the pool, with no worker frame: ' + JSON.stringify({ before, imported }));
    }
    if (!importState.descriptor || importState.frameSized !== 0) fail('the rotated frame stayed reachable beside the crop: ' + JSON.stringify(importState));
    if (importState.hash16 !== importState.chainHash16 || importState.hash8 !== importState.chainHash8) fail('import planes differ from the export chain: ' + JSON.stringify(importState));
    console.log(`ok: tilted 16-bit import rotated once (in the pool, no worker frame), planes equal the export chain, no rotated frame kept`);

    // Rotate 90: the new framing is on screen in the click's own task.
    await evaluate(`document.getElementById('studioTab-composition').click()`);
    const beforeRotate = await evaluate(counters);
    // What the screen shows (#242, R1-142): the display preview the surface
    // draws, #canvas (a display-size frame, with the film border around it;
    // none while WebGL presents), the GL source texture, and the wrapper's
    // interim turn.
    const shown = `(() => {
      const f = window.__ncDisplay.frame();
      return { surface: f.surface, display: f.display, handle: f.handle, main: f.canvases.main, texture: f.texture,
        transform: document.getElementById('canvasTransformWrapper').style.transform };
    })()`;
    // A quarter turn turns what is shown, not only the planes: the display
    // preview's aspect, the texture uploaded for it after the build settled
    // (a new geometry resets it) or the frame on #canvas; and the paint of
    // the new planes ends the interim turn.
    const aspect = ([w, h]) => w / h;
    const turned = (a, b) => Boolean(a && b) && Math.abs(aspect(a) * aspect(b) - 1) <= 0.02;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const checkTurnedDisplay = (before, after, label) => {
      if (!turned(before.display, after.display)) fail(`${label} did not turn the displayed frame: ` + JSON.stringify({ before, after }));
      if (after.surface === 'gl' && !same(after.texture, after.display)) fail(`${label}: no texture of the turned frame was uploaded: ` + JSON.stringify({ before, after }));
      if (after.surface === 'cpu' && (!same(after.handle, after.display) || (before.surface === 'cpu' && !turned(before.main, after.main)))) {
        fail(`${label} did not turn the frame on #canvas: ` + JSON.stringify({ before, after }));
      }
      if (/rotate|scaleX\(-1\)/.test(after.transform)) fail(`${label}: the interim turn outlived the new paint: ` + after.transform);
    };
    const shownBefore = await evaluate(shown);
    const interim = await evaluate(`(() => {
      const started = performance.now();
      document.getElementById('rotateRightBtn').click();
      return { transform: document.getElementById('canvasTransformWrapper').style.transform, ms: performance.now() - started, pending: window.__ncGeometry.pending() };
    })()`);
    if (!/rotate\(90deg\)/.test(interim.transform) || (TIMING_BUDGETS && interim.ms > 100) || !interim.pending) fail('rotate 90 did not show the new framing at once: ' + JSON.stringify(interim));
    await waitFor('rotated planes converted', ready, 120_000);
    await wait(500);
    const rotated = await evaluate(`window.__ncGeometry.inspect({ chain: true })`);
    const afterRotate = await evaluate(counters);
    const shownAfter = await evaluate(shown);
    if (rotated.hash16 !== rotated.chainHash16 || rotated.hash8 !== rotated.chainHash8) fail('rotated planes differ from the export chain: ' + JSON.stringify(rotated));
    if (afterRotate.poolRotations - beforeRotate.poolRotations !== 1 || afterRotate.mainRotations !== beforeRotate.mainRotations) fail('rotate 90 did not build its planes in the pool: ' + JSON.stringify({ beforeRotate, afterRotate }));
    // The crop box maps through the turn with floor/ceil, so a side may grow by a pixel.
    if (Math.abs(rotated.width - importState.height) > 2 || Math.abs(rotated.height - importState.width) > 2) {
      fail('rotate 90 did not swap the frame: ' + JSON.stringify({ before: [importState.width, importState.height], after: [rotated.width, rotated.height] }));
    }
    // Only the aspect ratio of the displayed frame has to turn with it.
    checkTurnedDisplay(shownBefore, shownAfter, 'rotate 90');

    // Mirror: flipped at once, exact planes from the pool.
    const flip = await evaluate(`(() => { document.getElementById('mirrorBtn').click(); return document.getElementById('canvasTransformWrapper').style.transform; })()`);
    if (!/scaleX\(-1\)/.test(flip)) fail('mirror did not flip the display at once: ' + flip);
    await waitFor('mirrored planes converted', ready, 120_000);
    const mirrored = await evaluate(`window.__ncGeometry.inspect({ chain: true })`);
    if (!mirrored.mirrored || mirrored.hash16 !== mirrored.chainHash16) fail('mirrored planes differ from the export chain: ' + JSON.stringify(mirrored));

    // Undo of the latest geometry edit swaps references: no pool job.
    const beforeUndo = await evaluate(counters);
    await evaluate(`document.getElementById('undoBtn').click()`);
    await waitFor('undo of mirror', ready, 120_000);
    const undone = await evaluate(`window.__ncGeometry.inspect()`);
    const afterUndo = await evaluate(counters);
    if (undone.mirrored || undone.hash16 !== rotated.hash16 || afterUndo.poolJobs !== beforeUndo.poolJobs) fail('undo of the latest geometry edit was not an instant swap: ' + JSON.stringify({ undone, beforeUndo, afterUndo }));
    console.log(`ok: rotate 90 and mirror show the new framing in the click task, build exact planes in the pool, turn the displayed frame (${shownAfter.surface}); undo swaps references`);

    // With the film border on, on the surface in use and in a CPU mode
    // (WebGL off), where the border is drawn around the frame on #canvas:
    // the bordered paint of the new planes ends the interim turn and flip
    // too (R1-063).
    // The WebGL setting is restored afterwards; the GPU pass runs only where
    // the GL display presents (a browser without WebGL shows #canvas).
    const glSetting = await evaluate(`document.getElementById('coreUseWebGL').checked`);
    const onGpu = shownAfter.surface === 'gl';
    const display = ({ gpu, border }) => evaluate(`(() => {
      const gl = document.getElementById('coreUseWebGL'); if (gl.checked !== ${gpu}) gl.click();
      const button = document.getElementById('sprocketPreviewBtn');
      if ((button.getAttribute('aria-pressed') === 'true') !== ${border}) button.click();
    })()`);
    // The border is shown: the GL photo rectangle inside it, or #canvas larger than the frame it holds.
    const bordered = `(() => { const f = window.__ncDisplay.frame(); return Boolean(f.display) && (f.surface === 'gl' ? f.glPhoto !== null : f.canvases.main[0] * f.canvases.main[1] > f.display[0] * f.display[1]); })()`;
    await display({ gpu: glSetting, border: true });
    await waitFor('film border on', `${ready} && ${bordered}`, 60_000);
    const surfaces = [];
    for (const gpu of onGpu ? [true, false] : [false]) {
      await display({ gpu, border: true });
      await waitFor(`film border on the ${gpu ? 'GPU' : 'CPU'} display`, `${ready} && ${bordered} && window.__ncDisplay.frame().surface === ${JSON.stringify(gpu ? 'gl' : 'cpu')}`, 60_000);
      await wait(300);
      const before = await evaluate(shown);
      const turn = await evaluate(`(() => { document.getElementById('rotateRightBtn').click(); return document.getElementById('canvasTransformWrapper').style.transform; })()`);
      if (!/rotate\(90deg\)/.test(turn)) fail(`rotate 90 with the film border (${before.surface}) did not show the new framing at once: ` + turn);
      await waitFor(`bordered rotation converted (${before.surface})`, ready, 120_000);
      await wait(500);
      const after = await evaluate(shown);
      checkTurnedDisplay(before, after, `rotate 90 with the film border (${after.surface})`);
      const flip = await evaluate(`(() => { document.getElementById('mirrorBtn').click(); return document.getElementById('canvasTransformWrapper').style.transform; })()`);
      if (!/scaleX\(-1\)/.test(flip)) fail(`mirror with the film border (${after.surface}) did not flip the display at once: ` + flip);
      await waitFor(`bordered mirror converted (${after.surface})`, ready, 120_000);
      await wait(500);
      const flipped = await evaluate(shown);
      if (/rotate|scaleX\(-1\)/.test(flipped.transform)) fail(`mirror with the film border (${flipped.surface}): the interim flip outlived the new paint: ` + flipped.transform);
      const planes = await evaluate(`window.__ncGeometry.inspect({ chain: true })`);
      if (planes.hash16 !== planes.chainHash16 || planes.hash8 !== planes.chainHash8) fail('bordered edits built other planes than the export chain: ' + JSON.stringify(planes));
      surfaces.push(after.surface);
    }
    await display({ gpu: glSetting, border: false });
    await waitFor('film border off', `${ready} && !${bordered}`, 60_000);
    console.log(`ok: with the film border on (${surfaces.join(', ')}), the new planes' paint ends the interim turn and flip and turns the bordered frame`);

    // Crop mode shows the whole frame from a sample built off the base.
    await evaluate(`document.getElementById('cropBtn').click()`);
    await waitFor('crop mode', `document.getElementById('canvasContainer').classList.contains('crop-mode')`, 30_000);
    await evaluate(`document.getElementById('cancelCropBtn').click()`);
    await waitFor('crop mode closed', `!document.getElementById('canvasContainer').classList.contains('crop-mode') && ${ready}`, 60_000);

    // The synchronous fallback builds the same planes: rebuild the current
    // geometry without workers and compare, then edit through the fallback.
    const pooled = await evaluate(`window.__ncGeometry.inspect()`);
    await evaluate(`window.__ncGeometry.disableWorkers()`);
    const syncBefore = await evaluate(counters);
    await evaluate(`window.__ncGeometry.rebuild()`);
    await waitFor('rebuild without workers', ready, 120_000);
    const rebuilt = await evaluate(`window.__ncGeometry.inspect()`);
    if (rebuilt.hash16 !== pooled.hash16 || rebuilt.hash8 !== pooled.hash8) fail('the synchronous fallback built different planes: ' + JSON.stringify({ rebuilt, pooled }));
    await evaluate(`document.getElementById('rotateLeftBtn').click()`);
    await waitFor('rotate left without workers', ready, 120_000);
    const sync = await evaluate(`window.__ncGeometry.inspect({ chain: true })`);
    const syncAfter = await evaluate(counters);
    if (sync.hash16 !== sync.chainHash16 || sync.hash8 !== sync.chainHash8) fail('a rotate through the fallback differs from the export chain: ' + JSON.stringify(sync));
    if (syncAfter.syncBands <= syncBefore.syncBands || syncAfter.workerBands !== syncBefore.workerBands) fail('workers were not disabled: ' + JSON.stringify({ syncBefore, syncAfter }));
    const final = await evaluate(counters);
    if (final.pendingReads || final.frameSyncReads) fail('geometry planes were read while a build was pending or built synchronously: ' + JSON.stringify(final));
    console.log('ok: without workers the same core builds identical planes; no plane was read while a build was pending');

    // An 8-bit scan at a non-right angle (#293): the import rotates it on a
    // worker's OffscreenCanvas (once, in the pool, after the pool's check
    // found the worker's bytes equal to the page canvas's), the mirror and
    // crop follow as an index plan, and the planes equal the export chain
    // built on the page (the page canvas's rotation, then the steps): the
    // worker's canvas writes the page canvas's bytes in this browser. No
    // rotation runs on the main thread.
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
    await waitFor('geometry workspace reboot for the 8-bit scan', `!!document.getElementById('studioImportAutoCrop') && !!window.__ncGeometry`);
    await installDialogAutoAccept();
    await wait(300);
    const canvasCounters = `(() => { const g = window.__ncGeometry; return { ...g.diagnostics, poolRotations: g.pool.rotations, canvasRotations: g.pool.canvasRotations,
      syncBands: g.pool.syncBands, workerBands: g.pool.workerBands, fallbacks: g.pool.fallbacks, check: g.canvasRotation() }; })()`;
    const before8 = await evaluate(canvasCounters);
    const doc8 = await send('DOM.getDocument');
    const input8 = await send('DOM.querySelector', { nodeId: doc8.result.root.nodeId, selector: '#fileInput' });
    await send('DOM.setFileInputFiles', { files: [fixture8], nodeId: input8.result.nodeId });
    await waitFor('tilted 8-bit import converted', `${ready} && document.getElementById('studioFilename').textContent === 'geometry-tilted-8.png'`, 120_000);
    await wait(500);
    const imported8 = await evaluate(canvasCounters);
    const state8 = await evaluate(`window.__ncGeometry.inspect({ chain: true })`);
    const status8 = await evaluate(`document.getElementById('studioFrameNotice').dataset.status`);
    console.log('8-bit tilted import:', JSON.stringify({ status: status8, angle: state8.rotationAngle, check: imported8.check, canvasRotations: imported8.canvasRotations - before8.canvasRotations, mainRotations: imported8.mainRotations - before8.mainRotations }));
    if (status8 !== 'crop' || Math.abs(Math.abs(state8.rotationAngle) - 4) > 0.5) fail('the tilted 8-bit fixture was not straightened and cropped on import: ' + JSON.stringify({ status8, state8 }));
    if (!imported8.check.checked || !imported8.check.supported) fail('the pool did not admit the worker canvas (its rotation of the fixture differs from the page canvas): ' + JSON.stringify(imported8.check));
    if (imported8.canvasRotations - before8.canvasRotations !== 1 || imported8.mainRotations !== before8.mainRotations || imported8.poolRotations - before8.poolRotations !== 1) {
      fail('the 8-bit import must rotate exactly once, on a worker canvas: ' + JSON.stringify({ before8, imported8 }));
    }
    if (state8.hash16 !== null || state8.hash8 !== state8.chainHash8) fail('the 8-bit planes differ from the export chain on the page canvas: ' + JSON.stringify(state8));
    // The export chain of a batch export rotates on the worker canvas too.
    // Timed against the page canvas's chain (inspect's), with the main
    // thread's long tasks during the pool's chain (#293 measurement).
    const export8 = await evaluate(`(async () => {
      const g = window.__ncGeometry;
      const before = { canvas: g.pool.canvasRotations, main: g.diagnostics.mainRotations };
      const tasks = [];
      const observer = new PerformanceObserver(list => tasks.push(...list.getEntries().map(entry => Math.round(entry.duration))));
      observer.observe({ entryTypes: ['longtask'] });
      const pageStart = performance.now();
      g.inspect({ chain: true });
      const pageMs = Math.round(performance.now() - pageStart);
      await new Promise(resolve => setTimeout(resolve, 50));
      const pageTasks = tasks.splice(0);
      const poolStart = performance.now();
      const chain = await g.renderChain();
      const poolMs = Math.round(performance.now() - poolStart);
      await new Promise(resolve => setTimeout(resolve, 50));
      observer.disconnect();
      return { ...chain, canvasRotations: g.pool.canvasRotations - before.canvas, mainRotations: g.diagnostics.mainRotations - before.main,
        timing: { pageChainMs: pageMs, pageLongTasks: pageTasks, poolChainMs: poolMs, poolLongTasks: tasks } };
    })()`);
    console.log('8-bit chain timing (page canvas vs worker canvas):', JSON.stringify(export8.timing));
    if (export8.canvasRotations !== 1 || export8.mainRotations !== 0 || export8.hash8 !== state8.chainHash8 || export8.width !== state8.width || export8.height !== state8.height) {
      fail('the export chain of the 8-bit scan did not rotate on the worker canvas with the page canvas\'s bytes: ' + JSON.stringify({ export8, state8 }));
    }
    console.log('ok: an 8-bit scan at a non-right angle rotates once on a worker canvas (the page canvas\'s bytes), in the import and in the export chain');

    // A session kept without its planes (as a 60 MP session that does not
    // fit the cache is) rebuilds them from its base when reopened.
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en&debug=1` });
    await waitFor('geometry workspace reboot', `!!document.getElementById('studioImportAutoCrop') && !!window.__ncGeometry`);
    await installDialogAutoAccept();
    await wait(300);
    await evaluate(`window.__ncGeometry.diagnostics.coldSessions = true`);
    const doc2 = await send('DOM.getDocument');
    const input2 = await send('DOM.querySelector', { nodeId: doc2.result.root.nodeId, selector: '#fileInput' });
    await send('DOM.setFileInputFiles', { files: [fixture, second], nodeId: input2.result.nodeId });
    const readyFor = name => `${ready} && document.getElementById('studioFilename').textContent === ${JSON.stringify(name)}`;
    await waitFor('tilted photo of two', readyFor('geometry-tilted-16.png'), 120_000);
    await wait(800);
    const first = await evaluate(`window.__ncGeometry.inspect()`);
    const indexOf = name => `[...document.querySelectorAll('.file-list-name')].find(el => el.textContent.includes(${JSON.stringify(name)}))?.dataset.index`;
    await evaluate(`document.querySelector('.file-list-name[data-index="' + ${indexOf('negative-sample')} + '"]').click()`);
    await waitFor('second photo', readyFor('negative-sample.jpg'), 120_000);
    const coldBefore = await evaluate(`window.__ncGeometry.diagnostics.coldRestores`);
    await evaluate(`document.querySelector('.file-list-name[data-index="' + ${indexOf('geometry-tilted')} + '"]').click()`);
    await waitFor('tilted photo reopened', readyFor('geometry-tilted-16.png'), 120_000);
    const reopened = await evaluate(`window.__ncGeometry.inspect({ chain: true })`);
    const coldAfter = await evaluate(`window.__ncGeometry.diagnostics.coldRestores`);
    if (coldAfter !== coldBefore + 1) fail('the tilted photo did not reopen from a session kept without its planes: ' + JSON.stringify({ coldBefore, coldAfter }));
    if (reopened.hash16 !== first.hash16 || reopened.hash16 !== reopened.chainHash16 || reopened.rotationAngle !== first.rotationAngle
      || JSON.stringify(reopened.cropRegion) !== JSON.stringify(first.cropRegion)) {
      fail('a cold session rebuilt different planes: ' + JSON.stringify({ first, reopened }));
    }
    console.log('ok: a session kept without its planes reopens with the exact planes rebuilt from its base');
    await runGeometryArchiveSmoke({ evaluate, waitFor, wait, fail });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
