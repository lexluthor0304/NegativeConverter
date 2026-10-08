// S8 light table: open it (click → first frames), wheel-scroll for 2 s at
// normal and fast speed (fps, frames > 25 ms), the time until every tile is
// final (data-preview-state="ready"), thumbnail px ÷ drawn device px, active
// tile re-encodes per Cyan drag, and "Sync colours" to all photos until every
// tile is final again.
import { byKind, rafGapSummary } from '../lib/metrics.mjs';
import { median } from '../lib/stats.mjs';
import { bootApp, recordRollRoutes, recordMemory, dragSlider, sleep, pageNow, clickElement, longTasks, round } from './common.mjs';
import { importRoll, waitForRollBackground, waitForPageTime } from './s6-roll.mjs';

const ALL_FINAL = `(() => { const tiles = document.querySelectorAll('.file-list-name'); return tiles.length > 0 && [...tiles].every(tile => tile.dataset.previewState === 'ready'); })()`;

async function scroll(ctx, prefix, deltaY) {
  const { session } = ctx;
  const rect = await session.rect('#fileListItems');
  await session.drain();
  const start = await session.beginWindow(prefix);
  await session.wheel(rect.x + rect.width / 2, rect.y + Math.min(rect.height / 2, 150), deltaY, { count: 120 });
  await sleep(300);
  const window = await session.endWindow();
  const frames = rafGapSummary(window.frames);
  ctx.record(`${prefix}.fps`, frames.fps);
  ctx.record(`${prefix}.framesOver25`, frames.over25);
  ctx.record(`${prefix}.maxFrameGapMs`, frames.maxGapMs);
  ctx.record(`${prefix}.longTaskCount`, longTasks(ctx, start, window.end).n);
  ctx.record(`${prefix}.mainBusyPct`, window.mainBusyPct);
  await session.evaluate(`document.getElementById('fileListItems').scrollTop = 0; true`);
}

export default {
  id: 's8',
  title: 'Light table',
  fixtureGroup: 'roll',
  async run(ctx) {
    const { session } = ctx;
    await bootApp(ctx);
    const memoryFrom = session.memoryMark();
    const { count, metrics } = await importRoll(ctx);
    await waitForRollBackground(ctx, count);
    await sleep(2000);

    // Open: click → first three frames.
    await session.drain();
    const openStart = await session.beginWindow('s8-open');
    const clickT = await clickElement(ctx, 'studioToggleLightTable');
    await sleep(1500);
    const openWindow = await session.endWindow();
    const frames = openWindow.frames.filter(frame => frame >= clickT).slice(0, 3).map(frame => round(frame - clickT));
    ctx.record('s8.open.firstFrameMs', frames[0] ?? null);
    ctx.record('s8.open.thirdFrameMs', frames[2] ?? null);
    ctx.record('s8.open.longTaskCount', longTasks(ctx, openStart, openWindow.end).n);
    // Event Timing reports only events of 16 ms or more; absent means faster.
    const clickEntry = byKind(session.events, 'et').find(entry => entry.n === 'click' && entry.s >= clickT - 50);
    if (clickEntry) ctx.record('s8.open.clickHandlerMs', round(clickEntry.pe - clickEntry.ps));
    ctx.raw['s8.grid'] = await session.evaluate(`(() => {
      const items = document.getElementById('fileListItems');
      const tile = items.querySelector('.file-list-item');
      const r = tile ? tile.getBoundingClientRect() : null;
      return { columns: getComputedStyle(items).gridTemplateColumns.split(' ').filter(Boolean).length, tile: r && [Math.round(r.width), Math.round(r.height)],
        scrollHeight: items.scrollHeight, clientHeight: items.clientHeight };
    })()`);
    const finalT = await waitForPageTime(ctx, 'every tile final', ALL_FINAL);
    ctx.record('s8.allTilesFinalMs', finalT === null ? null : round(Math.max(0, finalT - clickT)));
    ctx.record('s8.allTilesFinalSinceImportMs', finalT === null ? null : round(finalT - metrics.changeT));

    await scroll(ctx, 's8.scrollNormal', 60);
    await scroll(ctx, 's8.scrollFast', 240);

    const scale = await session.evaluate(`(() => {
      const ratios = [...document.querySelectorAll('img.file-list-thumbnail')].map(img => {
        const rect = img.getBoundingClientRect();
        return rect.width ? img.naturalWidth / (rect.width * devicePixelRatio) : null;
      }).filter(Number.isFinite);
      ratios.sort((a, b) => a - b);
      return ratios.length ? ratios[ratios.length >> 1] : null;
    })()`);
    ctx.record('s8.thumbnailScale', scale === null ? null : round(scale, 2));

    // Active tile re-encodes during a Cyan drag with the light table open.
    const active = await session.evaluate(`document.querySelector('.file-list-name[aria-current="true"]')?.dataset.index ?? null`);
    const dragStart = await pageNow(ctx);
    await dragSlider(ctx, 'cyan', 's8.cyanDrag', { observeMs: 1000 });
    const reencodes = byKind(session.events, 'mut').filter(event => event.what === 'thumb' && event.t >= dragStart && String(event.idx) === String(active)).length;
    ctx.record('s8.activeTileReencodesPerDrag', reencodes);

    // Sync colours to every photo, until every tile is final again.
    await session.evaluate(`(() => { document.querySelectorAll('.file-list-checkbox').forEach(box => { if (!box.checked) box.click(); }); return true; })()`);
    await sleep(500);
    const syncT = await clickElement(ctx, 'studioSync');
    await sleep(1000);
    const syncFinal = await waitForPageTime(ctx, 'every tile final after sync', ALL_FINAL);
    ctx.record('s8.syncColours.allFinalMs', syncFinal === null ? null : round(syncFinal - syncT));
    ctx.record('s8.syncColours.longTaskCount', longTasks(ctx, syncT, syncFinal ?? await pageNow(ctx)).n);
    const tasks = byKind(session.events, 'lt').filter(task => task.s >= syncT).map(task => task.d);
    ctx.record('s8.syncColours.longTaskTotalMs', round(tasks.reduce((a, b) => a + b, 0)));
    ctx.record('s8.syncColours.maxLongTaskMs', tasks.length ? round(Math.max(...tasks)) : 0);
    ctx.record('s8.syncColours.librawDecodes', byKind(session.events, 'req').filter(req => req.cls === 'libraw' && req.fn === 'open' && req.t >= syncT).length);
    ctx.raw['s8.medianThumbnailScale'] = median([scale]);
    await recordMemory(ctx, 's8', memoryFrom);
    await recordRollRoutes(ctx);
  }
};
