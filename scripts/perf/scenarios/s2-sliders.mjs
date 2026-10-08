// S2 sliders: 3 s trusted drags (180 moves at 60 Hz over 40 % of the track)
// of the SilverCore sliders (worker conversion per frame) and the Step-3
// sliders (WebGL uniforms), at DPR 1 and 2; then the CPU display path
// (#coreUseWebGL off) at DPR 2.
import { bootApp, importPhotos, recordMemory, recordRoute, dragSlider, setWebGl, sleep } from './common.mjs';

export const S2_SLIDERS = ['coreExposure', 'coreContrast', 'coreTemperature', 'wbR', 'cyan'];
export const S2_CPU_SLIDERS = ['coreExposure', 'cyan'];

export default {
  id: 's2',
  title: 'Slider drags',
  fixtureGroup: 'interactive',
  debugCounters: true,
  async run(ctx) {
    const { session } = ctx;
    await bootApp(ctx);
    const memoryFrom = session.memoryMark();
    await importPhotos(ctx, [ctx.fixture.path]);
    await recordRoute(ctx, 's2.photo0', ctx.fixture.name);
    for (const dpr of ctx.dprs) {
      await session.setDpr(dpr);
      await sleep(3200); // the display preview is rebuilt for the new backing size
      await session.waitForReady({ timeoutMs: 120_000 });
      for (const slider of S2_SLIDERS) {
        await dragSlider(ctx, slider, `s2.${slider}.dpr${dpr}`);
      }
    }
    if (ctx.dprs.includes(2) && !ctx.args.quick) {
      await session.setDpr(2);
      await sleep(3200);
      await setWebGl(ctx, false);
      for (const slider of S2_CPU_SLIDERS) {
        await dragSlider(ctx, slider, `s2.${slider}.cpu.dpr2`, { cpu: true });
      }
      await setWebGl(ctx, true);
    }
    await recordMemory(ctx, 's2', memoryFrom);
  }
};
