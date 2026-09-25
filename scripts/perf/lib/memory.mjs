// Process memory for scenario M: phys_footprint of the browser's renderer and
// GPU processes, sampled at 4 Hz, plus the kernel's lifetime peak.
//
// macOS: a long-lived python3 helper calls proc_pid_rusage(RUSAGE_INFO_V4)
// through ctypes (no npm dependency) and reads ri_phys_footprint and
// ri_lifetime_max_phys_footprint; `footprint -p` is the slow fallback.
// Linux: /proc/<pid>/smaps_rollup and VmHWM. Windows: private bytes.

import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const run = promisify(execFile);

// rusage_info_v4 as uint64 slots after the 16-byte uuid:
// 0 user_time, 1 system_time, 7 phys_footprint, 28 lifetime_max_phys_footprint.
export const RUSAGE_HELPER = String.raw`
import ctypes, json, sys, time
libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
class Timebase(ctypes.Structure):
    _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]
tb = Timebase()
libc.mach_timebase_info(ctypes.byref(tb))
scale = tb.numer / tb.denom if tb.denom else 1.0
buf = (ctypes.c_uint64 * 64)()
def read(pid):
    if libc.proc_pid_rusage(ctypes.c_int(pid), ctypes.c_int(4), ctypes.byref(buf)) != 0:
        return None
    return [int(buf[2 + 7]), int(buf[2 + 28]), int(buf[2 + 0] * scale), int(buf[2 + 1] * scale)]
for line in sys.stdin:
    pids = [int(p) for p in line.split() if p.isdigit()]
    sys.stdout.write(json.dumps({'t': time.time() * 1000, 'procs': {str(p): read(p) for p in pids}}) + '\n')
    sys.stdout.flush()
`;

/** Parse /proc/<pid>/smaps_rollup into bytes. */
export function parseSmapsRollup(text) {
  const kib = name => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(text || '')?.[1] ?? NaN) * 1024;
  const privateBytes = kib('Private_Clean') + kib('Private_Dirty');
  const swap = kib('SwapPss');
  return {
    rss: kib('Rss'),
    footprint: Number.isFinite(privateBytes) ? privateBytes + (Number.isFinite(swap) ? swap : 0) : null
  };
}

export function parseVmHwm(statusText) {
  const match = /^VmHWM:\s+(\d+) kB/m.exec(statusText || '');
  return match ? Number(match[1]) * 1024 : null;
}

/** `footprint -p PID` fallback: "phys_footprint: 1234 MB" / "Footprint: 1.2 GB". */
export function parseFootprintTool(text) {
  const match = /(?:phys_footprint|Footprint)[^\n\d]*([\d.]+)\s*([KMG]?B)/i.exec(text || '');
  if (!match) return null;
  const unit = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[match[2].toUpperCase()];
  return Math.round(Number(match[1]) * unit);
}

/** `ps -axo pid=,rss=,comm=` → [{ pid, rss, command }] */
export function parsePs(text) {
  return String(text || '').split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? { pid: Number(match[1]), rssKiB: Number(match[2]), command: match[3] } : null;
  }).filter(Boolean);
}

export async function listProcesses() {
  if (process.platform === 'win32') return [];
  try {
    const { stdout } = await run('ps', ['-axo', 'pid=,rss=,comm='], { maxBuffer: 8 * 1024 * 1024 });
    return parsePs(stdout);
  } catch {
    return [];
  }
}

/** WebKit processes (Safari mode, Tauri mode). */
export async function findWebKitProcesses() {
  const all = await listProcesses();
  return {
    webContent: all.filter(p => /com\.apple\.WebKit\.WebContent/.test(p.command)).map(p => p.pid),
    gpu: all.filter(p => /com\.apple\.WebKit\.GPU/.test(p.command)).map(p => p.pid),
    networking: all.filter(p => /com\.apple\.WebKit\.Networking/.test(p.command)).map(p => p.pid)
  };
}

/**
 * Reads { pid: { footprint, lifetimeMax, userNs, systemNs } } for a pid list.
 * start() spawns the helper once; read() is one request/response.
 */
export class FootprintReader {
  constructor({ platform = process.platform } = {}) {
    this.platform = platform;
    this.helper = null;
    this.waiters = [];
  }

