"""Developer harness only: exact-size private libproc identity and safe signal.

The kernel checks an XPC peer's audit-token PID version when signalling, so
PID reuse between this metadata recheck and the signal cannot hit a new PID.
"""
import ctypes
import json
import os
import sys

lib = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
lib.proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]

class Unique(ctypes.Structure):
    _fields_ = [('uuid', ctypes.c_uint8 * 16), ('unique', ctypes.c_uint64),
               ('parent_unique', ctypes.c_uint64), ('version', ctypes.c_int32),
               ('parent_version', ctypes.c_int32), ('reserved', ctypes.c_uint64 * 2)]

class Bsd(ctypes.Structure):
    _fields_ = [('words', ctypes.c_uint32 * 12), ('comm', ctypes.c_char * 16),
               ('name', ctypes.c_char * 32), ('tail', ctypes.c_uint32 * 6),
               ('start', ctypes.c_uint64 * 2)]

def identity(pid):
    unique, again, bsd, path = Unique(), Unique(), Bsd(), ctypes.create_string_buffer(4096)
    if pid <= 1 or ctypes.sizeof(unique) != 56:
        return None
    if lib.proc_pidinfo(pid, 17, 0, ctypes.byref(unique), 56) != 56:
        return None
    if lib.proc_pidinfo(pid, 3, 0, ctypes.byref(bsd), ctypes.sizeof(bsd)) != ctypes.sizeof(bsd):
        return None
    if lib.proc_pidpath(pid, path, len(path)) <= 0:
        return None
    if lib.proc_pidinfo(pid, 17, 0, ctypes.byref(again), 56) != 56:
        return None
    if (unique.unique, unique.version) != (again.unique, again.version) or not unique.unique or bsd.words[5] != os.geteuid():
        return None
    return {'pid': pid, 'unique': str(unique.unique), 'version': unique.version,
            'parentUnique': str(unique.parent_unique), 'parentPid': bsd.words[4],
            'uid': bsd.words[5], 'path': path.value.decode('utf-8')}

def answer(request):
    metadata = {str(pid): identity(pid) for pid in request['pids']}
    target = request.get('signal')
    if target:
        current = metadata.get(str(target['identity']['pid']))
        # The caller supplies the proven owner and peer together; recheck both
        # identities here immediately before the kernel's versioned signal.
        expected = request['expected']
        keys = ('pid', 'unique', 'version', 'uid', 'path')
        valid = all(metadata.get(str(item['pid'])) and all(metadata[str(item['pid'])][k] == item[k] for k in keys) for item in expected)
        token = target['auditToken']
        valid = valid and current and len(token) == 8 and token[5] == current['pid'] and token[7] == current['version']
        if valid:
            audit = (ctypes.c_uint32 * 8)(*token)
            lib.proc_signal_with_audittoken.argtypes = [ctypes.c_void_p, ctypes.c_int]
            result = lib.proc_signal_with_audittoken(ctypes.byref(audit), target['number'])
            return {'signalled': result == 0, 'signalErrno': result}
        return {'signalled': False, 'validation': 'identity-mismatch'}
    return metadata

for line in sys.stdin:
    try:
        print(json.dumps(answer(json.loads(line))), flush=True)
    except Exception as error:
        print(json.dumps({'error': str(error)}), flush=True)
