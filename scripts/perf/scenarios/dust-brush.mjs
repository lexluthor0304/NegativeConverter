// #259: 60 MP DNG, AI off, Show mask on, twenty trusted brush strokes.
import { byKind } from '../lib/metrics.mjs';
import { distribution, round } from '../lib/stats.mjs';
import { bootApp, importPhotos, recordMemory, allPictures, longTasks, sleep } from './common.mjs';

export const DUST_STEPS = Array.from({ length: 20 }, (_, index) => ({
  x: 0.2 + (index % 5) * 0.12, y: 0.25 + Math.floor(index / 5) * 0.12, dx: 0.02, moves: 10, modifiers: 1
}));

export default {
  id: 'dust-brush', title: 'Dust brush (60 MP, AI off)', fixtureGroup: 'dust', steps: DUST_STEPS,
  async run(ctx) {
    const { session } = ctx;
    await bootApp(ctx);
    await session.evaluate(`(() => { const ai = document.getElementById('dustAiEnabled'); if (ai.checked) ai.click(); return true; })()`);
    await importPhotos(ctx, [ctx.fixture.path]);
    const decode = byKind(session.events, 'res').find(event => event.cls === 'libraw' && event.fn === 'imageData');
    if (!decode || decode.w * decode.h < 60_000_000) throw new Error('dust-brush requires a full-resolution 60 MP LibRaw DNG');
    ctx.record('dust-brush.fixture', ctx.fixture.name);
    ctx.record('dust-brush.sourcePixels', decode.w * decode.h);
    await session.reveal('dustRemovalEnabled');
    await session.evaluate(`(() => { for (const id of ['dustRemovalEnabled', 'dustShowMask']) { const box = document.getElementById(id); if (!box.checked) box.click(); } return true; })()`);
    await session.waitFor('dust detected', `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy && /Detected|No dust detected/.test(document.getElementById('dustStatus').textContent)`, { timeoutMs: 600_000 });
    // Plane seeding is setup, excluded from every per-stroke payload window.
    await sleep(3000);
    const memoryFrom = session.memoryMark();
    const beforeMemory = session.memorySummary()?.rendererAfterMB;
    const surface = await session.evaluate(`getComputedStyle(document.getElementById('glCanvas')).display === 'none' ? '#canvas' : '#glCanvas'`);
    const rect = await session.rect(surface);
    const samples = [];
    for (const [index, step] of DUST_STEPS.entries()) {
      await session.drain();
      const start = await session.beginWindow(`dust-brush.stroke${index}`);
      const from = { x: rect.x + rect.width * step.x, y: rect.y + rect.height * step.y };
      await session.drag({ from, to: { x: from.x + rect.width * step.dx, y: from.y }, steps: step.moves, modifiers: step.modifiers });
      await session.drain();
      const release = byKind(session.events, 'input').findLast(event => event.type === 'mouseup' && event.t >= start);
      if (!release) throw new Error(`dust stroke ${index}: no trusted mouseup`);
      let painted = null, reply = null;
      const deadline = Date.now() + 120_000;
      while (!painted && Date.now() < deadline) {
        session.check(); await session.drain();
        reply = byKind(session.events, 'res').find(event => event.cls === 'dust' && event.fn === 'stroke' && event.rt >= start && !event.err);
        if (reply) painted = allPictures(session.events).find(pic => pic.t >= reply.t);
        if (!painted) await sleep(20);
      }
      if (!painted) throw new Error(`dust stroke ${index}: repaired pixels never painted`);
      const window = await session.endWindow();
      const tasks = longTasks(ctx, start, painted.t);
      const messages = session.events.filter(event => ['req', 'res'].includes(event.k) && event.cls === 'dust' && event.t >= start && event.t <= window.end);
      const sample = { releaseToRepairedMs: round(painted.t - release.t), workerMs: round(reply.t - reply.rt),
        maxLongTaskMs: tasks.maxMs, longTaskCount: tasks.n, postMessageMaxBytes: Math.max(0, ...messages.map(event => event.bytes || 0)),
        sharedPlaneMaxBytes: Math.max(0, ...messages.map(event => event.sharedBytes || 0)) };
      for (const [key, value] of Object.entries(sample)) ctx.record(`dust-brush.stroke${index}.${key}`, value);
      samples.push(sample);
    }
    ctx.raw['dust-brush.strokes'] = samples;
    ctx.record('dust-brush.strokes', samples.length);
    ctx.record('dust-brush.releaseToRepairedP95Ms', round(distribution(samples.map(sample => sample.releaseToRepairedMs)).p95));
    ctx.record('dust-brush.maxLongTaskMs', Math.max(...samples.map(sample => sample.maxLongTaskMs)));
    ctx.record('dust-brush.postMessageMaxBytes', Math.max(...samples.map(sample => sample.postMessageMaxBytes)));
    ctx.record('dust-brush.retainedGrowthMB', session.memorySummary()?.rendererAfterMB - beforeMemory);
    await recordMemory(ctx, 'dust-brush', memoryFrom);
  }
};