  async start() {
    if (this.platform !== 'darwin' || this.helper) return;
    try {
      const child = spawn('python3', ['-u', '-c', RUSAGE_HELPER], { stdio: ['pipe', 'pipe', 'pipe'] });
      child.on('error', () => { this.helper = null; });
      child.stdin.on('error', () => {});
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        const waiter = this.waiters.shift();
        if (!waiter) return;
        try { waiter.resolve(JSON.parse(line)); } catch (error) { waiter.reject(error); }
      });
      child.once('exit', () => {
        this.helper = null;
        for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('footprint helper exited'));
      });
      this.helper = child;
    } catch {
      this.helper = null;
    }
  }

  async read(pids) {
    const list = [...new Set(pids.filter(pid => Number.isInteger(pid) && pid > 0))];
    if (!list.length) return {};
    if (this.platform === 'darwin') return this.#readDarwin(list);
    if (this.platform === 'linux') return this.#readLinux(list);
    if (this.platform === 'win32') return this.#readWindows(list);
    return {};
  }

  async #readDarwin(pids) {
    if (!this.helper) await this.start();
    if (this.helper) {
      const response = await new Promise((resolve, reject) => {
        this.waiters.push({ resolve, reject });
        this.helper.stdin.write(`${pids.join(' ')}\n`);
      }).catch(() => null);
      if (response) {
        const out = {};
        for (const [pid, value] of Object.entries(response.procs || {})) {
          if (value) out[pid] = { footprint: value[0], lifetimeMax: value[1], userNs: value[2], systemNs: value[3] };
        }
        return out;
      }
    }
    const out = {};
    await Promise.all(pids.map(async pid => {
      try {
        const { stdout } = await run('footprint', ['-p', String(pid)], { timeout: 10_000 });
        out[pid] = { footprint: parseFootprintTool(stdout), lifetimeMax: null };
      } catch {}
    }));
    return out;
  }

  async #readLinux(pids) {
    const out = {};
    await Promise.all(pids.map(async pid => {
      try {
        const [rollup, status] = await Promise.all([
          readFile(`/proc/${pid}/smaps_rollup`, 'utf8'), readFile(`/proc/${pid}/status`, 'utf8')
        ]);
        out[pid] = { footprint: parseSmapsRollup(rollup).footprint, lifetimeMax: parseVmHwm(status) };
      } catch {}
    }));
    return out;
  }

  async #readWindows(pids) {
    const out = {};
    try {
      const script = `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,PrivateMemorySize64,PeakWorkingSet64 | ConvertTo-Json`;
      const { stdout } = await run('powershell', ['-NoProfile', '-Command', script], { timeout: 10_000 });
      const parsed = JSON.parse(stdout || '[]');
      for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
        out[entry.Id] = { footprint: entry.PrivateMemorySize64, lifetimeMax: entry.PeakWorkingSet64 };
      }
    } catch {}
    return out;
  }

  stop() {
    if (this.helper) { try { this.helper.kill(); } catch {} }
    this.helper = null;
  }
}

/**
 * 4 Hz sampler over a changing set of processes. `resolvePids()` returns
 * { renderer: [...], gpu: [...], other: [...] }; every sample is passed to
 * `onSample` so the run guards can abort within one sampling period.
 */
export class MemorySampler {
  constructor({ reader, resolvePids, intervalMs = 250, onSample = () => {} }) {
    this.reader = reader;
    this.resolvePids = resolvePids;
    this.intervalMs = intervalMs;
    this.onSample = onSample;
    this.samples = [];
    this.timer = null;
    this.busy = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.tick();
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const groups = await this.resolvePids();
      const pids = [...(groups.renderer || []), ...(groups.gpu || []), ...(groups.other || [])];
      const values = await this.reader.read(pids);
      const pick = list => (list || []).map(pid => ({ pid, ...(values[pid] || {}) })).filter(entry => Number.isFinite(entry.footprint));
      const sample = { t: Date.now(), renderer: pick(groups.renderer), gpu: pick(groups.gpu), other: pick(groups.other) };
      sample.rendererBytes = Math.max(0, ...sample.renderer.map(entry => entry.footprint));
      sample.gpuBytes = sample.gpu.reduce((total, entry) => total + entry.footprint, 0);
      sample.totalBytes = [...sample.renderer, ...sample.gpu, ...sample.other].reduce((total, entry) => total + entry.footprint, 0);
      this.samples.push(sample);
      await this.onSample(sample);
    } catch {
      // A vanished process between listing and reading is normal.
    } finally {
      this.busy = false;
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  mark() {
    return this.samples.length;
  }

  /** Peaks and the final sample over samples[from..]. */
  summary(from = 0) {
    const slice = this.samples.slice(from);
    if (!slice.length) return null;
    const last = slice[slice.length - 1];
    const lifetime = entries => Math.max(0, ...entries.map(entry => entry.lifetimeMax || 0));
    return {
      samples: slice.length,
      rendererPeakMB: toMB(Math.max(...slice.map(sample => sample.rendererBytes))),
      rendererLifetimePeakMB: toMB(lifetime(last.renderer)) || null,
      rendererAfterMB: toMB(last.rendererBytes),
      gpuPeakMB: toMB(Math.max(...slice.map(sample => sample.gpuBytes))),
      gpuLifetimePeakMB: toMB(lifetime(last.gpu)) || null,
      gpuAfterMB: toMB(last.gpuBytes),
      browserTotalPeakMB: toMB(Math.max(...slice.map(sample => sample.totalBytes)))
    };
  }
}

export function toMB(bytes) {
  return Number.isFinite(bytes) ? Math.round(bytes / (1024 * 1024)) : null;
}
