// Machine-safety guards and run conditions. The benchmark drives 60 MP files
// through a browser; on a 16 GB Mac parallel runs have frozen the machine and
// filled the disk with swap, so a run refuses to start under memory pressure
// or low disk, and aborts when the browser crosses a memory ceiling, when swap
// grows by 2 GB or when free disk drops below 20 GB. Parsers are pure and
// unit-tested; the probes shell out to sysctl/pmset on macOS.

import { execFile } from 'node:child_process';
import { statfsSync } from 'node:fs';
import { cpus, loadavg, totalmem } from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const GiB = 1024 ** 3;
export const MIN_FREE_DISK_BYTES = 20 * GiB;
export const MAX_SWAP_GROWTH_BYTES = 2 * GiB;

const UNIT = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

/** `sysctl vm.swapusage`: "vm.swapusage: total = 2048.00M  used = 1034.25M  free = 1013.75M  (encrypted)" */
export function parseSwapUsage(text) {
  const read = name => {
    const match = new RegExp(`${name}\\s*=\\s*([0-9.]+)([BKMGT])`).exec(text || '');
    return match ? Math.round(Number(match[1]) * UNIT[match[2]]) : null;
  };
  return { total: read('total'), used: read('used'), free: read('free') };
}

/** `sysctl kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical. */
export function parsePressureLevel(text) {
  const match = /(-?\d+)\s*$/.exec(String(text || '').trim());
  const level = match ? Number(match[1]) : null;
  const name = level === 1 ? 'normal' : level === 2 ? 'warn' : level === 4 ? 'critical' : 'unknown';
  return { level, name };
}

/** `pmset -g batt`: "Now drawing from 'AC Power'\n -InternalBattery-0 (id=…)	87%; charged; …" */
export function parsePmsetBatt(text) {
  const source = /drawing from '([^']+)'/.exec(text || '')?.[1] || null;
  const percent = /(\d+)%/.exec(text || '')?.[1];
  return { source, percent: percent === undefined ? null : Number(percent), onBattery: source ? /battery/i.test(source) : null };
}

/** `pmset -g therm`: records warning levels and the CPU speed limit when present. */
export function parsePmsetTherm(text) {
  const out = {};
  const speed = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(text || '');
  if (speed) out.cpuSpeedLimit = Number(speed[1]);
  const level = (name) => {
    if (new RegExp(`No ${name} warning level has been recorded`, 'i').test(text || '')) return 0;
    const match = new RegExp(`${name} warning level\\s*[:=]?\\s*(\\d+)`, 'i').exec(text || '');
    return match ? Number(match[1]) : null;
  };
  out.thermalWarningLevel = level('thermal');
  out.performanceWarningLevel = level('performance');
  out.raw = String(text || '').trim().slice(0, 400);
  return out;
}

export function freeDiskBytes(path) {
  try {
    const stats = statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

async function tryRun(cmd, args) {
  try {
    const { stdout } = await run(cmd, args, { timeout: 5000 });
    return stdout;
  } catch {
    return null;
  }
}

export async function readSwapUsage(platform = process.platform) {
  if (platform === 'darwin') return parseSwapUsage(await tryRun('sysctl', ['vm.swapusage']));
  if (platform === 'linux') {
    const text = await tryRun('cat', ['/proc/meminfo']);
    const kib = name => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(text || '')?.[1]) * 1024 || null;
    const total = kib('SwapTotal'), free = kib('SwapFree');
    return { total, free, used: total !== null && free !== null ? total - free : null };
  }
  return { total: null, used: null, free: null };
}

export async function readPressureLevel(platform = process.platform) {
  if (platform !== 'darwin') return { level: null, name: 'unknown' };
  return parsePressureLevel(await tryRun('sysctl', ['kern.memorystatus_vm_pressure_level']));
}

export async function readPowerConditions(platform = process.platform) {
  if (platform !== 'darwin') return { battery: null, thermal: null };
  const [batt, therm] = await Promise.all([tryRun('pmset', ['-g', 'batt']), tryRun('pmset', ['-g', 'therm'])]);
  return { battery: batt ? parsePmsetBatt(batt) : null, thermal: therm ? parsePmsetTherm(therm) : null };
}

/** NC_PERF_MEM_CEILING_GB, or 60 % of RAM (9.6 GB on a 16 GB machine). */
export function memoryCeilingBytes(env = process.env, total = totalmem()) {
  const gb = Number(env.NC_PERF_MEM_CEILING_GB);
  if (Number.isFinite(gb) && gb > 0) return gb * GiB;
  return Math.round(total * 0.6);
}

/**
 * Pre-flight: refuse to start (unless forced) under memory pressure or with
 * less than 20 GB of free disk. Returns { ok, problems }.
 */
export function evaluatePreflight({ pressure, freeDisk, minFreeDisk = MIN_FREE_DISK_BYTES }) {
  const problems = [];
  if (pressure && pressure.name !== 'normal' && pressure.name !== 'unknown') {
    problems.push(`memory pressure is ${pressure.name} (kern.memorystatus_vm_pressure_level=${pressure.level})`);
  }
  if (Number.isFinite(freeDisk) && freeDisk < minFreeDisk) {
    problems.push(`free disk ${(freeDisk / GiB).toFixed(1)} GB is below ${(minFreeDisk / GiB).toFixed(0)} GB`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * During a scenario: abort when the browser's summed phys_footprint crosses
 * the ceiling, swap grew by more than 2 GB, or free disk fell below 20 GB.
 * Returns null or { reason, detail }.
 */
export function evaluateRunGuards({ browserBytes, ceilingBytes, swapUsed, swapUsedAtStart, freeDisk,
  maxSwapGrowth = MAX_SWAP_GROWTH_BYTES, minFreeDisk = MIN_FREE_DISK_BYTES }) {
  if (Number.isFinite(browserBytes) && Number.isFinite(ceilingBytes) && browserBytes > ceilingBytes) {
    return { reason: 'memory-ceiling', detail: `browser footprint ${(browserBytes / GiB).toFixed(2)} GB > ceiling ${(ceilingBytes / GiB).toFixed(2)} GB` };
  }
  if (Number.isFinite(swapUsed) && Number.isFinite(swapUsedAtStart) && swapUsed - swapUsedAtStart > maxSwapGrowth) {
    return { reason: 'memory-ceiling', detail: `swap grew by ${((swapUsed - swapUsedAtStart) / GiB).toFixed(2)} GB` };
  }
  if (Number.isFinite(freeDisk) && freeDisk < minFreeDisk) {
    return { reason: 'memory-ceiling', detail: `free disk fell to ${(freeDisk / GiB).toFixed(1)} GB` };
  }
  return null;
}

/**
 * Load guard: wait up to `timeoutMs` for the 1-minute load average to fall
 * below cores ÷ 2; otherwise the run is labelled noisy (never refused).
 */
export async function waitForQuietMachine({
  cores = cpus().length,
  readLoad = () => loadavg()[0],
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(),
  timeoutMs = 120_000,
  pollMs = 5000,
  log = () => {}
} = {}) {
  const limit = cores / 2;
  const started = now();
  let load = readLoad();
  while (load >= limit && now() - started < timeoutMs) {
    log(`load average ${load.toFixed(2)} >= ${limit}; waiting for the machine to settle`);
    await sleep(pollMs);
    load = readLoad();
  }
  return { noisy: load >= limit, load, limit, waitedMs: now() - started };
}
