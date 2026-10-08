// Test-only (#278): the installed @neoanaloglabkk/lensfun-wasm in Node. Its
// core targets web and worker only, so its factory runs as a script and is
// handed the wasm and the data package a browser would fetch; the client is
// the package's own createLensfun. Never imported by the app.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = '@neoanaloglabkk/lensfun-wasm';
const resolvePath = specifier => fileURLToPath(import.meta.resolve(specifier));

/** The installed release's version (from dist/esm/index.js up to its package.json). */
export function lensfunPackageVersion() {
  const root = join(dirname(resolvePath(PACKAGE)), '..', '..');
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
}

/** Whether `version` (x.y.z) is at least `minimum`. */
export function versionAtLeast(version, minimum) {
  const a = String(version).split('.').map(Number);
  const b = String(minimum).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

/**
 * A LensfunClient of the installed release, and what its core printed to
 * stderr (`errors`).
 */
export async function lensfunNodeClient() {
  const api = await import(PACKAGE);
  const factory = new Function(`${readFileSync(resolvePath(`${PACKAGE}/core`), 'utf8')}\nreturn createLensfunCoreModule;`)();
  const wasm = new Uint8Array(readFileSync(resolvePath(`${PACKAGE}/core-wasm`)));
  const data = new Uint8Array(readFileSync(resolvePath(`${PACKAGE}/core-data`)));
  const errors = [];
  const client = await api.createLensfun({
    moduleFactory: options => factory({
      ...options,
      printErr: message => errors.push(message),
      instantiateWasm(imports, receive) {
        WebAssembly.instantiate(wasm, imports).then(({ instance, module }) => receive(instance, module));
        return {};
      },
      getPreloadedPackage: () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    })
  });
  return { api, client, errors };
}
