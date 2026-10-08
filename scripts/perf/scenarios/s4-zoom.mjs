// S4 zoom and pan: double-click fit→2×; #zoomInBtn to 2.5×, 3.9× and 7.6×;
// fit→true 100 % with the 1:1 button (#248); 24 wheel notches at 60 Hz; a 2 s
// pan at 2×. Backing ÷ needed is the GL texture width ÷ min(source width,
// on-screen CSS width × DPR); 1.0 is one source pixel per device pixel.
import { byKind, zoomStepMetrics, panMetrics, GL_CANVAS } from '../lib/metrics.mjs';

// The detail layer's canvas (#248 part 5).
const DETAIL_CANVAS = 'glDetailCanvas';
import { median } from '../lib/stats.mjs';
import { bootApp, importPhotos, recordMemory, sleep, pageNow, sourceWidthEstimate, round } from './common.mjs';

export const OBSERVE_MS = 3000;
// fit → 2× by double-click; then 1.25× per button press: 2.5, 3.9 (3.125 → 3.9), 7.6 (4.9 → 6.1 → 7.6).
export const ZOOM_STEPS = [
  { name: 'fitTo2x', kind: 'dblclick' },
  { name: 'to2_5x', kind: 'button', presses: 1 },
  { name: 'to3_9x', kind: 'button', presses: 2 },
  { name: 'to7_6x', kind: 'button', presses: 3 }
];

function zoomOf(transform) {
  const match = /matrix\(([\d.]+)/.exec(transform || '');
  return match ? Number(match[1]) : 1;
}

async function stepMetrics(ctx, prefix, inputT, source) {
  const { session } = ctx;
  await sleep(OBSERVE_MS);
  await session.drain();
  const snapshot = await session.evaluate('globalThis.__ncPerf.snapshot()');
  const displayedCssWidth = snapshot.glCanvas?.rect?.width;
  const metrics = zoomStepMetrics(session.events, {
    inputT, until: inputT + OBSERVE_MS, sourceWidth: source.width, displayedCssWidth, dpr: session.dpr
  });
  const needed = Math.min(source.width, displayedCssWidth * session.dpr);
  const native = byKind(session.events, 'gl.upload')
    .find(upload => upload.c === GL_CANVAS && upload.t >= inputT && upload.t <= inputT + OBSERVE_MS && upload.w / needed >= 0.999);
  // Since #248 native detail comes from the detail layer's own canvas: the
  // first region upload after the input, and the density it shows at the end.
  const detailUpload = byKind(session.events, 'gl.upload')
    .find(upload => upload.c === DETAIL_CANVAS && upload.t >= inputT && upload.t <= inputT + OBSERVE_MS && upload.w * upload.h > 65536);
  const detail = snapshot.detail || null;
  metrics.detailReadyMs = detailUpload ? round(detailUpload.t - inputT) : null;
  metrics.detailVisible = Boolean(detail?.visible);
  metrics.sourcePxPerDevicePx = detail ? round(detail.sourcePxPerDevicePx, 2) : null;
  // The most the view can show is one source pixel per device pixel (#270):
  // above true 100 % a native region gives source ÷ on-screen device pixels.
  const best = displayedCssWidth > 0 ? Math.min(1, source.width / (displayedCssWidth * session.dpr)) : 1;
  metrics.bestSourcePxPerDevicePx = round(best, 2);
  const sharp = Boolean(detail?.visible) && detail.sourcePxPerDevicePx >= 0.95 * best;
  // A region shown before the step that still covers the view that sharply (a
  // step inside a native region) is native detail from the step's first
  // frame on: it counts at the transform.
  const kept = sharp && !detailUpload && Number.isFinite(metrics.transformAppliedMs);
  const reached = native || (detailUpload && sharp ? detailUpload : null);
  metrics.nativeDetailMs = reached ? round(reached.t - inputT) : kept ? metrics.transformAppliedMs : OBSERVE_MS;
  metrics.nativeDetailReached = Boolean(reached) || kept;
  // Where the time of the step's region went (#270), from the app's
  // nc:detailRegion measure (?perf=1): input → request (settle, waits),
  // request → converted pixels (row cuts, analysis, workers), → drawn.
  const region = byKind(session.events, 'um').find(entry => entry.n === 'nc:detailRegion' && entry.s >= inputT
    && entry.s <= inputT + OBSERVE_MS && entry.detail?.stages?.some(stage => stage.stage === 'shown'));
  if (region) {
    const stage = name => region.detail.stages.find(entry => entry.stage === name) || null;
    metrics.detailRequestMs = round(region.s - inputT);
    metrics.detailConvertMs = stage('converted')?.totalMs ?? null;
    metrics.detailDrawMs = stage('shown')?.ms ?? null;
    metrics.detailBands = region.detail.bands || 1;
    const workers = [].concat(region.detail.worker || []).filter(Boolean);
    if (workers.length) metrics.detailWorkerMs = round(Math.max(...workers.map(times => (times.analysis || 0) + (times.input || 0) + (times.convert || 0))));
  }
  metrics.zoom = round(zoomOf(snapshot.transform), 2);
  for (const [key, value] of Object.entries(metrics)) ctx.record(`${prefix}.${key}`, value);
  return metrics;
}

async function center(ctx) {
  const rect = await ctx.session.rect('#canvasContainer');
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, rect };
}

// The 1:1 button toggles fit ↔ actual pixels (#248): clicking it resets only
// a zoomed view.
export const FIT_ZOOM_SCRIPT = `(() => { if (document.getElementById('canvasContainer')?.classList.contains('zoom-pan-active')) document.getElementById('zoomResetBtn')?.click(); return true; })()`;

