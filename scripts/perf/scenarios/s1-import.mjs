// S1 import: boot (until the Studio is interactive), then import one file.
// Times are from the file input `change` event: first pixels drawn (under the
// overlay), first photo visible, first positive visible (an upload whose
// hash equals a conversion result), ready, settled (no worker traffic for
// 2.5 s); plus the stage timeline, long tasks and memory.
import { bootApp, importPhotos, recordImportMetrics, recordMemory, recordRoute, round } from './common.mjs';

export default {
  id: 's1',
  title: 'Import',
  fixtureGroup: 'singles',
  async run(ctx) {
    const { session } = ctx;
    const bootMs = await bootApp(ctx);
    ctx.record('s1.bootMs', round(bootMs));
    const snapshot = await session.evaluate('globalThis.__ncPerf ? globalThis.__ncPerf.snapshot() : null');
    if (snapshot) {
      ctx.record('s1.bootTransferKB', Math.round(snapshot.transferBytes / 1024));
      ctx.record('s1.bootDecodedKB', Math.round(snapshot.decodedBytes / 1024));
    }
    await session.drain();
    session.events.length = 0;
    const memoryFrom = session.memoryMark();
    const metrics = await importPhotos(ctx, [ctx.fixture.path], { window: 's1-import' });
    recordImportMetrics(ctx, 's1', metrics);
    await recordRoute(ctx, 's1.photo0', ctx.fixture.name);
    await recordMemory(ctx, 's1', memoryFrom);
  }
};
