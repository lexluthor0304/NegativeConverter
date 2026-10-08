// The /__perf routes, exercised through a plain node:http server (no Vite).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admissionPaths, createPerfMiddleware, injectProbe, isDevServerRequest, optionsFromEnv, ncPerfPreviewPlugin } from './preview-plugin.mjs';
import perfPreviewConfig from './vite.preview.config.js';

const root = mkdtempSync(join(tmpdir(), 'nc-perf-preview-'));
const listen = middleware => new Promise(resolve => {
  const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 418; res.end('static'); }));
  server.listen(0, '127.0.0.1', () => resolve(server));
});

try {
  const dist = join(root, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><script type="module" src="./assets/main.js"></script></head><body></body></html>');
  const fixture = join(root, 'L1000617.DNG');
  writeFileSync(fixture, Buffer.alloc(1000, 7));
  const options = {
    webkit: true, fixtures: { 'L1000617.DNG': fixture }, resultsDir: join(root, 'results'), exportDir: join(root, 'exports'),
    distDir: dist, probePath: join(import.meta.dirname, 'probe.js')
  };
  const server = await listen(createPerfMiddleware(options));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await (await fetch(`${origin}/__perf/health`)).json(), { ok: true, webkit: true, suspicious: 0 });
    const probe = await fetch(`${origin}/__perf/probe.js`);
    assert.match(probe.headers.get('content-type'), /javascript/);
    assert.match(await probe.text(), /installNcPerfProbe/);
    // Fixtures: only configured names, read-only streaming.
    const file = await fetch(`${origin}/__perf/fixtures/L1000617.DNG`);
    assert.equal(file.status, 200);
    assert.equal((await file.arrayBuffer()).byteLength, 1000);
    assert.equal((await fetch(`${origin}/__perf/fixtures/..%2F..%2Fetc%2Fpasswd`)).status, 404);
    assert.equal((await fetch(`${origin}/__perf/fixtures/other.DNG`)).status, 404);
    // ?perf=1 injects the probe before the app's module script.
    const html = await (await fetch(`${origin}/?perf=1&scenario=s1`)).text();
    assert.ok(html.indexOf('/__perf/probe.js') < html.indexOf('./assets/main.js'));
    assert.equal(await (await fetch(`${origin}/`)).text(), 'static', 'without ?perf=1 the page is served unchanged');
    // Results and exports land in their directories.
    assert.equal((await fetch(`${origin}/__perf/results`, { method: 'POST', body: JSON.stringify({ scenario: 's1', metrics: { a: 1 } }) })).status, 204);
    const [result] = readdirSync(options.resultsDir);
    assert.equal(JSON.parse(readFileSync(join(options.resultsDir, result), 'utf8')).scenario, 's1');
    const token = 'a'.repeat(32), claims = admissionPaths(options.resultsDir, token);
    assert.equal((await fetch(`${origin}/__perf/admission?token=../invalid`)).status, 400);
    assert.deepEqual(await (await fetch(`${origin}/__perf/admission?token=${token}`)).json(), { state: 'pending' });
    assert.ok(existsSync(claims.request), 'native warmup begins at the first UI bootstrap request');
    writeFileSync(claims.grant, JSON.stringify({ state: 'admitted' }));
    assert.deepEqual(await (await fetch(`${origin}/__perf/admission?token=${token}`)).json(), { state: 'admitted' });
    writeFileSync(claims.grant, JSON.stringify({ state: 'aborted' }));
    assert.deepEqual(await (await fetch(`${origin}/__perf/admission?token=${token}`)).json(), { state: 'aborted' });
    assert.deepEqual(await (await fetch(`${origin}/__perf/admission?token=${'b'.repeat(32)}`)).json(), { state: 'pending' }, 'one launch cannot reuse another launch grant');
    assert.equal((await fetch(`${origin}/__perf/results`, { method: 'POST', body: 'not json' })).status, 400);
    const exported = await (await fetch(`${origin}/__perf/export?name=${encodeURIComponent('../L1000617.png')}`, { method: 'POST', body: Buffer.alloc(5000, 1) })).json();
    assert.equal(exported.size, 5000);
    assert.ok(exported.file.startsWith(options.exportDir) && exported.file.endsWith('L1000617.png'));
    // Dev-server requests are recorded for the production assertion.
    await fetch(`${origin}/@vite/client`);
    await fetch(`${origin}/src/app/main.js?import`);
    const { suspicious } = await (await fetch(`${origin}/__perf/requests`)).json();
    assert.deepEqual(suspicious.map(entry => entry.url), ['/@vite/client', '/src/app/main.js?import']);
  } finally {
    server.close();
  }

  // Chrome mode: no fixture route and no injection.
  const chromeServer = await listen(createPerfMiddleware({ ...options, webkit: false }));
  const chromeOrigin = `http://127.0.0.1:${chromeServer.address().port}`;
  try {
    assert.equal((await fetch(`${chromeOrigin}/__perf/fixtures/L1000617.DNG`)).status, 404);
    assert.equal((await fetch(`${chromeOrigin}/__perf/admission?token=${'a'.repeat(32)}`)).status, 404);
    assert.equal(await (await fetch(`${chromeOrigin}/?perf=1`)).text(), 'static');
  } finally {
    chromeServer.close();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

assert.equal(isDevServerRequest('/assets/main-abc.js'), false);
assert.equal(isDevServerRequest('/@vite/client'), true);
assert.equal(injectProbe('<html><body></body></html>'), '<script src="/__perf/probe.js?mode=webkit"></script><html><body></body></html>');
assert.deepEqual(optionsFromEnv({ NC_PERF_WEBKIT: '1', NC_PERF_FIXTURES: '{"a":"/x"}' }).fixtures, { a: '/x' });
assert.equal(ncPerfPreviewPlugin({}).name, 'nc-perf-preview');

// The harness config extends the app's config (the ref under test) with the plugin.
const config = await perfPreviewConfig({ command: 'serve', mode: 'production', isPreview: true });
assert.ok(config.build.rollupOptions.input.main.endsWith('index.html'), 'the app config is loaded');
assert.ok(config.plugins.some(plugin => plugin.name === 'nc-perf-preview'));
assert.equal(config.preview.host, '127.0.0.1');

console.log('preview plugin: probe, fixtures, results, exports, injection and dev-request tests passed');