async function resetZoom(ctx) {
  await ctx.session.evaluate(FIT_ZOOM_SCRIPT);
  await sleep(800);
  await ctx.session.waitForReady({ timeoutMs: 120_000 });
}

export default {
  id: 's4',
  title: 'Zoom and pan',
  fixtureGroup: 'interactive',
  async run(ctx) {
    const { session } = ctx;
    await bootApp(ctx);
    const memoryFrom = session.memoryMark();
    await importPhotos(ctx, [ctx.fixture.path]);
    const source = sourceWidthEstimate(session.events, ctx.fixture.width);
    ctx.raw['s4.sourceWidth'] = source;
    for (const dpr of ctx.dprs) {
      await session.setDpr(dpr);
      await sleep(3200);
      await session.waitForReady({ timeoutMs: 120_000 });
      await resetZoom(ctx);
      const prefix = `s4.dpr${dpr}`;
      const point = await center(ctx);
      await session.beginWindow(`${prefix}-zoom`);
      for (const step of ZOOM_STEPS) {
        const before = await pageNow(ctx);
        if (step.kind === 'dblclick') {
          await session.dblclick(point.x, point.y);
        } else {
          const button = await session.rect('#zoomInBtn');
          for (let i = 0; i < step.presses; i++) {
            if (i) await sleep(400);
            await session.click(button.x + button.width / 2, button.y + button.height / 2);
          }
        }
        await session.drain();
        const inputs = byKind(session.events, 'input').filter(event => event.t >= before && (event.type === 'dblclick' || (event.type === 'click' && event.id === 'zoomInBtn')));
        const inputT = inputs.at(-1)?.t ?? before;
        await stepMetrics(ctx, `${prefix}.${step.name}`, inputT, source);
      }
      const zoomWindow = await session.endWindow();
      ctx.record(`${prefix}.zoom.longTaskCount`, byKind(session.events, 'lt').filter(task => task.s >= zoomWindow.start && task.s <= zoomWindow.end).length);

      // True 100 %: the 1:1 button from fit.
      await resetZoom(ctx);
      await session.beginWindow(`${prefix}-actual`);
      const actualBefore = await pageNow(ctx);
      const oneToOne = await session.rect('#zoomResetBtn');
      await session.click(oneToOne.x + oneToOne.width / 2, oneToOne.y + oneToOne.height / 2);
      await session.drain();
      const actualInput = byKind(session.events, 'input').filter(event => event.t >= actualBefore && event.type === 'click' && event.id === 'zoomResetBtn').at(-1);
      await stepMetrics(ctx, `${prefix}.fitTo100`, actualInput?.t ?? actualBefore, source);
      const actualWindow = await session.endWindow();
      ctx.record(`${prefix}.fitTo100.longTaskCount`, byKind(session.events, 'lt').filter(task => task.s >= actualWindow.start && task.s <= actualWindow.end).length);

      // Wheel: 24 notches at 60 Hz; transform applied per notch.
      await resetZoom(ctx);
      const wheelStart = await pageNow(ctx);
      await session.beginWindow(`${prefix}-wheel`);
      await session.wheel(point.x, point.y, -60, { count: 24 });
      await sleep(1000);
      const wheelWindow = await session.endWindow();
      const wheels = byKind(session.events, 'input').filter(event => event.type === 'wheel' && event.t >= wheelStart);
      const transforms = byKind(session.events, 'mut').filter(event => event.what === 'transform' && event.t >= wheelStart);
      const perNotch = wheels.map(wheel => transforms.find(mutation => mutation.t >= wheel.t)).map((mutation, i) => (mutation ? mutation.t - wheels[i].t : null)).filter(Number.isFinite);
      ctx.record(`${prefix}.wheel.transformAppliedMs`, round(median(perNotch)));
      ctx.record(`${prefix}.wheel.notches`, wheels.length);
      ctx.record(`${prefix}.wheel.zoom`, round(zoomOf(transforms.at(-1)?.v), 2));
      ctx.record(`${prefix}.wheel.mainBusyPct`, wheelWindow.mainBusyPct);

      // Pan: 2 s at 2× (the container is measured again after the resets).
      await resetZoom(ctx);
      const panPoint = await center(ctx);
      await session.dblclick(panPoint.x, panPoint.y);
      await sleep(1500);
      await session.drain();
      const panStart = await pageNow(ctx);
      await session.beginWindow(`${prefix}-pan`);
      await session.drag({ from: { x: panPoint.x - 120, y: panPoint.y }, to: { x: panPoint.x + 120, y: panPoint.y + 40 }, steps: 120 });
      await sleep(500);
      const panWindow = await session.endWindow();
      const moves = byKind(session.events, 'input').filter(event => event.type === 'mousemove' && event.b && event.t >= panStart);
      const pan = panMetrics(session.events, { start: moves[0]?.t ?? panStart, end: moves.at(-1)?.t ?? panWindow.end, frameTimes: panWindow.frames });
      ctx.record(`${prefix}.pan.transformFramesPerSecond`, pan.transformFramesPerSecond);
      ctx.record(`${prefix}.pan.moveToFrameP50Ms`, pan.moveToFrameP50Ms);
      ctx.record(`${prefix}.pan.moveToFrameP95Ms`, pan.moveToFrameP95Ms);
      ctx.record(`${prefix}.pan.longTaskCount`, pan.longTasks.n);
      ctx.record(`${prefix}.pan.mainBusyPct`, panWindow.mainBusyPct);
      const redraws = byKind(session.events, 'gl.draw').filter(draw => draw.t >= panStart && draw.t <= panWindow.end).length;
      ctx.record(`${prefix}.pan.redraws`, redraws);
      await resetZoom(ctx);
    }
    await recordMemory(ctx, 's4', memoryFrom);
  }
};
