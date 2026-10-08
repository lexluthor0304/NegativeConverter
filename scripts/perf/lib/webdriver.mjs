// Minimal W3C WebDriver client over fetch for `--browser safari`
// (safaridriver). Perform Actions give trusted pointer, key and wheel input.
// Setup once: `safaridriver --enable` and Develop → Allow Remote Automation.

import { spawn } from 'node:child_process';
import { registerProcess, killProcess } from './resources.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const KEY = Object.freeze({ Enter: '', ArrowLeft: '', ArrowUp: '', ArrowRight: '', ArrowDown: '', Meta: '' });

export class WebDriverError extends Error {
  constructor(method, path, status, value) {
    super(`${method} ${path}: HTTP ${status} ${value?.error || ''} ${value?.message || ''}`.trim());
    this.name = 'WebDriverError';
    this.value = value;
  }
}

export async function startSafariDriver({ port, log = () => {} }) {
  const child = spawn('safaridriver', ['-p', String(port)], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const unregister = registerProcess(child);
  const stop = () => { killProcess(child); unregister(); };
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  let exited = null;
  child.once('exit', code => { exited = code; });
  for (let i = 0; i < 80 && exited === null; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`);
      if (response.ok) { log(`safaridriver on port ${port}`); return { child, url: `http://127.0.0.1:${port}`, stop }; }
    } catch {}
    await sleep(250);
  }
  stop();
  throw new Error(`safaridriver did not start (run \`safaridriver --enable\` once and allow remote automation): ${output.slice(-500)}`);
}

export class WebDriverSession {
  static async create(base, capabilities = { browserName: 'safari' }) {
    const response = await request(base, 'POST', '/session', { capabilities: { alwaysMatch: capabilities } });
    return new WebDriverSession(base, response.sessionId || response.value?.sessionId);
  }

  constructor(base, id) {
    this.base = base;
    this.id = id;
  }

  command(method, path, body) {
    return request(this.base, method, `/session/${this.id}${path}`, body);
  }

  async navigate(url) {
    await this.command('POST', '/url', { url });
  }

  async execute(script, args = []) {
    return (await this.command('POST', '/execute/sync', { script, args })).value;
  }

  /** `script` receives its arguments and a trailing callback. */
  async executeAsync(script, args = []) {
    return (await this.command('POST', '/execute/async', { script, args })).value;
  }

  async setWindowRect(rect) {
    await this.command('POST', '/window/rect', rect).catch(() => {});
  }

  async actions(sources) {
    await this.command('POST', '/actions', { actions: sources });
    await this.command('DELETE', '/actions').catch(() => {});
  }

  /** Pointer drag in viewport coordinates: press, `steps` moves of 16 ms each, release. */
  async drag({ from, to, steps = 180, stepMs = 16, modifierKey = null }) {
    const moves = [];
    for (let i = 1; i <= steps; i++) {
      moves.push({ type: 'pointerMove', origin: 'viewport', duration: stepMs, x: Math.round(from.x + (to.x - from.x) * i / steps), y: Math.round(from.y + (to.y - from.y) * i / steps) });
    }
    const pointer = {
      type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
      actions: [{ type: 'pointerMove', origin: 'viewport', duration: 0, x: Math.round(from.x), y: Math.round(from.y) }, { type: 'pointerDown', button: 0 }, ...moves, { type: 'pointerUp', button: 0 }]
    };
    const sources = [pointer];
    if (modifierKey) {
      sources.push({ type: 'key', id: 'keyboard', actions: [{ type: 'keyDown', value: modifierKey }, ...pointer.actions.slice(1).map(() => ({ type: 'pause', duration: 0 })), { type: 'keyUp', value: modifierKey }] });
    }
    await this.actions(sources);
  }

  async click(x, y, { count = 1 } = {}) {
    const actions = [{ type: 'pointerMove', origin: 'viewport', duration: 0, x: Math.round(x), y: Math.round(y) }];
    for (let i = 0; i < count; i++) actions.push({ type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 });
    await this.actions([{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions }]);
  }

  async keys(values) {
    const actions = values.flatMap(value => [{ type: 'keyDown', value }, { type: 'keyUp', value }]);
    await this.actions([{ type: 'key', id: 'keyboard', actions }]);
  }

  async wheel(x, y, deltaY, count) {
    const actions = Array.from({ length: count }, () => ({ type: 'scroll', origin: 'viewport', x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY, duration: 16 }));
    await this.actions([{ type: 'wheel', id: 'wheel', actions }]);
  }

  async close() {
    await request(this.base, 'DELETE', `/session/${this.id}`).catch(() => {});
  }
}

async function request(base, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { value: text }; }
  if (!response.ok) throw new WebDriverError(method, path, response.status, json.value);
  return json.value && typeof json.value === 'object' && 'sessionId' in json.value ? json.value : json;
}
