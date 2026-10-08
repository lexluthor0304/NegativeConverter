// S5 geometry: enter crop; drag an edge for 2 s; ⌘-draw a straighten line;
// apply the crop; rotate 90° twice; mirror. Each step records the time to
// the first redraw (and whether the crop view shows the positive), the
// longest main-thread task and the task count in its window.
import { byKind, rafGapSummary } from '../lib/metrics.mjs';
import { median, p95 } from '../lib/stats.mjs';
import { bootApp, importPhotos, recordMemory, sleep, pageNow, allPictures, clickElement, longTasks, round } from './common.mjs';

const META = process.platform === 'darwin' ? 4 : 2;

async function afterAction(ctx, prefix, inputT, { needPositive = false, observeMs = 6000 } = {}) {
  const { session } = ctx;
  const deadline = Date.now() + 120_000;
  let picture = null;
  while (Date.now() < deadline) {
    await sleep(250);
    await session.drain();
    picture = allPictures(session.events).find(pic => pic.t >= inputT && (!needPositive || (pic.positive && pic.contentT >= inputT))) || null;
    if (picture) break;
  }
  await sleep(Math.max(0, observeMs - 250));
  await session.waitForReady({ timeoutMs: 300_000 });
  await session.drain();
  const end = picture ? picture.t + 500 : await pageNow(ctx);
  const tasks = longTasks(ctx, inputT, end);
  const key = needPositive ? 'positiveDrawnMs' : 'firstRedrawMs';
  ctx.record(`${prefix}.${key}`, picture ? round(picture.t - inputT) : null);
  ctx.record(`${prefix}.maxLongTaskMs`, tasks.maxMs);
  ctx.record(`${prefix}.longTaskCount`, tasks.n);
  return picture;
}

export default {
  id: 's5',
  title: 'Crop, straighten, rotate, mirror',
  fixtureGroup: 'interactive',
  async run(ctx) {
    const { session } = ctx;
    await bootApp(ctx);
    const memoryFrom = session.memoryMark();
    await importPhotos(ctx, [ctx.fixture.path]);
    await session.setDpr(2);
    await sleep(3200);
    await session.waitForReady({ timeoutMs: 120_000 });

    // Enter crop.
    await session.beginWindow('s5-enter');
    const enterT = await clickElement(ctx, 'cropBtn');
    const enter = await afterAction(ctx, 's5.enterCrop', enterT, { observeMs: 1500 });
    if (enter) ctx.record('s5.enterCrop.firstDrawMs', round(enter.t - enterT));
    // The crop view's own pixels when it draws on #cropCanvas (#245).
    ctx.record('s5.enterCrop.previewPx', enter?.canvasW ? `${enter.canvasW}×${enter.canvasH}` : (enter?.w ? `${enter.w}×${enter.h}` : null));
    ctx.record('s5.enterCrop.showsPositive', enter ? String(enter.positive) : null);
    await session.endWindow();

    // Drag the right edge inward for 2 s.
    const handle = await session.rect('#cropOverlay .crop-handle-e');
    const overlay = await session.rect('#cropOverlay');
    if (handle && overlay) {
      const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
      const start = await pageNow(ctx);
      await session.beginWindow('s5-edge');
      await session.drag({ from, to: { x: from.x - overlay.width * 0.15, y: from.y }, steps: 120 });
      await sleep(500);
      const window = await session.endWindow();
      const moves = byKind(session.events, 'input').filter(event => event.type === 'mousemove' && event.b && event.t >= start);
      const mutations = byKind(session.events, 'mut').filter(event => event.what === 'cropOverlay' && event.t >= start);
      const latencies = moves.map(move => mutations.find(mutation => mutation.t >= move.t)).map((mutation, i) => (mutation ? mutation.t - moves[i].t : null)).filter(Number.isFinite);
      const frames = rafGapSummary(window.frames);
      const spanS = moves.length > 1 ? (moves.at(-1).t - moves[0].t) / 1000 : 2;
      const frameSet = new Set(mutations.map(mutation => window.frames.findLastIndex(frame => frame <= mutation.t)));
      ctx.record('s5.edgeDrag.overlayFps', round(frameSet.size / spanS, 1));
      ctx.record('s5.edgeDrag.moveToFrameP50Ms', round(median(latencies)));
      ctx.record('s5.edgeDrag.moveToFrameP95Ms', round(p95(latencies)));
      ctx.record('s5.edgeDrag.rafFps', frames.fps);
      ctx.record('s5.edgeDrag.longTaskCount', longTasks(ctx, start, window.end).n);
    } else {
      ctx.note('s5: crop handles not found');
    }

    // ⌘-draw a straighten line inside the crop area.
    const area = await session.rect('#cropOverlay');
    if (area) {
      const y = area.y + area.height * 0.45;
      const start = await pageNow(ctx);
      await session.beginWindow('s5-straighten');
      await session.drag({ from: { x: area.x + area.width * 0.25, y }, to: { x: area.x + area.width * 0.7, y: y + area.height * 0.02 }, steps: 30, modifiers: META });
      await session.drain();
      const release = byKind(session.events, 'input').find(event => event.type === 'mouseup' && event.t >= start);
      await afterAction(ctx, 's5.straighten', release?.t ?? start, { observeMs: 1500 });
      const pictureT = ctx.metrics['s5.straighten.firstRedrawMs'];
      if (pictureT !== undefined) ctx.record('s5.straighten.releaseToPreviewMs', pictureT);
      await session.endWindow();
    }

    // Apply the crop. Feedback and the positive are recorded apart (#245):
    // the first frame whose overlay is fully opaque, the longest task before
    // it, then the positive.
    await session.beginWindow('s5-apply');
    const applyT = await clickElement(ctx, 'applyCropBtn');
    await afterAction(ctx, 's5.applyCrop', applyT, { needPositive: true });
    await session.endWindow();
    const opaque = byKind(session.events, 'vis').find(event => event.t >= applyT && event.ov && Number.isFinite(event.op) && event.op >= 0.99) || null;
    ctx.record('s5.applyCrop.overlayOpaqueMs', opaque ? round(opaque.t - applyT) : null);
    ctx.record('s5.applyCrop.maxTaskBeforeOverlayMs', opaque ? longTasks(ctx, applyT, opaque.t).maxMs : null);

    // Rotate 90° twice, then mirror.
    for (const name of ['rotate90a', 'rotate90b']) {
      await sleep(1000);
      await session.beginWindow(`s5-${name}`);
      const t = await clickElement(ctx, 'rotateRightBtn');
      await afterAction(ctx, `s5.${name}`, t);
      await session.endWindow();
    }
    await sleep(1000);
    await session.beginWindow('s5-mirror');
    const mirrorT = await clickElement(ctx, 'mirrorBtn');
    await afterAction(ctx, 's5.mirror', mirrorT);
    await session.endWindow();
    await recordMemory(ctx, 's5', memoryFrom);
  }
};
