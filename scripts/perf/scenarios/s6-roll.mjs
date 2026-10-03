// S6 roll import: import N files (default 12; 116 only with --roll-size 116).
// S1 metrics for the first photo; the time until every photo has its
// settings badge and a thumbnail; LibRaw decodes; cores used (Σ process CPU
// ÷ wall, and Σ thread busy ÷ wall from the profiled trace); Brightness and
// Cyan drags while the background work runs and after it.
import { byKind } from '../lib/metrics.mjs';
import { bootApp, recordRollRoutes, importPhotos, recordImportMetrics, recordMemory, recordRoute, dragSlider, sleep, round } from './common.mjs';

export const BACKGROUND_TIMEOUT_MS = 60 * 60 * 1000;

/** Page-time of the first poll where `expression` holds; drains while waiting. */
export async function waitForPageTime(ctx, description, expression, { timeoutMs = BACKGROUND_TIMEOUT_MS, pollMs = 250 } = {}) {
  const { session } = ctx;
  const started = Date.now();
  let lastDrain = started;
  while (Date.now() - started < timeoutMs) {
    session.check();
    const hit = await session.evaluate(`(${expression}) ? performance.now() : null`);
    if (hit !== null) return hit;
    if (Date.now() - lastDrain > 5000) { await session.drain(); lastDrain = Date.now(); }
    await sleep(pollMs);
  }
  ctx.note(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${description}`);
  return null;
}

export async function importRoll(ctx, { settle = false } = {}) {
  const { session } = ctx;
  await session.installDialogAutoAccept();
  const paths = ctx.roll.map(entry => entry.path);
  const cpuBefore = await session.cpuTimes();
  const wallBefore = Date.now();
  const metrics = await importPhotos(ctx, paths, { settle, window: 'roll-import' });
  return { metrics, cpuBefore, wallBefore, count: paths.length };
}

export async function waitForRollBackground(ctx, count) {
  const settingsT = await waitForPageTime(ctx, 'settings badges on every photo', `document.querySelectorAll('.file-list-settings-badge').length >= ${count}`);
  const thumbnailsT = await waitForPageTime(ctx, 'a thumbnail on every photo', `document.querySelectorAll('img.file-list-thumbnail').length >= ${count}`);
  return { settingsT, thumbnailsT };
}

export default {
  id: 's6',
  title: 'Roll import',
  fixtureGroup: 'roll',
  async run(ctx) {
    const { session } = ctx;
    await bootApp(ctx);
    const memoryFrom = session.memoryMark();
    const { metrics, cpuBefore, wallBefore, count } = await importRoll(ctx);
    recordImportMetrics(ctx, 's6', metrics);
    await recordRoute(ctx, 's6.photo0', ctx.roll[0].name);
    const backgroundRunning = await session.evaluate(`document.querySelectorAll('.file-list-settings-badge').length < ${count}`);
    if (backgroundRunning) {
      await dragSlider(ctx, 'coreExposure', 's6.dragDuring.coreExposure');
      await dragSlider(ctx, 'cyan', 's6.dragDuring.cyan');
    } else {
      ctx.note('s6: background work finished before the drags could run');
    }
    const { settingsT, thumbnailsT } = await waitForRollBackground(ctx, count);
    const cpuAfter = await session.cpuTimes();
    const wallS = (Date.now() - wallBefore) / 1000;
    ctx.record('s6.roll.settingsAllMs', settingsT === null ? null : round(settingsT - metrics.changeT));
    ctx.record('s6.roll.thumbnailsAllMs', thumbnailsT === null ? null : round(thumbnailsT - metrics.changeT));
    // Σ process CPU ÷ wall; the profiled repetition adds Σ thread busy ÷ wall from its trace.
    ctx.record('s6.roll.coresUsed', wallS > 0 ? round((cpuAfter - cpuBefore) / wallS, 2) : null);
    await session.drain();
    ctx.record('s6.roll.librawDecodes', byKind(session.events, 'req').filter(req => req.cls === 'libraw' && req.fn === 'open').length);
    ctx.record('s6.roll.librawWorkers', new Set(byKind(session.events, 'req').filter(req => req.cls === 'libraw').map(req => req.wid)).size);
    ctx.record('s6.roll.thumbnailReencodes', byKind(session.events, 'enc').length);
    // When each tile got its first thumbnail (the per-tile table of the roll report).
    const firstThumb = {};
    for (const event of byKind(session.events, 'mut')) {
      if (event.what === 'thumb' && event.idx !== null && firstThumb[event.idx] === undefined) firstThumb[event.idx] = round(event.t - metrics.changeT);
    }
    ctx.raw['s6.firstThumbnailMsByTile'] = firstThumb;
    await sleep(3000);
    await dragSlider(ctx, 'coreExposure', 's6.dragAfter.coreExposure');
    await dragSlider(ctx, 'cyan', 's6.dragAfter.cyan');
    await recordMemory(ctx, 's6', memoryFrom);
    await recordRollRoutes(ctx);
  }
};
