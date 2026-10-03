import { bootApp, importPhotos, clickElement, sleep, uiCounters } from './common.mjs';

export const LOUPE_STEPS = [{ action: 'open-fake-camera' }, { action: 'measure', durationMs: 5000 }, { action: 'close' }];

export default {
  id: 'loupe', title: 'Live loupe with fake camera', fixtureGroup: 'interactive', fakeCamera: true, debugCounters: true, steps: LOUPE_STEPS,
  async run(ctx) {
    const { session } = ctx;
    await bootApp(ctx);
    await importPhotos(ctx, [ctx.fixture.path]);
    await clickElement(ctx, 'studioLoupe');
    try {
      await session.waitFor('loupe converting fake frames', `Number(document.getElementById('loupeOverlay').dataset.frames) >= 5`, { timeoutMs: 30_000 });
      const before = await uiCounters(ctx);
      await session.beginWindow('loupe.busy');
      await sleep(LOUPE_STEPS[1].durationMs);
      const window = await session.endWindow();
      const after = await uiCounters(ctx);
      if (!before?.loupe || !after?.loupe) throw new Error('loupe counters unavailable');
      const conversions = after.loupe.conversions - before.loupe.conversions;
      if (conversions < 1) throw new Error('fake camera produced no conversions in the window');
      ctx.record('loupe.mainBusyPct', window.mainBusyPct);
      ctx.record('loupe.conversions', conversions);
      ctx.record('loupe.grabs', after.loupe.grabs - before.loupe.grabs);
      ctx.record('loupe.defaults', after.loupe.defaults - before.loupe.defaults);
      ctx.record('loupe.repeated', after.loupe.repeated - before.loupe.repeated);
      ctx.record('loupe.inputMode', 'Chrome fake camera');
    } finally {
      await clickElement(ctx, 'loupeCloseBtn');
      await session.waitFor('loupe camera released', `document.getElementById('loupeVideo').srcObject === null`, { timeoutMs: 10_000 });
    }
  }
};
