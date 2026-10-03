// Harness-only native evidence. No coalition or global-freshness heuristic.
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const nativeDir = fileURLToPath(new URL('../native/', import.meta.url));
const metadataScript = join(nativeDir, 'process-metadata.py');
const identityKeys = ['pid', 'unique', 'version', 'uid', 'path'];
export const sameProcess = (a, b) => Boolean(a && b && identityKeys.every(key => a[key] === b[key]));

export function processMetadata(pids, extra = {}) {
  if (process.platform !== 'darwin') return {};
  try {
    return JSON.parse(execFileSync('python3', [metadataScript], {
      input: JSON.stringify({ pids: [...new Set(pids)], ...extra }) + '\n', encoding: 'utf8', timeout: 2000,
      stdio: ['pipe', 'pipe', 'ignore']
    }));
  } catch { return {}; }
}

export async function buildWebKitObserver(outDir) {
  const library = join(outDir, 'webkit-association.dylib');
  await run('xcrun', ['clang', '-dynamiclib', '-fobjc-arc', '-O2', '-framework', 'AppKit', '-framework', 'WebKit',
    join(nativeDir, 'webkit-association.m'), '-o', library], { timeout: 60_000 });
  return library;
}

function ownedDescendant(snapshot, root, current) {
  const chain = [snapshot.owner, ...(snapshot.ancestors || [])];
  const end = chain.findIndex(entry => sameProcess(entry, root));
  if (end < 0) return false;
  for (let i = 0; i <= end; i++) {
    if (!sameProcess(chain[i], current[chain[i].pid])) return false;
    if (i < end && (chain[i].parentPid !== chain[i + 1].pid || chain[i].parentUnique !== chain[i + 1].unique
        || current[chain[i].pid].parentPid !== chain[i + 1].pid || current[chain[i].pid].parentUnique !== chain[i + 1].unique)) return false;
  }
  return true;
}

/** A view's explicit renderer/GPU endpoints must belong to the bound child.
 * XPC one-shot UUIDs prove separate service instances; native PID versions
 * bind those endpoints to the current OS processes rather than PID numbers.
 */
export function verifiedWebKitAssociation(snapshot, { root, current, port }) {
  if (!root || snapshot?.source !== 'wkwebview+xpc-oneshot' || snapshot.port !== port
      || !ownedDescendant(snapshot, root, current) || snapshot.views?.length !== 1) return null;
  const { renderer, gpu } = snapshot.views[0];
  for (const [endpoint, kind] of [[renderer, 'WebContent'], [gpu, 'GPU']]) {
    if (!endpoint || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(endpoint.instance || '')
        || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(endpoint.instance)
        || !sameProcess(endpoint.identity, current[endpoint.identity?.pid])
        || !endpoint.identity.path.endsWith(`/com.apple.WebKit.${kind}`)
        || endpoint.auditToken?.length !== 8 || endpoint.auditToken[5] !== endpoint.identity.pid
        || endpoint.auditToken[7] !== endpoint.identity.version) return null;
  }
  if (renderer.instance === gpu.instance || renderer.identity.pid === gpu.identity.pid) return null;
  return { owner: snapshot.owner, renderer, gpu };
}

export class WebKitOwnership {
  constructor({ library, file, port, metadata = processMetadata, read = readFileSync, write = writeFileSync } = {}) {
    this.library = library; this.file = file; this.port = port; this.metadata = metadata; this.read = read;
    this.root = null; this.child = null; this.association = null; this.cleanupAttempts = [];
    write(file, '', { flag: 'wx', mode: 0o600 });
  }

  environment() {
    return { DYLD_INSERT_LIBRARIES: this.library, NC_PERF_OWNERSHIP_LOG: this.file, NC_PERF_OWNERSHIP_PORT: String(this.port) };
  }

  bindProcess(child) {
    this.child = child;
    this.root = this.metadata([child.pid])[child.pid] || null;
  }

  resolve() {
    this.association = null;
    if (!this.root) return null;
    let snapshots;
    try {
      const text = this.read(this.file, 'utf8');
      // A partial last write is never evidence. Keep the latest state of each
      // producer, including a later empty state that revokes its association.
      const latest = new Map();
      for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean)) {
        const item = JSON.parse(line);
        latest.set(`${item.owner?.pid}:${item.owner?.unique}`, item);
      }
      snapshots = [...latest.values()];
    } catch { return null; }
    const pids = [this.root.pid, ...snapshots.flatMap(item => [item.owner?.pid,
      ...(item.ancestors || []).map(p => p.pid), ...(item.views || []).flatMap(view => [view.renderer?.identity?.pid, view.gpu?.identity?.pid])])]
      .filter(pid => Number.isInteger(pid) && pid > 1);
    const current = this.metadata(pids);
    const associations = snapshots.map(snapshot => verifiedWebKitAssociation(snapshot, { root: this.root, current, port: this.port })).filter(Boolean);
    if (associations.length === 1) this.association = associations[0];
    return this.association;
  }

  kill(pid, number = 9) {
    const association = this.resolve();
    const endpoint = [association?.renderer, association?.gpu].find(p => p?.identity.pid === pid);
    if (!endpoint) return false;
    const expected = [this.root, association.owner, endpoint.identity];
    const result = this.metadata(expected.map(p => p.pid), {
      expected, signal: { ...endpoint, number }
    });
    this.cleanupAttempts.push({ pid, number, ...result });
    return result.signalled === true;
  }

  killOwnedProcess(signal = 'SIGKILL') {
    if (!this.child || this.child.exitCode !== null || !sameProcess(this.root, this.metadata([this.root?.pid])[this.root?.pid])) return false;
    try { process.kill(-this.child.pid, signal); return true; } catch { return false; }
  }
}
