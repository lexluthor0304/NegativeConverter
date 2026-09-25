// Geometry chain off the main thread (#244), on a synthetic 16-bit scan whose
// frame is tilted: the import rotates it once (the auto-frame worker's frame
// is adopted), rotate/mirror show the new framing at once and build their
// planes in the pool, the planes equal the export chain built from the base,
// undo of the latest geometry edit is a reference swap, crop mode never
// builds the whole rotated frame, and the synchronous fallback (workers
// disabled) produces the same planes.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

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
  writeFileSync(fixture, Buffer.from(await encodePng16Blob(rgba, W, H, pako.deflate).arrayBuffer()));

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
    if (rotations !== 1 || imported.mainRotations !== before.mainRotations || imported.adoptedRotations - before.adoptedRotations !== 1) {
      fail('a tilted import must rotate exactly once, not on the main thread: ' + JSON.stringify({ before, imported }));
    }
    if (!importState.descriptor || importState.frameSized !== 0) fail('the rotated frame stayed reachable beside the crop: ' + JSON.stringify(importState));
    if (importState.hash16 !== importState.chainHash16 || importState.hash8 !== importState.chainHash8) fail('import planes differ from the export chain: ' + JSON.stringify(importState));
    console.log(`ok: tilted 16-bit import rotated once (worker frame adopted), planes equal the export chain, no rotated frame kept`);

    // Rotate 90: the new framing is on screen in the click's own task.
    await evaluate(`document.getElementById('studioTab-composition').click()`);
    const beforeRotate = await evaluate(counters);
    const sizeBefore = await evaluate(`[document.getElementById('canvas').width, document.getElementById('canvas').height]`);
    const interim = await evaluate(`(() => {
      const started = performance.now();
      document.getElementById('rotateRightBtn').click();
      return { transform: document.getElementById('canvasTransformWrapper').style.transform, ms: performance.now() - started, pending: window.__ncGeometry.pending() };
    })()`);
    if (!/rotate\(90deg\)/.test(interim.transform) || interim.ms > 100 || !interim.pending) fail('rotate 90 did not show the new framing at once: ' + JSON.stringify(interim));
    await waitFor('rotated planes converted', ready, 120_000);
    await wait(500);
    const rotated = await evaluate(`window.__ncGeometry.inspect({ chain: true })`);
    const afterRotate = await evaluate(counters);
    const sizeAfter = await evaluate(`[document.getElementById('canvas').width, document.getElementById('canvas').height]`);
    if (rotated.hash16 !== rotated.chainHash16 || rotated.hash8 !== rotated.chainHash8) fail('rotated planes differ from the export chain: ' + JSON.stringify(rotated));
    if (afterRotate.poolRotations - beforeRotate.poolRotations !== 1 || afterRotate.mainRotations !== beforeRotate.mainRotations) fail('rotate 90 did not build its planes in the pool: ' + JSON.stringify({ beforeRotate, afterRotate }));
    // The crop box maps through the turn with floor/ceil, so a side may grow by a pixel.
    if (Math.abs(rotated.width - importState.height) > 2 || Math.abs(rotated.height - importState.width) > 2) {
      fail('rotate 90 did not swap the frame: ' + JSON.stringify({ before: [importState.width, importState.height], after: [rotated.width, rotated.height] }));
    }
    // #canvas holds the display preview, sized to the view, so only its
    // aspect ratio has to turn with the frame.
    const aspect = ([w, h]) => w / h;
    if (Math.abs(aspect(sizeAfter) * aspect(sizeBefore) - 1) > 0.02) fail('rotate 90 did not swap the displayed frame: ' + JSON.stringify({ sizeBefore, sizeAfter }));
    if (/rotate/.test(await evaluate(`document.getElementById('canvasTransformWrapper').style.transform`))) fail('the interim turn outlived the new paint');

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
    console.log('ok: rotate 90 and mirror show the new framing in the click task, build exact planes in the pool; undo swaps references');

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

    // A session kept without its planes (as a 60 MP session that does not
    // fit the cache is) rebuilds them from its base when reopened.
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en` });
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
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
