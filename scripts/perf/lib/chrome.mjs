// Chrome for the benchmark: a throwaway profile per scenario group, its own
// CDP port, headless=new by default. The process runs in its own process
// group so the memory ceiling and the hang watchdog can SIGKILL the browser
// and every child (renderer, GPU, utility) at once.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerProcess, killProcess } from './resources.mjs';

export const WINDOW = Object.freeze({ width: 1440, height: 900 });

export function findChrome(env = process.env, platform = process.platform) {
  const candidates = [
    env.CHROME_BIN,
    platform === 'darwin' && '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    platform === 'darwin' && '/Applications/Chromium.app/Contents/MacOS/Chromium',
    platform === 'linux' && '/usr/bin/google-chrome',
    platform === 'linux' && '/usr/bin/google-chrome-stable',
    platform === 'linux' && '/usr/bin/chromium',
    platform === 'linux' && '/usr/bin/chromium-browser',
    platform === 'win32' && join(env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    platform === 'win32' && join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe')
  ].filter(Boolean);
  return candidates.find(path => existsSync(path)) || null;
}

export function chromeArgs({ port, profileDir, headful = false, window = WINDOW, fakeCamera = false }) {
  return [
    ...(headful ? [] : ['--headless=new']),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    `--window-size=${window.width},${window.height}`,
    // A background tab must not be throttled while it is being measured.
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-extensions',
    '--disable-component-update',
    '--disable-features=Translate,MediaRouter,OptimizationHints',
    ...(fakeCamera ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] : []),
    'about:blank'
  ];
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function launchChrome({ bin, port, headful = false, log = () => {}, fakeCamera = false }) {
  const profileDir = mkdtempSync(join(tmpdir(), 'nc-perf-chrome-'));
  const child = spawn(bin, chromeArgs({ port, profileDir, headful, fakeCamera }), {
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: process.platform !== 'win32'
  });
  const unregister = registerProcess(child);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
  let exited = null;
  child.once('exit', (code, signal) => { exited = { code, signal }; });

  let version = null;
  for (let i = 0; i < 120 && !exited; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) { version = await response.json(); break; }
    } catch {}
    await sleep(250);
  }
  const chrome = {
    process: child,
    pid: child.pid,
    profileDir,
    version,
    stderr: () => stderr,
    exited: () => exited,
    async kill() {
      killProcess(child);
      unregister();
      if (!exited) {
        for (let i = 0; i < 40 && !exited; i++) await sleep(25);
      }
      try { rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    }
  };
  if (!version) {
    await chrome.kill();
    throw new Error(`Chrome did not expose CDP on port ${port}${exited ? ` (exited ${exited.code ?? exited.signal})` : ''}: ${stderr.slice(-1000)}`);
  }
  log(`Chrome ${version.Browser} on CDP port ${port}`);
  return chrome;
}

/** Software GL renderers the harness refuses unless --allow-software-gl. */
export function isSoftwareGl(renderer) {
  return /swiftshader|llvmpipe|softpipe|software|microsoft basic render/i.test(String(renderer || ''));
}
