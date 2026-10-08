// H hang repro: on _DSC3111.NEF (NC_PERF_RAW_DIR) or, when it is absent, the
// synthetic 24 MP DNG (labelled): 50 DPR 1 curve drags and 50 CPU-path cyan
// drags, half of each with the CPU profiler on (one audit stall happened in
// a profiled run). A continuous trace ring buffer records throughout, so a
// stall dump carries the last seconds of every thread. After a stall the
// browser is relaunched and the remaining drags continue.
import { bootApp, importPhotos, setWebGl, sleep } from './common.mjs';
import { dragCurve } from './s3-curve.mjs';

export const H_DRAGS = 50;

async function prepare(ctx, cpu) {
  const { session } = ctx;
  await session.setDpr(1);
  await bootApp(ctx);
  await importPhotos(ctx, [ctx.fixture.path], { settle: false });
  if (cpu) await setWebGl(ctx, false);
}

async function dragCyan(ctx, prefix) {
  const { session } = ctx;
  const rect = await session.reveal('cyan');
  const y = rect.y + rect.height / 2;
  const x = rect.x + rect.width * 0.3;
  await session.drag({ from: { x, y }, to: { x: x + rect.width * 0.4, y }, steps: 90 });
  await sleep(300);
  await session.drag({ from: { x: x + rect.width * 0.4, y }, to: { x, y }, steps: 90 });
  await sleep(700);
  ctx.bump(`${prefix}.done`);
}

export default {
  id: 'h',
  title: 'Hang repro',
  fixtureGroup: 'hang',
  continuousTrace: true,
  singleRep: true,
  async run(ctx) {
    let stalls = 0;
    let drags = 0;
    for (const phase of [{ name: 'curve', cpu: false }, { name: 'cpuCyan', cpu: true }]) {
      let prepared = false;
      for (let i = 0; i < H_DRAGS; i++) {
        const profiled = i % 2 === 1;
        try {
          if (!prepared) { await prepare(ctx, phase.cpu); prepared = true; }
          if (profiled) { await ctx.session.page.send('Profiler.enable'); await ctx.session.page.send('Profiler.start'); }
          if (phase.name === 'curve') await dragCurve(ctx, `h.curve.${i}`, { observeMs: 800, steps: 60 });
          else await dragCyan(ctx, 'h.cpuCyan');
          if (profiled) await ctx.session.page.send('Profiler.stop', {}, { timeoutMs: 120_000 }).catch(() => {});
          drags++;
          ctx.session.events.length = 0;
        } catch (error) {
          if (ctx.session.status === 'hang' || ctx.session.status === 'crashed') {
            stalls++;
            ctx.note(`h: ${ctx.session.status} in ${phase.name} drag ${i}${profiled ? ' (profiled)' : ''}: ${ctx.session.abortReason}${ctx.session.hangDump?.file ? ` — dump ${ctx.session.hangDump.file}` : ''}`);
            ctx.hangs.push({ label: `h-${phase.name}-${i}`, info: { silentMs: ctx.session.hangDump?.info?.silentMs }, file: ctx.session.hangDump?.file, topFrame: ctx.session.hangDump?.stacks?.find(stack => stack.kind === 'page')?.frames?.[0]?.function });
            await ctx.restartSession();
            prepared = false;
          } else {
            throw error;
          }
        }
      }
    }
    ctx.record('h.stalls', stalls);
    ctx.record('h.drags', drags);
    ctx.record('h.fixture', ctx.fixture.label || ctx.fixture.name);
  }
};
