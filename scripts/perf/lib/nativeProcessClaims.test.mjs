// Exercise the actual Python authority/ancestry checks with pure OS fakes.
// Its signal function is replaced before any request; no native signal runs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = String.raw`
import ctypes, json, runpy, sys, types
world = runpy.run_path(sys.argv[1])
answer = world['answer']
g = answer.__globals__
def proc(pid, path, parent=1, parent_unique='0'):
    return dict(pid=pid, path=path, parentPid=parent, parentUnique=parent_unique, unique=str(pid+100), version=7, uid=501)
root = proc(900000081, '/owned/launcher')
host = proc(900000082, '/owned/native-host', root['pid'], root['unique'])
other = proc(900000083, '/another/native-host')
gpu = proc(900000084, '/framework/com.apple.WebKit.GPU', root['pid'], root['unique'])
state = {p['pid']: dict(p) for p in [root, host, other, gpu]}
g['identity'] = lambda pid: state.get(pid)
g['subprocess'] = types.SimpleNamespace(run=lambda *args, **kwargs: types.SimpleNamespace(stdout='900000082 900000081\n900000083 1\n900000084 900000081\n'))
signals = []
def signal(token, number):
    audit = ctypes.cast(token, ctypes.POINTER(ctypes.c_uint32 * 8)).contents
    signals.append((audit[5], audit[7], number))
    return 0
g['lib'] = types.SimpleNamespace(proc_signal_with_audittoken=signal)
found = answer(dict(pids=[root['pid']], descendantsOf=root))
assert [p['chain'][0]['pid'] for p in found['descendants']] == [host['pid'], gpu['pid']]
def request(chain):
    return dict(pids=[p['pid'] for p in chain], expected=chain, ownedChain=chain, signal=dict(identity=chain[0], number=9))
assert answer(request([host, root]))['signalled']
assert signals == [(host['pid'], host['version'], 9)]
for key, value in [('version', 8), ('unique', 'reused'), ('parentUnique', 'unrelated'), ('parentPid', other['pid'])]:
    state[host['pid']] = {**host, key: value}
    assert not answer(request([host, root]))['signalled'], key
    assert len(signals) == 1
state[host['pid']] = host
state[root['pid']] = {**root, 'version': 8}
assert not answer(request([host, root]))['signalled']
assert answer(dict(pids=[root['pid']], descendantsOf=root))['descendants'] == []
state[root['pid']] = root
assert not answer(request([gpu, root]))['signalled'], 'ancestry alone never authorizes WebKit endpoint signals'
assert not answer(request([other, root]))['signalled'], 'a separate owned instance is not this launcher descendant'
assert len(signals) == 1
print('native process claims: current version, unique identity, ancestry, kernel token and unrelated/shared exclusions passed (pure OS data)')
`;
const result = spawnSync('python3', ['-c', script, fileURLToPath(new URL('../native/process-metadata.py', import.meta.url))],
  { encoding: 'utf8', timeout: 5000, input: '' });
assert.equal(result.status, 0, result.stderr || result.error?.message);
console.log(result.stdout.trim());
