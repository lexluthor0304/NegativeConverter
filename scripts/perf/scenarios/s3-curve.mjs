// S3 curve: add a mid-tone point on the diagonal, then drag it up 20 % over
// 3 s, keeping the pointer inside the curve canvas (the drag ends on
// mouseleave). Metrics as S2, plus the rAF frame rate.
import { byKind, dragMetrics, eventTimingP95, rafGapSummary } from '../lib/metrics.mjs';
import { bootApp, importPhotos, recordMemory, longTasks, sleep } from './common.mjs';

export async function dragCurve(ctx, prefix, { observeMs = 3000, steps = 180 } = {}) {
  const { session } = ctx;
  const rect = await session.reveal('curveCanvas');
  const x = rect.x + rect.width * 0.5;
  const y = rect.y + rect.height * 0.5;
  const to = { x, y: y - rect.height * 0.2 };
  await sleep(500);
  await session.drain();
  const start = await session.beginWindow(prefix);
  await session.drag({ from: { x, y }, to, steps });
  await sleep(500);
  const window = await session.endWindow();
  await sleep(Math.max(0, observeMs - 500));
  await session.drain();
  const inputs = byKind(session.events, 'input').filter(event => event.t >= start);
  const press = inputs.find(event => event.type === 'mousedown' && event.id === 'curveCanvas');
  const release = press ? inputs.find(event => event.type === 'mouseup' && event.t >= press.t) : null;
  if (!press || !release) { ctx.note(`${prefix}: the curve drag registered no press/release`); return null; }
  const metrics = dragMetrics(session.events, {
    targetId: 'curveCanvas', mode: 'pointer', frameTimes: window.frames,
    window: { start: press.t, release: release.t, end: release.t + observeMs }
  });
  const tasks = longTasks(ctx, press.t, release.t + 500);
  const gaps = rafGapSummary(window.frames);
  const out = {
    ...metrics,
    eventTimingP95Ms: eventTimingP95(session.events, { start: press.t, end: release.t + 500, inputCount: metrics.inputs }),
    mainBusyPct: window.mainBusyPct,
    longTaskCount: tasks.n,
    maxLongTaskMs: tasks.maxMs,
    rafGapsOver50: gaps.gapsOver,
    rafFps: gaps.fps,
    probeSelfPct: window.probeSelfPct
  };
  for (const [key, value] of Object.entries(out)) ctx.record(`${prefix}.${key}`, value);
  await session.evaluate(`document.getElementById('resetCurveBtn')?.click(); true`);
  await sleep(1000);
  await session.waitForReady({ timeoutMs: 120_000 });
  return out;
}

export default {
  id: 's3',
  title: 'Curve drag',
  fixtureGroup: 'interactive',
  async run(ctx) {
    const { session } = ctx;
    await bootApp(ctx);
    const memoryFrom = session.memoryMark();
    await importPhotos(ctx, [ctx.fixture.path]);
    for (const dpr of ctx.dprs) {
      await session.setDpr(dpr);
      await sleep(3200);
      await session.waitForReady({ timeoutMs: 120_000 });
      await dragCurve(ctx, `s3.curve.dpr${dpr}`);
    }
    await recordMemory(ctx, 's3', memoryFrom);
  }
};
