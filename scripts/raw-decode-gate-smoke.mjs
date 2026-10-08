// RGB16 gate over every WASM decoder configuration (#264 part B), opt-in: the
// camera files and their paths never enter the repo.
//
//   RAW_DECODE_GATE_FILES='["/abs/_DSC3111.NEF","/abs/_DSC5290.dng","/abs/DSC_8800.NEF"]' \
//     npm run test:smoke -- --raw-decode-gate-only
//
// For each file, on the smoke run's cross-origin isolated page, with the
// libraw-wasm the page resolves (the installed release, or a local build with
// the test-only LIBRAW_WASM_DIST=/abs/dist, see vite.config.js):
//  - `new LibRaw()` decodes it with rawFileLoader.js's settings, full and half
//    size; the SHA-256 of LibRaw's own RGB16 output must equal
//    src-tauri/native/wasm-parity-hashes.json for that build: the
//    "libraw-wasm 1.6.0" entry for a package without the threaded build, the
//    deterministic rebuild's otherwise (which the native decoder's parity
//    tests hold natively at 1, 4 and 8 threads);
//  - with a threaded build (LibRaw.features.threads), `new LibRaw({ threads })`
//    at 1, 2, 4 and 8 threads (at most the cores) must run that many threads and
//    give the same hashes;
//  - then, on the same page served without COOP/COEP (CDP Fetch), the threaded
//    build asked for 4 threads must run one and give the same hash, as must
//    `new LibRaw()`.
// Files listed in the JSON without hashes (the HE-compressed NEFs) must not
// decode on any build, and the app's loader must return their embedded JPEG
// with the 8-bit hash recorded from 1703835 (`embeddedPreview`). Files not in
// the JSON (by name and size) are compared across configurations only.
// RAW_DECODE_GATE_RECORD=1 prints the hashes instead of comparing them.
import { readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

const HARNESS = '/src/app/rawDecodeGate.harness.mjs';
const NOT_ISOLATED_MARK = 'isolation=off';

export async function runRawDecodeGateSmoke({ send, onCdpEvent, evaluate, waitFor, fail, port, root }) {
  let paths;
  try { paths = JSON.parse(process.env.RAW_DECODE_GATE_FILES || 'null'); }
  catch { fail('RAW_DECODE_GATE_FILES must be a JSON array of absolute RAW file paths'); }
  if (!Array.isArray(paths) || !paths.length || !paths.every((path) => typeof path === 'string' && isAbsolute(path))) {
    fail('RAW_DECODE_GATE_FILES must be a JSON array of absolute RAW file paths');
  }
  const record = process.env.RAW_DECODE_GATE_RECORD === '1';
  const expectedAll = JSON.parse(readFileSync(join(root, 'src-tauri', 'native', 'wasm-parity-hashes.json'), 'utf8')).files;
  const expectedOf = (path) => {
    const entry = expectedAll[basename(path)];
    return entry && entry.bytes === statSync(path).size ? entry : null;
  };

  const boot = async (query = '') => {
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/?lang=en${query}` });
    await waitFor('boot for the RAW decode gate', `!!document.getElementById('fileInput')`);
    await evaluate(`(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'rawGateInput'; input.hidden = true; document.body.append(input); })()`);
  };
  // Puts `path` into the page as window.__rawGateFile (a File).
  const selectFile = async (path) => {
    const doc = await send('DOM.getDocument');
    const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#rawGateInput' });
    await send('DOM.setFileInputFiles', { nodeId: input.result.nodeId, files: [path] });
    await evaluate(`(async () => { window.__rawGateFile = document.getElementById('rawGateInput').files[0]; window.__rawGateBytes = await window.__rawGateFile.arrayBuffer(); return true; })()`);
  };
  const decode = (options) => evaluate(`(async () => {
    const { decodeRgb16 } = await import(${JSON.stringify(HARNESS)});
    return decodeRgb16(window.__rawGateBytes, ${JSON.stringify(options)});
  })()`);

  // ---- the isolated page
  await boot();
  const runtime = await evaluate(`import(${JSON.stringify(HARNESS)}).then((m) => m.describeDecoderRuntime())`);
  const threaded = runtime.features?.threads === true;
  // The package's own hashes: 1.6.0's (-ffast-math), or the deterministic rebuild's.
  const reference = threaded ? 'deterministic' : 'libraw-wasm 1.6.0';
  const hashOf = (entry, key) => (threaded ? entry?.[key] : entry?.['libraw-wasm 1.6.0']?.[key]) || null;
  const threadCounts = threaded ? [1, 2, 4, 8].filter((threads) => threads <= Math.max(1, runtime.cores)) : [];
  console.log('raw decode gate runtime:', JSON.stringify({ ...runtime, reference, threadCounts }));
  if (!runtime.crossOriginIsolated || !runtime.sharedArrayBuffer) fail(`the smoke page is not cross-origin isolated with shared memory: ${JSON.stringify(runtime)}`);

  const rows = [];
  for (const path of paths) {
    const name = basename(path);
    const expected = expectedOf(path);
    const undecodable = Boolean(expected) && !expected.rgb16;
    await selectFile(path);
    const row = { file: name, reference: expected ? reference : 'none', decodes: {} };
    for (const halfSize of [false, true]) {
      const key = halfSize ? 'halfRgb16' : 'rgb16';
      const single = await decode({ halfSize });
      row.decodes[`${key} single`] = single;
      const want = hashOf(expected, key);
      if (undecodable) {
        if (!single.empty) fail(`${name}: LibRaw decoded a file it must reject (${key}): ${JSON.stringify(single)}`);
      } else if (single.empty) {
        fail(`${name}: LibRaw returned no image (${key})`);
      } else if (!record && want && single.sha256 !== want) {
        fail(`${name} ${key}: ${single.sha256} is not the ${reference} hash ${want} (${single.width}x${single.height})`);
      }
      for (const threads of threadCounts) {
        const run = await decode({ halfSize, threads });
        row.decodes[`${key} threads ${threads}`] = run;
        if (run.info?.threads !== threads || run.info?.threaded !== true) fail(`${name}: new LibRaw({ threads: ${threads} }) ran ${JSON.stringify(run.info)} on the isolated page`);
        if (undecodable ? !run.empty : run.sha256 !== single.sha256) {
          fail(`${name} ${key}: ${threads} thread(s) decode differently from the single-threaded build: ${run.sha256 ?? 'no image'} vs ${single.sha256 ?? 'no image'}`);
        }
      }
    }
    if (undecodable) {
      // The app's loader takes the embedded JPEG, exactly as at 1703835.
      const app = await evaluate(`(async () => {
        const { loadWithApp } = await import(${JSON.stringify(HARNESS)});
        return loadWithApp(window.__rawGateBytes, window.__rawGateFile.name, window.__rawGateFile);
      })()`);
      row.app = app;
      if (!app.embeddedPreview) fail(`${name}: the loader did not take the embedded-JPEG fallback: ${JSON.stringify(app)}`);
      const preview = expected.embeddedPreview;
      if (!record && preview && (preview.rgba8 !== app.rgba8 || preview.size !== `${app.width}x${app.height}`)) {
        fail(`${name}: the embedded-JPEG fallback differs from 1703835's: ${JSON.stringify({ want: preview, got: app })}`);
      }
    }
    const summary = Object.fromEntries(Object.entries(row.decodes).map(([label, run]) => [label, run.empty ? 'no image' : `${run.sha256.slice(0, 16)} ${run.ms} ms`]));
    console.log(`raw decode gate: ${name} (${row.reference}):`, JSON.stringify({ ...summary, ...(row.app ? { app: row.app } : {}) }));
    rows.push(row);
  }

  // ---- the same page without COOP/COEP: one thread, the same pixels
  await send('Fetch.enable', { patterns: [{ urlPattern: `*${NOT_ISOLATED_MARK}*`, resourceType: 'Document', requestStage: 'Response' }] });
  const stopStripping = onCdpEvent((msg) => {
    if (msg.method !== 'Fetch.requestPaused' || msg.sessionId) return;
    const { requestId, responseHeaders = [], responseStatusCode } = msg.params;
    const headers = responseHeaders.filter(({ name }) => !/^cross-origin-(opener|embedder)-policy$/i.test(name));
    void send('Fetch.getResponseBody', { requestId }).then((reply) => {
      const body = reply.result?.base64Encoded ? reply.result.body : Buffer.from(reply.result?.body || '').toString('base64');
      return send('Fetch.fulfillRequest', { requestId, responseCode: responseStatusCode || 200, responseHeaders: headers, body });
    });
  });
  try {
    await boot(`&${NOT_ISOLATED_MARK}`);
  } finally {
    stopStripping();
    await send('Fetch.disable');
  }
  const plain = await evaluate(`import(${JSON.stringify(HARNESS)}).then((m) => m.describeDecoderRuntime())`);
  if (plain.crossOriginIsolated) fail('the page served without COOP/COEP is still isolated');
  for (const row of rows) {
    const path = paths[rows.indexOf(row)];
    const isolatedSingle = row.decodes['rgb16 single'];
    await selectFile(path);
    const configs = threaded ? [{ threads: 4 }, {}] : [{}];
    for (const options of configs) {
      const run = await decode(options);
      const label = options.threads ? `threads ${options.threads}` : 'single';
      row.decodes[`rgb16 ${label}, not isolated`] = run;
      if (options.threads && run.info?.threads !== 1) fail(`${row.file}: new LibRaw({ threads: 4 }) ran ${JSON.stringify(run.info)} on a page that is not isolated`);
      if ((run.sha256 ?? null) !== (isolatedSingle.sha256 ?? null)) {
        fail(`${row.file}: the ${label} decode on a page that is not isolated differs: ${run.sha256 ?? 'no image'} vs ${isolatedSingle.sha256 ?? 'no image'}`);
      }
    }
  }

  if (record) {
    const recorded = Object.fromEntries(rows.map((row) => [row.file, {
      rgb16: row.decodes['rgb16 single'].sha256 ?? null,
      halfRgb16: row.decodes['halfRgb16 single'].sha256 ?? null,
      ...(row.app ? { embeddedPreview: { size: `${row.app.width}x${row.app.height}`, rgba8: row.app.rgba8 } } : {})
    }]));
    console.log(`RAW decode gate hashes (${reference}):\n${JSON.stringify(recorded, null, 2)}`);
  }
  const compared = rows.filter((row) => row.reference !== 'none').length;
  console.log(`ok: RAW decode gate, ${rows.length} file(s) (${compared} against ${reference} hashes), `
    + `${threaded ? `threaded build at ${threadCounts.join('/')} thread(s) and 1 without isolation` : 'single-threaded build, isolated and not'}: identical`);
}
