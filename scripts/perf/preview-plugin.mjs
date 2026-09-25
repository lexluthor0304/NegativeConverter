// Preview-only Vite plugin for the benchmark (configurePreviewServer). The
// shipped bundle is unchanged; these routes exist only on the harness's
// `vite preview`, bound to 127.0.0.1:
//
//   GET  /__perf/health         liveness + the dev-server request check
//   GET  /__perf/requests       requests that only a dev server would see
//   GET  /__perf/probe.js       the in-page probe (same origin: CSP 'self')
//   GET  /__perf/fixtures/NAME  WebKit modes only; the configured files only
//   POST /__perf/results        probe results (WebKit modes)
//   POST /__perf/heartbeat      "main thread silent" reports (WebKit modes)
//   POST /__perf/export?name=   export bytes for the S9 verification pass
//   GET  /?perf=1               WebKit modes only: index.html with the probe injected
//
// Options come from the environment because Vite loads this config in its
// own process: NC_PERF_WEBKIT, NC_PERF_FIXTURES (JSON name → path),
// NC_PERF_RESULTS_DIR, NC_PERF_EXPORT_DIR, NC_PERF_DIST.

import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export function optionsFromEnv(env = process.env) {
  let fixtures = {};
  try { fixtures = JSON.parse(env.NC_PERF_FIXTURES || '{}'); } catch { fixtures = {}; }
  return {
    webkit: env.NC_PERF_WEBKIT === '1',
    fixtures,
    resultsDir: env.NC_PERF_RESULTS_DIR || null,
    exportDir: env.NC_PERF_EXPORT_DIR || null,
    distDir: env.NC_PERF_DIST || null,
    probePath: env.NC_PERF_PROBE_PATH || join(here, 'probe.js')
  };
}

export function isDevServerRequest(url) {
  return /\/@vite\/client|\/@id\/|\/@fs\/|[?&]import(&|$)|[?&]html-proxy/.test(url || '');
}

/** Insert the probe as the first script in <head>, before the app's modules. */
export function injectProbe(html, src = '/__perf/probe.js?mode=webkit') {
  const tag = `<script src="${src}"></script>`;
  const head = /<head[^>]*>/i.exec(html);
  return head ? html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length) : tag + html;
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json') {
  res.statusCode = status;
  res.setHeader('content-type', type);
  res.setHeader('cache-control', 'no-store');
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

export function createPerfMiddleware(options) {
  const suspicious = [];
  let sequence = 0;
  const fixtureNames = new Map(Object.entries(options.fixtures || {}).map(([name, path]) => [name, path]));

  return async function perfMiddleware(req, res, next) {
    const url = req.url || '/';
    if (isDevServerRequest(url)) suspicious.push({ url, at: Date.now() });
    let parsed;
    try { parsed = new URL(url, 'http://127.0.0.1'); } catch { return next(); }
    const path = parsed.pathname;
    try {
      if (req.method === 'GET' && path === '/__perf/health') return send(res, 200, { ok: true, webkit: options.webkit, suspicious: suspicious.length });
      if (req.method === 'GET' && path === '/__perf/requests') return send(res, 200, { suspicious });
      if (req.method === 'GET' && path === '/__perf/probe.js') {
        return send(res, 200, readFileSync(options.probePath), 'text/javascript; charset=utf-8');
      }
      if (req.method === 'GET' && path.startsWith('/__perf/fixtures/')) {
        const name = decodeURIComponent(path.slice('/__perf/fixtures/'.length));
        const file = options.webkit ? fixtureNames.get(name) : null;
        if (!file || !existsSync(file)) return send(res, 404, { error: 'unknown fixture' });
        res.statusCode = 200;
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('content-length', String(statSync(file).size));
        res.setHeader('cache-control', 'no-store');
        createReadStream(file, { flags: 'r' }).pipe(res);
        return undefined;
      }
      if (req.method === 'POST' && (path === '/__perf/results' || path === '/__perf/heartbeat')) {
        const body = await readBody(req);
        let json;
        try { json = JSON.parse(body.toString('utf8')); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        if (options.resultsDir) {
          mkdirSync(options.resultsDir, { recursive: true });
          const kind = path.endsWith('heartbeat') ? 'heartbeat' : 'result';
          writeFileSync(join(options.resultsDir, `${kind}-${Date.now()}-${++sequence}.json`), JSON.stringify({ receivedAt: Date.now(), ...json }));
        }
        return send(res, 204, '');
      }
      if (req.method === 'POST' && path === '/__perf/export') {
        if (!options.exportDir) return send(res, 404, { error: 'no export dir' });
        mkdirSync(options.exportDir, { recursive: true });
        const name = `${++sequence}-${basename(parsed.searchParams.get('name') || 'export.bin').replace(/[^\w.-]+/g, '_')}`;
        const file = join(options.exportDir, name);
        const out = createWriteStream(file);
        let size = 0;
        req.on('data', chunk => { size += chunk.length; });
        req.pipe(out);
        await new Promise((resolve, reject) => { out.once('finish', resolve); out.once('error', reject); req.once('error', reject); });
        return send(res, 200, { file, size });
      }
      if (req.method === 'GET' && (path === '/' || path === '/index.html') && parsed.searchParams.get('perf') === '1' && options.webkit && options.distDir) {
        const html = readFileSync(join(options.distDir, 'index.html'), 'utf8');
        return send(res, 200, injectProbe(html), 'text/html; charset=utf-8');
      }
    } catch (error) {
      return send(res, 500, { error: String(error.message || error) });
    }
    return next();
  };
}

export function ncPerfPreviewPlugin(options = optionsFromEnv()) {
  return {
    name: 'nc-perf-preview',
    configurePreviewServer(server) {
      // Registered before Vite's static middleware, so /__perf and ?perf=1 win.
      server.middlewares.use(createPerfMiddleware(options));
    }
  };
}
