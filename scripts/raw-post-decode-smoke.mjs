// RAW post-decode worker (#232) in a real browser.
//
// Always on (synthetic, a few hundred ms): the per-decode module worker
// loads and answers its handshake, its planes, defect stats and film
// statistics are byte-identical to the main-thread sequence for every LibRaw
// result shape, the LibRaw buffer is moved (not copied) into it, and the exact
// fast defect kernel matches the frozen 1703835 kernel under Chrome's V8.
//
// Opt-in, real camera files (the files and their paths never enter the repo):
//   RAW_PARITY_FILES='["/abs/L1000620.DNG","/abs/_DSC3111.NEF","/abs/L1009967.dng","/abs/_DSC5290.dng"]' \
//     npm run test:smoke -- --raw-parity-only
// For each file: the shipping decode (post-decode worker, fast kernel) against
// the same LibRaw output repaired by the frozen kernel on this thread; the
// typed film statistics against the frozen comparator versions at buffers
// 0/10/30; and the lazy (Blob) embedded-preview path against the eager one —
// for DSC_8800/8798/8806/4127.NEF that is the preview decode itself.
// Prints SHA-256 of the RGBA16 plane, the 8-bit plane and the defect stats.
// RAW_PARITY_EXPECTED=/abs/hashes.json compares them with values recorded from
// 1703835 (record there with RAW_PARITY_RECORD=1, which only needs loadRawFile).
import { readFileSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';

export async function runRawPostDecodeSmoke({ evaluate, fail }) {
  const result = await evaluate(`(async () => {
    const { startRawPostDecode } = await import('/src/app/rawPostDecodeClient.js');
    const { runRawPostDecode } = await import('/src/app/rawPostDecode.js');
    const { makeRawResult, cloneRawResult } = await import('/src/app/rawPostDecode.fixtures.mjs');
    const { suppressSensorDefects } = await import('/src/silvercore/util/sensorDefects.js');
    const { suppressSensorDefectsReference } = await import('/src/silvercore/util/sensorDefects.reference.mjs');
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const shapes = [
      { width: 256, height: 171, seed: 1, channels: 3, bits: 16 },
      { width: 200, height: 133, seed: 2, channels: 4, bits: 16, byteOffset: 8, padding: 4 },
      { width: 240, height: 160, seed: 3, channels: 3, bits: 8 },
      { width: 180, height: 120, seed: 4, channels: 1, bits: 16 },
    ];
    const rows = [];
    for (const spec of shapes) {
      const fixture = makeRawResult(spec);
      const options = { suppressSensorDefects: true, filmStats: { borderBufferPct: 10 } };
      const reference = runRawPostDecode(cloneRawResult(fixture), options);
      const handle = startRawPostDecode();
      const input = cloneRawResult(fixture);
      const started = performance.now();
      try {
        const out = await handle.run(input, options);
        rows.push({
          shape: spec.channels + 'ch/' + spec.bits + 'bit',
          worker: handle.ranInWorker,
          moved: input.data.buffer.byteLength === 0,
          rgba16: same(out.rgba16, reference.rgba16),
          rgba8: same(out.rgba8, reference.rgba8),
          stats: JSON.stringify(out.defects) === JSON.stringify(reference.defects),
          filmStats: JSON.stringify(out.filmStats) === JSON.stringify(reference.filmStats),
          repaired: out.defects.repaired,
          ms: Math.round(performance.now() - started)
        });
      } finally {
        handle.terminate();
      }
    }
    // Kernel parity under this browser's JIT, on a noisy ~1 MP frame.
    const w = 1201, h = 803, data = new Uint16Array(w * h * 4);
    let s = 7;
    const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    for (let i = 0; i < data.length; i++) data[i] = (i & 3) === 3 ? 65535 : Math.round((20000 + 20000 * ((i & 3) === 0)) * (1 + (rnd() - 0.5) * 0.25));
    for (let n = 0; n < 300; n++) data[(Math.floor(rnd() * h) * w + Math.floor(rnd() * w)) * 4 + (n % 3)] = n % 2 ? 0 : 65535;
    const a = { width: w, height: h, data: new Uint16Array(data) }, b = { width: w, height: h, data: new Uint16Array(data) };
    let t = performance.now();
    const refStats = suppressSensorDefectsReference(a);
    const refMs = performance.now() - t;
    t = performance.now();
    const newStats = suppressSensorDefects(b);
    const newMs = performance.now() - t;
    const kernel = { identical: same(a.data, b.data) && JSON.stringify(refStats) === JSON.stringify(newStats), repaired: newStats.repaired, refMs: Math.round(refMs), newMs: Math.round(newMs) };
    return { rows, kernel };
  })()`);
  console.log('raw post-decode:', JSON.stringify(result));
  const bad = result.rows.filter(row => !(row.worker && row.moved && row.rgba16 && row.rgba8 && row.stats && row.filmStats));
  if (bad.length) fail('RAW post-decode worker regression: ' + JSON.stringify(bad));
  if (!result.rows.slice(0, 3).every(row => row.repaired > 0)) fail('post-decode fixtures repaired no defects: ' + JSON.stringify(result.rows));
  if (!result.kernel.identical || result.kernel.repaired < 1) fail('fast defect kernel differs from the frozen kernel in the browser: ' + JSON.stringify(result.kernel));
}

export async function runRawParitySmoke({ send, evaluate, waitFor, fail, port }) {
  let paths;
  try { paths = JSON.parse(process.env.RAW_PARITY_FILES || 'null'); }
  catch { fail('RAW_PARITY_FILES must be a JSON array of absolute RAW file paths'); }
  if (!Array.isArray(paths) || !paths.length || !paths.every(path => typeof path === 'string' && isAbsolute(path))) {
    fail('RAW_PARITY_FILES must be a JSON array of absolute RAW file paths');
  }
  const record = process.env.RAW_PARITY_RECORD === '1';
  const expected = process.env.RAW_PARITY_EXPECTED ? JSON.parse(readFileSync(process.env.RAW_PARITY_EXPECTED, 'utf8')) : null;
  const rows = [];
  for (const path of paths) {
    // A fresh page per file keeps at most one 60 MP decode's planes alive.
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await waitFor('boot for RAW parity', `!!document.getElementById('fileInput')`);
    await evaluate(`(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'rawParityInput'; input.hidden = true; document.body.append(input); })()`);
    const doc = await send('DOM.getDocument');
    const input = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#rawParityInput' });
    await send('DOM.setFileInputFiles', { nodeId: input.result.nodeId, files: [path] });
    const row = await evaluate(`(async () => {
      const record = ${JSON.stringify(record)};
      const file = document.getElementById('rawParityInput').files[0];
      const { loadRawFile } = await import('/src/app/rawFileLoader.js');
      const hex = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
      const planeBytes = (view) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      let defectLine = null, previewFallback = false;
      const { info, warn } = console;
      console.info = (...args) => { if (typeof args[0] === 'string' && args[0].startsWith('[RAW] suppressed')) defectLine = args[0]; info.apply(console, args); };
      console.warn = (...args) => { if (typeof args[0] === 'string' && /embedded preview/.test(args[0])) previewFallback = true; warn.apply(console, args); };
      let shipped;
      const started = performance.now();
      try { shipped = await loadRawFile(await file.arrayBuffer(), file.name, { sourceBlob: file }); }
      finally { console.info = info; console.warn = warn; }
      const decodeMs = Math.round(performance.now() - started);
      const out = {
        file: file.name, width: shipped.width, height: shipped.height, decodeMs, previewFallback,
        rgba16: shipped.__image16 ? await hex(planeBytes(shipped.__image16.data)) : null,
        rgba8: await hex(planeBytes(shipped.data)),
        defects: defectLine || 'none'
      };
      if (record) return out;
      const { suppressSensorDefectsReference } = await import('/src/silvercore/util/sensorDefects.reference.mjs');
      const { sampleFilmBase, autoDetectFilmBase } = await import('/src/app/filmBaseDetection.js');
      const { detectFilmType } = await import('/src/app/filmTypeDetection.js');
      const ref = await import('/src/app/filmStatistics.reference.mjs');
      // Film statistics on the real plane, typed vs comparator versions.
      out.filmStats = [0, 10, 30].every(buffer => JSON.stringify(autoDetectFilmBase(shipped, buffer)) === JSON.stringify(ref.autoDetectFilmBaseReference(shipped, buffer)))
        && JSON.stringify(detectFilmType(shipped)) === JSON.stringify(ref.detectFilmTypeReference(shipped))
        && JSON.stringify(sampleFilmBase(shipped, shipped.width / 2, shipped.height / 2, 40)) === JSON.stringify(ref.sampleFilmBaseReference(shipped, shipped.width / 2, shipped.height / 2, 40));
      // The same LibRaw output, unrepaired, then repaired by the frozen kernel.
      let shippedRgba16 = shipped.__image16?.data || null;
      let shippedRgba8 = shipped.data;
      shipped = null;
      if (shippedRgba16 && !previewFallback) {
        const raw = await loadRawFile(await file.arrayBuffer(), file.name, { sourceBlob: file, suppressSensorDefects: false });
        const plane = { width: raw.width, height: raw.height, data: raw.__image16.data };
        const stats = suppressSensorDefectsReference(plane);
        let same16 = plane.data.length === shippedRgba16.length, same8 = true;
        for (let i = 0; same16 && i < plane.data.length; i++) if (plane.data[i] !== shippedRgba16[i]) same16 = false;
        for (let i = 0; same8 && i < plane.data.length; i++) if ((plane.data[i] >>> 8) !== shippedRgba8[i]) same8 = false;
        out.kernelParity = same16 && same8;
        out.referenceDefects = stats.repaired;
      }
      shippedRgba16 = shippedRgba8 = null;
      // Lazy (Blob) vs eager embedded-preview path: identical result.
      const eager = await loadRawFile(await file.arrayBuffer(), file.name);
      out.eagerMatches = eager.width === out.width && eager.height === out.height && await hex(planeBytes(eager.data)) === out.rgba8;
      return out;
    })()`);
    console.log('raw parity:', JSON.stringify(row));
    rows.push(row);
    if (record) continue;
    if (row.filmStats !== true) fail(`typed film statistics differ from the comparator versions on ${basename(path)}`);
    if (row.rgba16 && !row.previewFallback && row.kernelParity !== true) fail(`fast defect kernel differs from the frozen kernel on ${basename(path)}`);
    if (row.eagerMatches !== true) fail(`lazy embedded-preview path differs from the eager one on ${basename(path)}`);
    const want = expected?.[row.file];
    if (want && (want.rgba16 !== row.rgba16 || want.rgba8 !== row.rgba8 || (want.defects && want.defects !== row.defects))) {
      fail(`${row.file} differs from the recorded 1703835 hashes: ${JSON.stringify({ want, got: row })}`);
    }
  }
  if (record) console.log('RAW_PARITY_EXPECTED json:\n' + JSON.stringify(Object.fromEntries(rows.map(row => [row.file, { rgba16: row.rgba16, rgba8: row.rgba8, defects: row.defects, width: row.width, height: row.height }])), null, 2));
}
