import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { sniffImageKind } from './imageFileLoaders.js';

const source = readFileSync(new URL('./imageFileLoaders.js', import.meta.url), 'utf8');
function fn(name) {
  const start = new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, 'm').exec(source)?.index;
  assert.notEqual(start, undefined, name);
  return source.slice(start, source.indexOf('\n}', start) + 2).replace(/^export /, '').replace(/\bimport\(/g, 'importModule(');
}
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
const header = new Uint8Array(26);
header.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]); header[24] = 16; header[25] = 6;

// Execute the production PNG caller with only module delivery delayed. This
// preserves release-preview's after-import abort guards at both lazy imports.
for (const boundary of ['scan', 'upng']) {
  const imported = defer(), delivered = defer(), controller = new AbortController();
  let starts = 0, claims = 0;
  const c = vm.createContext({
    DOMException, sniffImageKind,
    importModule: async path => {
      const scan = path === './scanDecodeClient.js';
      if (scan === (boundary === 'scan')) { imported.resolve(); await delivered.promise; }
      return scan ? { decodeScanInWorker: () => { if (boundary === 'scan') starts++; return null; } }
        : { loadPngFile: () => { starts++; return {}; } };
    }
  });
  vm.runInContext(['throwIfAborted', 'loadPngImageData'].map(fn).join('\n'), c);
  const pending = c.loadPngImageData(header.buffer.slice(0), { signal: controller.signal, reserveDecode: () => { claims++; } });
  pending.catch(() => {}); await imported.promise;
  controller.abort(); delivered.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(starts, 0, `${boundary}: no dispatch after an aborted import`);
  assert.equal(claims, 0, `${boundary}: no late claim after abort`);
}

// The UPNG import finishes after another foreground operation starts. The
// actual synchronous decoder is untouched until the supplied claim admits it.
{
  const imported = defer(), delivered = defer(), admitted = defer(), controller = new AbortController();
  let starts = 0, gates = 0;
  const c = vm.createContext({
    DOMException, sniffImageKind, sharedPlanesAvailable: () => false,
    importModule: async path => {
      if (path === './scanDecodeClient.js') return { decodeScanInWorker: async () => null };
      imported.resolve(); await delivered.promise;
      return { loadPngFile: () => { starts++; return {}; } };
    }
  });
  vm.runInContext(['throwIfAborted', 'loadPngImageData'].map(fn).join('\n'), c);
  const pending = c.loadPngImageData(header.buffer.slice(0), {
    signal: controller.signal,
    reserveDecode: async size => { assert.equal(JSON.stringify(size), '{"kind":"scan"}'); gates++; await admitted.promise; }
  });
  await imported.promise; delivered.resolve(); await tick();
  assert.equal(gates, 1); assert.equal(starts, 0);
  admitted.resolve(); await pending; assert.equal(starts, 1);
}

// iPhone-DNG's scan retry catch must propagate a generic admission error
// instead of silently creating LibRaw. The real RAW orchestration executes.
{
  const rawSource = readFileSync(new URL('./rawFileLoader.js', import.meta.url), 'utf8')
    .replace(/^import .*\n/gm, '').replace(/^export \{[^\n]*\n/gm, '').replace(/\bexport (?=(async )?function)/g, '');
  const denied = Error('DNG scan admission denied'); let created = 0, codec = 0;
  const c = vm.createContext({
    DOMException, console: { info() {}, warn() {}, error() {} },
    isIPhoneDngHeader: () => true,
    decodeScanInWorker: async (_buffer, _format, { reserveDecode }) => { await reserveDecode({ kind: 'scan' }); return null; },
    decodeTiffBuffer: () => { codec++; }, createRawDecoder: () => { created++; throw Error('unexpected fallback'); }
  });
  vm.runInContext(rawSource, c);
  await assert.rejects(c.loadRawFile(new ArrayBuffer(32), 'scan.dng', { reserveDecode: () => { throw denied; } }), error => error === denied);
  assert.equal(codec, 0); assert.equal(created, 0);
}
console.log('imageFileLoaders.admission: actual delayed PNG imports, abort propagation, UPNG dispatch and DNG refusal passed');
