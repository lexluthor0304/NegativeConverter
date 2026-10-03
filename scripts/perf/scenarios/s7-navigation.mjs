// S7 navigation: Arrow + Enter on the film strip. Classes: cold unanalysed
// (during the roll analysis), warm 1-back, cold analysed, 2-back and five
// presses within 0.8 s. Times are from the Enter keydown: first pixels of
// the target, first display-resolution positive, ready; LibRaw decodes
// started, stale results after the target is shown, long tasks (keypress
// until ready) and main busy %.
import { byKind, switchMetrics } from '../lib/metrics.mjs';
import { median } from '../lib/stats.mjs';
import { bootApp, recordRollRoutes, recordMemory, recordRoute, sleep, pageNow, round } from './common.mjs';
import { importRoll, waitForRollBackground } from './s6-roll.mjs';

const QUICK_PLAN = [
  { to: 1, cls: 'coldUnanalysed' },
  { to: 0, cls: 'warm1Back' },
  { waitForAnalysis: true },
  { to: 2, cls: 'coldAnalysed' },
  { to: 0, cls: 'warm1Back' }
];
const FULL_PLAN = [
  ...QUICK_PLAN,
  { to: 3, cls: 'coldAnalysed' },
  { to: 2, cls: 'twoBack' },
  { to: 3, cls: 'warm1Back' },
  { rapid: 5, cls: 'rapid5' }
];

async function focusTile(ctx, index) {
  return ctx.session.evaluate(`(() => {
    const button = document.querySelector('.file-list-name[data-index="${index}"]');
    if (!button) return false;
    button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    button.focus({ preventScroll: true });
    return document.activeElement === button;
  })()`);
}

async function displayOrder(ctx) {
  return ctx.session.evaluate(`[...document.querySelectorAll('.file-list-name')].map(button => Number(button.dataset.index))`);
}

/**
 * Switch with Arrow + Enter: focus the tile next to the target in display
 * order, press the arrow that lands on it, then Enter. Returns the Enter
 * keydown's page time.
 */
async function arrowEnter(ctx, targetIndex) {
  const order = await displayOrder(ctx);
  const position = order.indexOf(targetIndex);
  const fromPosition = position > 0 ? position - 1 : position + 1;
  const key = position > 0 ? 'ArrowRight' : 'ArrowLeft';
  await focusTile(ctx, order[fromPosition]);
  const before = await pageNow(ctx);
  await ctx.session.key(key);
  await ctx.session.key('Enter');
  await ctx.session.drain();
  return byKind(ctx.session.events, 'input').find(event => event.type === 'keydown' && event.key === 'Enter' && event.t >= before)?.t ?? before;
}

async function measureSwitch(ctx, keyTimes, target, displaySize) {
  const { session } = ctx;
  const keyT = keyTimes.at(-1);
  await session.waitFor('switch ready', `document.body.classList.contains('studio-ready') && !document.body.dataset.studioBusy && document.getElementById('studioFilename')?.textContent === ${JSON.stringify(target)}`, { timeoutMs: 600_000 });
  await sleep(1500);
  const window = await session.endWindow();
  const metrics = switchMetrics(session.events, { keyT, target, displaySize, until: window.end, previousKeyTimes: keyTimes.slice(0, -1) });
  metrics.mainBusyPct = window.mainBusyPct;
  metrics.fromFirstPressMs = keyTimes.length > 1 && metrics.firstPixelsMs !== null ? round(metrics.firstPixelsMs + (keyT - keyTimes[0])) : null;
  return metrics;
}

export default {
  id: 's7',
  title: 'Photo navigation',
  fixtureGroup: 'roll',
  async run(ctx) {
    const { session } = ctx;
    await bootApp(ctx);
    const memoryFrom = session.memoryMark();
    const { count } = await importRoll(ctx);
    await recordRoute(ctx, 's7.photo0', ctx.roll[0].name);
    const plan = ctx.args.quick ? QUICK_PLAN : FULL_PLAN;
    const samples = {};
    let current = 0;
    for (const step of plan) {
      if (step.waitForAnalysis) {
        await waitForRollBackground(ctx, count);
        await sleep(2000);
        continue;
      }
      const snapshot = await session.evaluate('globalThis.__ncPerf.snapshot()');
      const displaySize = snapshot.glCanvas ? { w: snapshot.glCanvas.width, h: snapshot.glCanvas.height } : null;
      await session.drain();
      await session.beginWindow(`s7-${step.cls}`);
      let keyTimes;
      let target;
      if (step.rapid) {
        if (current + step.rapid >= count) { ctx.note(`s7: roll too short for ${step.rapid} rapid presses`); await session.endWindow(); continue; }
        keyTimes = [];
        let index = current;
        for (let press = 0; press < step.rapid; press++) {
          index += 1;
          const started = Date.now();
          keyTimes.push(await arrowEnter(ctx, index));
          await sleep(Math.max(0, 160 - (Date.now() - started)));
        }
        target = ctx.roll[index].name;
        current = index;
      } else {
        target = ctx.roll[step.to].name;
        keyTimes = [await arrowEnter(ctx, step.to)];
        current = step.to;
      }
      const metrics = await measureSwitch(ctx, keyTimes, target, displaySize);
      (samples[step.cls] ||= []).push(metrics);
      ctx.raw[`s7.${step.cls}.${(samples[step.cls].length)}`] = metrics;
      // Update after each completed step: a later abort preserves earlier classes.
      for (const [cls, list] of Object.entries(samples)) {
        for (const key of ['firstPixelsMs', 'firstDisplayPositiveMs', 'readyMs', 'librawDecodes', 'staleResultsAfterShown', 'mainBusyPct', 'fromFirstPressMs']) {
          const values = list.map(entry => entry[key]).filter(Number.isFinite);
          if (values.length) ctx.record(`s7.${cls}.${key}`, round(median(values)));
        }
        ctx.record(`s7.${cls}.longTaskCount`, round(median(list.map(entry => entry.longTasks.n))));
        ctx.record(`s7.${cls}.maxLongTaskMs`, round(median(list.map(entry => entry.longTasks.maxMs))));
        ctx.record(`s7.${cls}.samples`, list.length);
      }
      await recordRoute(ctx, `s7.photo${current}`, target, { from: keyTimes.at(-1) });
    }
    await recordMemory(ctx, 's7', memoryFrom);
    await recordRollRoutes(ctx);
  }
};
