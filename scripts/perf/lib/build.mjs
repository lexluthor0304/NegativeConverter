// Build a ref with source maps into a temp dir and serve it with `vite
// preview` through the harness-only config (scripts/perf/vite.preview.config.js),
// which adds the /__perf routes. The shipped bundle is unchanged.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function viteBin(worktree) {
  return join(worktree, 'node_modules', 'vite', 'bin', 'vite.js');
}

function collect(child) {
  let output = '';
  const add = chunk => { output = (output + chunk).slice(-20_000); };
  child.stdout?.on('data', add);
  child.stderr?.on('data', add);
  return () => output;
}

export function buildArgs({ outDir }) {
  return ['build', '--config', 'negative2positive/vite.config.js', '--sourcemap', '--outDir', outDir, '--emptyOutDir'];
}

export function previewArgs({ harnessConfig, outDir, port }) {
  // The native loader imports the config without bundling it next to itself,
  // so no temporary file appears in the invoking checkout.
  return ['preview', '--configLoader', 'native', '--config', harnessConfig, '--outDir', outDir, '--port', String(port), '--strictPort', '--host', '127.0.0.1'];
}

export async function buildRef({ worktree, outDir, log = () => {} }) {
  const started = Date.now();
  const child = spawn(process.execPath, [viteBin(worktree), ...buildArgs({ outDir })], {
    cwd: worktree,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production' }
  });
  const output = collect(child);
  const code = await new Promise(resolve => child.once('exit', resolve));
  if (code !== 0) throw new Error(`vite build failed (${code}):\n${output().slice(-4000)}`);
  if (!existsSync(join(outDir, 'index.html'))) throw new Error(`vite build produced no ${join(outDir, 'index.html')}`);
  log(`built ${worktree} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return { ms: Date.now() - started };
}

export async function startPreview({ worktree, outDir, port, harnessConfig, env = {}, log = () => {} }) {
  const child = spawn(process.execPath, [viteBin(worktree), ...previewArgs({ harnessConfig, outDir, port })], {
    cwd: worktree,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      NC_PERF_APP_CONFIG: join(worktree, 'negative2positive', 'vite.config.js'),
      NC_PERF_DIST: outDir,
      ...env
    }
  });
  const output = collect(child);
  let exited = null;
  child.once('exit', code => { exited = code; });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 120 && exited === null; i++) {
    try {
      const response = await fetch(`${url}__perf/health`);
      if (response.ok) break;
    } catch {}
    await sleep(250);
  }
  const stop = async () => {
    if (exited !== null) return;
    try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); } catch { try { child.kill(); } catch {} }
    for (let i = 0; i < 40 && exited === null; i++) await sleep(50);
    if (exited === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  };
  try {
    const health = await (await fetch(`${url}__perf/health`)).json();
    if (!health.ok) throw new Error('unhealthy');
  } catch {
    await stop();
    throw new Error(`vite preview did not start on port ${port}:\n${output().slice(-4000)}`);
  }
  log(`serving ${outDir} at ${url}`);
  return { url, origin: url.replace(/\/$/, ''), process: child, stop, output };
}

/** Requests that only a dev server would see (the run must be production). */
export async function suspiciousRequests(origin) {
  try {
    const response = await fetch(`${origin}/__perf/requests`);
    return (await response.json()).suspicious || [];
  } catch {
    return [];
  }
}
