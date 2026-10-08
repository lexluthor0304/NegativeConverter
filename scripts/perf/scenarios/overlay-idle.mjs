// Read-only reuse: the measure-crop lane owns loading-overlay-idle.mjs.
import { loadingOverlayIdle, loadingOverlayAnimations } from '../../loading-overlay-idle.mjs';
import { bootApp, importPhotos, pageNow } from './common.mjs';
import { runExport } from './s9-export.mjs';

export default {
  id: 'overlay-idle', title: 'Loading overlay idle after export', fixtureGroup: 'interactive',
  steps: [{ action: 'export', format: 'png', bitDepth: 8 }, { action: 'check-idle', overlayExpected: true }],
  async run(ctx) {
    await bootApp(ctx);
    await importPhotos(ctx, [ctx.fixture.path]);
    await ctx.session.evaluate('globalThis.__ncPerf.exports.install(); true');
    const start = await pageNow(ctx);
    await runExport(ctx, 'overlay-idle.export', { format: 'png', bitDepth: 8 }, { buttonId: 'exportSingleBtn', verify: false, probeInputs: false });
    if (!ctx.session.events.some(event => event.k === 'vis' && event.ov && event.t >= start)) throw new Error('no loading overlay was shown during export; idle check has no evidence');
    await ctx.session.waitFor('hidden overlay idle', loadingOverlayIdle(), { timeoutMs: 10_000 });
    const animations = await ctx.session.evaluate(loadingOverlayAnimations);
    ctx.record('overlay-idle.runningAnimations', animations.filter(animation => animation.state === 'running').length);
    ctx.record('overlay-idle.passed', true);
  }
};
