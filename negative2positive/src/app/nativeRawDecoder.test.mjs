// Standalone Node test for nativeRawDecoder.js and nativeRawTransfer.js (#264
// part C) - run with: node negative2positive/src/app/nativeRawDecoder.test.mjs
// The loader-level behaviour is in rawFileLoader.native.test.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  NATIVE_RAW_UPLOAD_CHUNK_BYTES,
  LIBRAW_WASM_VERSION,
  NATIVE_RAW_PARITY,
  decideNativeRawDecode,
  decorateNativeMetadata,
  nativeDecodeOptions,
  probeNativeRawDecoder,
  resetNativeRawProbe,
  createRawDecoder,
  createNativeLibRaw,
} from './nativeRawDecoder.js';
import { readNativePlane, fetchNativePlane, handleNativePlaneMessage, resetNativePlaneTransport } from './nativeRawTransfer.js';

// rawFileLoader.js's decode settings (decodeWithLibRaw).
const LOADER_SETTINGS = { noInterpolation: false, useAutoWb: true, useCameraWb: true, useCameraMatrix: 3, outputColor: 1, outputBps: 16, halfSize: false };
{
  // Every combination the loader asks for is one the shell reproduces.
  const { librawDecodeSettings } = await import('./rawFileLoader.js');
  assert.deepEqual(librawDecodeSettings(), LOADER_SETTINGS);
  for (const outputBps of [8, 16]) {
    for (const halfSize of [false, true]) {
      assert.deepEqual(nativeDecodeOptions(librawDecodeSettings({ outputBps, halfSize })), { halfSize, outputBps });
    }
  }
}

console.info = () => {};
console.warn = () => {};

// The upload chunk limit is one constant in two languages.
{
  const rust = readFileSync(new URL('../../../src-tauri/src/native_raw.rs', import.meta.url), 'utf8');
  const match = /pub const UPLOAD_CHUNK_LIMIT: usize = ([\d\s*]+);/.exec(rust);
  assert.ok(match, 'UPLOAD_CHUNK_LIMIT is declared in native_raw.rs');
  const limit = match[1].split('*').reduce((product, factor) => product * Number(factor.trim()), 1);
  assert.equal(limit, NATIVE_RAW_UPLOAD_CHUNK_BYTES);
}

