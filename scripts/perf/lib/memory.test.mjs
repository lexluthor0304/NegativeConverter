import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  parseSmapsRollup, parseVmHwm, parseFootprintTool, parsePs, FootprintReader, MemorySampler, toMB
} from './memory.mjs';

const rollup = `55d4c0a00000-7ffd2f5fe000 ---p 00000000 00:00 0                  [rollup]
Rss:              204800 kB
Pss:              150000 kB
Private_Clean:     10240 kB
Private_Dirty:    102400 kB
SwapPss:            2048 kB
`;
assert.deepEqual(parseSmapsRollup(rollup), { rss: 204800 * 1024, footprint: (10240 + 102400 + 2048) * 1024 });
assert.equal(parseVmHwm('Name:\tchrome\nVmHWM:\t  512000 kB\n'), 512000 * 1024);
assert.equal(parseFootprintTool('Google Chrome Helper (Renderer) [123]: 64-bit    Footprint: 1.5 GB (16384 bytes per page)'), Math.round(1.5 * 1024 ** 3));
assert.deepEqual(parsePs('  123  4567 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n 9 10 com.apple.WebKit.WebContent\n'), [
  { pid: 123, rssKiB: 4567, command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  { pid: 9, rssKiB: 10, command: 'com.apple.WebKit.WebContent' }
]);
assert.equal(toMB(1024 * 1024 * 3), 3);

// Sampler summaries over a fake reader.
{
  let footprint = 100;
  const reader = { read: async pids => Object.fromEntries(pids.map(pid => [pid, { footprint: (footprint += 100) * 1024 * 1024, lifetimeMax: 9000 * 1024 * 1024 }])) };
  const sampler = new MemorySampler({ reader, resolvePids: async () => ({ renderer: [1, 2], gpu: [3] }) });
  await sampler.tick();
  await sampler.tick();
  const summary = sampler.summary();
  assert.equal(summary.samples, 2);
  assert.equal(summary.rendererPeakMB, 600, 'renderer is the largest renderer process');
  assert.equal(summary.gpuPeakMB, 700);
  assert.equal(summary.rendererLifetimePeakMB, 9000);
  assert.equal(summary.browserTotalPeakMB, 500 + 600 + 700);
}

// The ctypes helper reads real values on macOS: phys_footprint of this very
// process, a lifetime peak at least as large, and CPU time in nanoseconds.
if (process.platform === 'darwin' && spawnSync('python3', ['--version']).status === 0) {
  const reader = new FootprintReader();
  await reader.start();
  const burn = Date.now() + 150;
  while (Date.now() < burn) { /* spend some CPU */ }
  const values = await reader.read([process.pid]);
  reader.stop();
  const own = values[process.pid];
  assert.ok(own, 'proc_pid_rusage answered for this process');
  assert.ok(own.footprint > 5 * 1024 * 1024 && own.footprint < 4 * 1024 ** 3, `plausible footprint ${own.footprint}`);
  assert.ok(own.lifetimeMax >= own.footprint, 'the lifetime peak is at least the current footprint');
  const cpuNs = (own.userNs + own.systemNs);
  const nodeNs = (process.cpuUsage().user + process.cpuUsage().system) * 1000;
  assert.ok(cpuNs > nodeNs * 0.5 && cpuNs < nodeNs * 2, `CPU time units are nanoseconds (${cpuNs} vs ${nodeNs})`);
}

console.log('memory: parsers, sampler summaries and proc_pid_rusage helper tests passed');