// The shell serves planes from the scheme the page fetches, and the desktop
// CSP lets the page and its workers connect to it (macOS/Linux spell it
// rawdecode://localhost, Windows http://rawdecode.localhost).
{
  const rust = readFileSync(new URL('../../../src-tauri/src/native_raw.rs', import.meta.url), 'utf8');
  assert.match(rust, /pub const PIXEL_SCHEME: &str = "rawdecode";/);
  const source = readFileSync(new URL('./nativeRawDecoder.js', import.meta.url), 'utf8');
  assert.match(source, /convertFileSrc\(session, 'rawdecode'\)/);
  const tauri = JSON.parse(readFileSync(new URL('../../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  const connect = tauri.app.security.csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('connect-src')).split(/\s+/);
  assert.ok(connect.includes('rawdecode:') && connect.includes('http://rawdecode.localhost'), 'CSP connect-src lists the rawdecode scheme');
}

// The page's libraw-wasm release is the one package.json declares.
{
  const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.equal(LIBRAW_WASM_VERSION, pkg.dependencies['libraw-wasm'].replace(/^[\^~>=<\s]+/, ''));
}

// --- the gate ---------------------------------------------------------------------
{
  const info = { available: true, platform: 'macos-aarch64' };
  const parity = { librawWasm: '1.7.0', platforms: ['macos-aarch64'] };
  assert.deepEqual(decideNativeRawDecode({ info: { available: false }, override: 'on' }), { enabled: false, reason: 'unavailable' });
  assert.equal(decideNativeRawDecode({ info, parity, librawWasm: '1.7.0' }).enabled, true, 'verified platform and release');
  assert.equal(decideNativeRawDecode({ info, parity, librawWasm: '1.6.0' }).reason, 'wasm-build-unverified',
    'native output differs from a libraw-wasm release it was not verified against');
  assert.equal(decideNativeRawDecode({ info: { ...info, platform: 'windows-x86_64' }, parity, librawWasm: '1.7.0' }).reason, 'platform-unverified');
  assert.equal(decideNativeRawDecode({ info, parity, librawWasm: '1.7.0', override: 'off' }).enabled, false);
  assert.equal(decideNativeRawDecode({ info: { ...info, platform: 'linux-x86_64' }, parity, override: 'on' }).enabled, true, 'support override');
  // What ships: the deterministic libraw-wasm is not released, so no desktop decodes natively by default.
  assert.equal(NATIVE_RAW_PARITY.librawWasm, null);
  assert.equal(decideNativeRawDecode({ info }).enabled, false);
  assert.deepEqual([...NATIVE_RAW_PARITY.platforms], ['macos-aarch64', 'macos-x86_64']);
}

// --- the probe asks once and stays off outside the desktop app -----------------------
{
  resetNativeRawProbe();
  let asked = 0;
  const core = { invoke: async (command) => { asked++; assert.equal(command, 'native_raw_info'); return { available: true, platform: 'macos-aarch64' }; } };
  assert.equal((await probeNativeRawDecoder({ core, override: null })).enabled, false);
  assert.equal((await probeNativeRawDecoder({ core, override: 'on' })).enabled, false, 'cached per page');
  assert.equal(asked, 1);
  resetNativeRawProbe();
  assert.equal((await probeNativeRawDecoder({ core: null, override: null })).reason, 'not-desktop');
  const broken = { invoke: async () => { throw new Error('no such command'); } };
  assert.equal((await probeNativeRawDecoder({ core: broken, override: null })).reason, 'probe-failed');
  resetNativeRawProbe();
}

// --- createRawDecoder: WASM unless the gate says native ------------------------------
{
  const wasm = { kind: 'wasm' };
  assert.equal(await createRawDecoder(() => wasm, { core: null }), wasm);
  const off = async () => ({ enabled: false });
  assert.equal(await createRawDecoder(() => wasm, { core: {}, probe: off }), wasm);
  const on = async () => ({ enabled: true });
  const native = await createRawDecoder(() => wasm, { core: { invoke: async () => {} }, probe: on });
  assert.notEqual(native, wasm);
  assert.equal(typeof native.open, 'function');
  assert.equal(native.native, true);
}

// --- libraw-wasm's metadata() post-processing -------------------------------------------
{
  const meta = { width: 4, thumb_format: 1, desc: '  roll 7 ', timestamp: 1700000000, lens: { LensMake: 'Leica' } };
  const full = decorateNativeMetadata(meta, true);
  assert.equal(full.thumb_format, 'jpeg');
  assert.equal(full.desc, 'roll 7');
  assert.ok(full.timestamp instanceof Date && full.timestamp.getTime() === 1700000000000);
  assert.deepEqual(full.lens, { LensMake: 'Leica' });
  assert.equal(decorateNativeMetadata({ ...meta, thumb_format: 42 }, true).thumb_format, 'unknown');
  assert.equal('lens' in decorateNativeMetadata(meta, false), false, 'lens is part of the full output only');
  assert.equal(meta.thumb_format, 1, 'the stored object is not modified');
}

// --- the settings the shell reproduces: exactly the loader's, halfSize and outputBps ------------
{
  assert.deepEqual(nativeDecodeOptions(LOADER_SETTINGS), { halfSize: false, outputBps: 16 });
  assert.deepEqual(nativeDecodeOptions({ ...LOADER_SETTINGS, halfSize: true, outputBps: 8 }), { halfSize: true, outputBps: 8 });
  const { halfSize, ...withoutHalf } = LOADER_SETTINGS;
  assert.deepEqual(nativeDecodeOptions(withoutHalf), { halfSize: false, outputBps: 16 }, 'LibRaw\'s default half_size is 0');
  const { outputBps, ...withoutBps } = LOADER_SETTINGS;
  assert.equal(nativeDecodeOptions(withoutBps), null, 'LibRaw\'s default output is 8-bit: stated explicitly or WASM');
  const { useCameraWb, ...withoutCameraWb } = LOADER_SETTINGS;
  assert.equal(nativeDecodeOptions(withoutCameraWb), null, 'a missing fixed key keeps a different LibRaw default');
  for (const changed of [{ useAutoWb: false }, { useCameraMatrix: 1 }, { outputColor: 2 }, { noInterpolation: true },
    { outputBps: 12 }, { halfSize: 1 }, { userQual: 11 }, { highlight: 2 }, { bright: 1.5 }]) {
    assert.equal(nativeDecodeOptions({ ...LOADER_SETTINGS, ...changed }), null, JSON.stringify(changed));
  }
  assert.equal(nativeDecodeOptions(null), null);
  assert.equal(nativeDecodeOptions({}), null);
}

// --- other settings go straight to libraw-wasm, the shell never sees the file --------------------
{
  const calls = [];
  const core = { invoke: async (command) => { calls.push(command); return undefined; } };
  const wasmCalls = [];
  const wasm = {
    open: async (bytes, settings) => { wasmCalls.push(['open', bytes.length, settings.userQual]); },
    imageData: async () => ({ width: 1, height: 1, colors: 3, bits: 16, data: new Uint16Array(3) }),
    metadata: async () => ({ width: 1 }),
    dispose() {},
  };
  const raw = createNativeLibRaw({ core, createWasm: () => wasm });
  assert.equal(await raw.open(new Uint8Array(4), { ...LOADER_SETTINGS, userQual: 11 }), undefined);
  assert.deepEqual(calls, [], 'no native session');
  assert.deepEqual(wasmCalls, [['open', 4, 11]]);
  assert.equal(raw.native, false);
  assert.equal((await raw.imageData()).width, 1);
  raw.dispose();
}

// --- uploads: 8 MiB raw chunks, then open with the page's options -------------------------
{
  const calls = [];
  const core = {
    convertFileSrc: (path, protocol) => `${protocol}://localhost/${path}`,
    async invoke(command, args, options) {
      calls.push({ command, bytes: args instanceof Uint8Array ? args.length : null, headers: options?.headers || null, args: args instanceof Uint8Array ? null : args });
      if (command === 'native_raw_begin') return 'id1';
      if (command === 'native_raw_open') return { status: 'ok', code: 0, metadata: { width: 1, height: 1 } };
      return undefined;
    }
  };
  const bytes = new Uint8Array(NATIVE_RAW_UPLOAD_CHUNK_BYTES * 2 + 5);
  const raw = createNativeLibRaw({ core, createWasm: () => { throw new Error('no WASM'); } });
  assert.equal(await raw.open(bytes, { ...LOADER_SETTINGS, halfSize: true, outputBps: 8 }), undefined);
  assert.deepEqual(calls.map(call => call.command), ['native_raw_begin', 'native_raw_append', 'native_raw_append', 'native_raw_append', 'native_raw_open']);
  assert.deepEqual(calls[0].args, { expectedBytes: bytes.length });
  assert.deepEqual(calls.slice(1, 4).map(call => call.bytes), [NATIVE_RAW_UPLOAD_CHUNK_BYTES, NATIVE_RAW_UPLOAD_CHUNK_BYTES, 5]);
  assert.ok(calls.slice(1, 4).every(call => call.headers['x-raw-decode-id'] === 'id1'));
  assert.deepEqual(calls[4].args, { id: 'id1', halfSize: true, outputBps: 8 });
  assert.equal((await raw.metadata(true)).width, 1);
  raw.dispose();
  assert.equal(calls.at(-1).command, 'native_raw_release');
  await assert.rejects(raw.metadata(true), /LibRaw disposed/);
}

// --- dispose rejects a pending step at once, like libraw-wasm ------------------------------
{
  const core = {
    invoke: (command) => command === 'native_raw_begin' ? Promise.resolve('id2') : command === 'native_raw_release' ? Promise.resolve() : new Promise(() => {})
  };
  const raw = createNativeLibRaw({ core, createWasm: () => { throw new Error('no WASM'); } });
  const pending = raw.open(new Uint8Array(10), LOADER_SETTINGS);
  await new Promise(setImmediate);
  raw.dispose();
  await assert.rejects(pending, /LibRaw disposed/);
}

// --- plane reads ----------------------------------------------------------------------------
{
  const parts = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
  const fetchImpl = async (url) => new Response(parts[Number(/part=(\d)/.exec(url)[1])]);
  const buffer = await readNativePlane(['x?part=0', 'x?part=1'], 5, { fetchImpl });
  assert.deepEqual([...new Uint8Array(buffer)], [1, 2, 3, 4, 5]);
  await assert.rejects(readNativePlane(['x?part=0', 'x?part=1'], 6, { fetchImpl }), /5 of 6 bytes/);
  await assert.rejects(readNativePlane(['x?part=0', 'x?part=1'], 4, { fetchImpl }), /more bytes than announced/);
  await assert.rejects(readNativePlane(['x?part=0'], 3, { fetchImpl: async () => new Response(null, { status: 404 }) }), /answered 404/);
  await assert.rejects(readNativePlane(['x'], 3, { fetchImpl: async () => { throw new TypeError('Load failed'); } }), error => error.network === true);
}

// --- parts requested ahead: in order, at most `ahead` beyond the one being read ---------------
{
  const parts = [[1, 2], [3], [4, 5, 6], [7]].map((bytes) => new Uint8Array(bytes));
  for (const ahead of [0, 1, 2, 9]) {
    const started = [];
    let reading = -1;
    const fetchImpl = async (url) => {
      const index = Number(/part=(\d)/.exec(url)[1]);
      started.push(index);
      assert.ok(index <= reading + 1 + ahead, `ahead ${ahead}: part ${index} requested while part ${reading} was read`);
      // Later parts answer sooner, so an unordered read would show.
      await new Promise((resolve) => setTimeout(resolve, (parts.length - index) * 3));
      return new Response(new ReadableStream({
        pull(controller) {
          reading = Math.max(reading, index);
          controller.enqueue(parts[index]);
          controller.close();
        }
      }));
    };
    const buffer = await readNativePlane(parts.map((_, index) => `x?part=${index}`), 7, { fetchImpl, ahead });
    assert.deepEqual([...new Uint8Array(buffer)], [1, 2, 3, 4, 5, 6, 7], `ahead ${ahead}`);
    assert.deepEqual([...started].sort(), [0, 1, 2, 3]);
  }
  // A part requested ahead that fails is reported when its turn comes, as a
  // transfer error (not a scheme the worker cannot reach).
  let calls = 0;
  const failing = async (url) => {
    calls++;
    if (url.endsWith('part=1')) throw new TypeError('Load failed');
    return new Response(new Uint8Array([1]));
  };
  await assert.rejects(readNativePlane(['x?part=0', 'x?part=1'], 2, { fetchImpl: failing, ahead: 1 }), (error) => error.network === false && /fetch failed/.test(error.message));
  assert.equal(calls, 2);
}

// --- a shared plane where the realm is isolated, posted without a transfer list -------------
{
  const fetchImpl = async () => new Response(new Uint8Array([4, 2]));
  const plain = await readNativePlane(['x'], 2, { fetchImpl, shared: true });
  assert.ok(plain instanceof ArrayBuffer, 'not isolated: a plain buffer even when shared is asked for');
  const saved = globalThis.crossOriginIsolated;
  globalThis.crossOriginIsolated = true;
  try {
    const shared = await readNativePlane(['x'], 2, { fetchImpl, shared: true });
    assert.ok(shared instanceof SharedArrayBuffer);
    assert.deepEqual([...new Uint8Array(shared)], [4, 2]);
    assert.ok((await readNativePlane(['x'], 2, { fetchImpl })) instanceof ArrayBuffer, 'shared only when asked');
    const replies = [];
    await handleNativePlaneMessage({ type: 'read', id: 7, urls: ['x'], byteLength: 2, shared: true }, (message, transfer) => replies.push({ message, transfer }), { fetchImpl });
    assert.ok(replies[0].message.buffer instanceof SharedArrayBuffer);
    assert.deepEqual(replies[0].transfer, [], 'a shared buffer cannot be transferred');
    await handleNativePlaneMessage({ type: 'read', id: 8, urls: ['x'], byteLength: 2 }, (message, transfer) => replies.push({ message, transfer }), { fetchImpl });
    assert.deepEqual(replies[1].transfer, [replies[1].message.buffer], 'a plain plane is transferred');
  } finally {
    globalThis.crossOriginIsolated = saved;
  }
}

// --- a worker that cannot reach the scheme hands over to the page once ----------------------
{
  resetNativePlaneTransport();
  let workers = 0;
  const createWorker = () => {
    workers++;
    const worker = {
      terminate() {},
      postMessage() { queueMicrotask(() => worker.onmessage({ data: { type: 'error', message: 'Load failed', network: true } })); }
    };
    return worker;
  };
  const fetchImpl = async () => new Response(new Uint8Array([9, 9]));
  assert.deepEqual([...new Uint8Array(await fetchNativePlane(['x'], 2, { createWorker, fetchImpl, hasWorker: true }))], [9, 9]);
  assert.deepEqual([...new Uint8Array(await fetchNativePlane(['x'], 2, { createWorker, fetchImpl, hasWorker: true }))], [9, 9]);
  assert.equal(workers, 1, 'the second plane goes straight to the page');
  resetNativePlaneTransport();
}

console.log('nativeRawDecoder.test.mjs passed');
