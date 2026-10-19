#!/usr/bin/env python3
"""Prepare locally, then sign/install/validate from a working macOS terminal.

Uses a private copy of the committed Xcode project and a frozen Rust library.
No simulator download, modified Xcode installation, command shim or daemon.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import struct
import subprocess
import sys
import time
import uuid
import zlib

ROOT = Path(__file__).resolve().parents[1]
BUNDLE = 'com.neoanaloglab.negativeconverter'
TEAM = 'X93Y44J36C'
FIXTURES = [('negative-sample.jpg', 'image/jpeg'), ('negative-sample.heic', 'image/heic'),
            ('_DSC3111.NEF', 'image/x-nikon-nef'), ('_DSC5290.dng', 'image/x-adobe-dng')]
STORE = f'Library/Application Support/{BUNDLE}/mobile-recovery-v1'


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for data in iter(lambda: f.read(1024 * 1024), b''):
            h.update(data)
    return h.hexdigest()


def run(args, *, log=None, env=None, capture=False):
    print('+', ' '.join(str(a) for a in args), flush=True)
    if log:
        with Path(log).open('w') as f:
            result = subprocess.run(args, cwd=ROOT, env=env, stdout=f, stderr=subprocess.STDOUT)
        if result.returncode:
            print(Path(log).read_text(errors='replace')[-8000:], flush=True)
            raise RuntimeError(f'Command failed ({result.returncode}); see {log}')
        return ''
    result = subprocess.run(args, cwd=ROOT, env=env, capture_output=capture, text=True, check=True)
    return result.stdout if capture else ''


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2) + '\n')


def require_space(gib):
    free = shutil.disk_usage(ROOT).free / 1024 ** 3
    if free < gib:
        raise RuntimeError(f'{free:.1f} GiB free; at least {gib} GiB required. No files were cleaned.')


def clone(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    # APFS clone keeps the large library snapshot independent without a second allocation.
    run(['/bin/cp', '-c', str(source), str(destination)])


def prepare(out, retry_from=None):
    require_space(3)
    if out.exists():
        raise RuntimeError('Choose a new output directory; existing evidence will not be replaced')
    out.mkdir(parents=True)
    source_paths = ['negative2positive/src/app/main.js', 'negative2positive/src/app/p0SelfTest.js',
                    'negative2positive/src/app/p0DeviceRecovery.js', 'scripts/ios-device-validation.py',
                    'src-tauri/Cargo.lock']
    source_hashes = {p: digest(ROOT / p) for p in source_paths}
    fixture_dir = ROOT / 'negative2positive/public/p0-fixtures'
    sources = []
    for name, mime in FIXTURES:
        path = fixture_dir / name
        sources.append({'name': name, 'mimeType': mime, 'size': path.stat().st_size, 'sha256': digest(path)})
    retry = None
    if retry_from:
        previous = json.loads((retry_from.parent / 'manifest.json').read_text())
        before = json.loads((retry_from / 'apps-before.json').read_text())['result']
        after = json.loads((retry_from / 'apps-after.json').read_text())['result']
        previous_events = json.loads((retry_from / 'before-events.json').read_text())
        assert before['apps'] == [], 'A retry must originate from our fresh fixture installation'
        assert previous['sources'] == sources, 'Retry fixtures changed'
        assert any(e.get('id') == previous['id'] and e['event'] == 'device-recovery-failed' for e in previous_events)
        assert len(after['apps']) == 1 and after['apps'][0]['bundleIdentifier'] == BUNDLE
        retry = {'id': previous['id'], 'deviceIdentifier': after['deviceIdentifier'],
                 'installationURL': after['apps'][0]['url'], 'evidence': str(retry_from)}
    test_id = 'device-' + uuid.uuid4().hex[:20]
    plan_path = fixture_dir / 'plan.json'
    previous_plan = plan_path.read_bytes() if plan_path.exists() else None
    env = {**os.environ, 'NC_P0_FIXTURES': '1', 'CARGO_BUILD_JOBS': '3', 'CARGO_INCREMENTAL': '0'}
    try:
        write_json(plan_path, {'deviceRecovery': test_id, 'retryOf': retry['id'] if retry else None,
                   'timeoutMs': 120000,
                   'fixtures': [{'file': s['name'], 'type': s['mimeType'], 'size': s['size']} for s in sources]})
        run(['npm', 'run', 'build:web'], log=out / 'web-build.log', env=env)
    finally:
        if previous_plan is not None:
            plan_path.write_bytes(previous_plan)
        elif plan_path.exists():
            plan_path.unlink()
    # Retain only this run's fixtures in generated output. Originals in public/
    # are never removed, and unused 60 MP data need not bloat Rust's asset table.
    keep = {name for name, _ in FIXTURES} | {'plan.json'}
    for built in [ROOT / 'negative2positive/dist/p0-fixtures', ROOT / 'dist/p0-fixtures']:
        for path in built.iterdir():
            if path.is_file() and not path.is_symlink() and path.name not in keep:
                path.unlink()
    # custom-protocol is the same feature added by tauri ios build. A plain
    # cargo build would point at the development server instead of bundling assets.
    # Xcode consumes only a static library. Avoid also emitting a large rlib and
    # dylib from the desktop manifest's crate-type list on disk-limited Macs.
    run(['cargo', 'rustc', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--offline',
         '--lib', '--crate-type', 'staticlib', '--target', 'aarch64-apple-ios', '--features', 'tauri/custom-protocol'],
        log=out / 'native-build.log', env=env)
    require_space(1.5)
    generated = ROOT / 'src-tauri/gen/apple'
    project = out / 'apple'
    project.mkdir()
    for name in ['Sources', 'Assets.xcassets', 'negative-converter_iOS', 'negative-converter.xcodeproj', 'assets']:
        shutil.copytree(generated / name, project / name,
                        ignore=shutil.ignore_patterns('xcuserdata', '*.xcuserstate'))
    shutil.copy2(generated / 'LaunchScreen.storyboard', project / 'LaunchScreen.storyboard')
    library = ROOT / 'src-tauri/target/aarch64-apple-ios/debug/libnegative_converter_lib.a'
    frozen = project / 'Externals/arm64/debug/libapp.a'
    clone(library, frozen)
    library_hash = digest(frozen)
    pbx_path = project / 'negative-converter.xcodeproj/project.pbxproj'
    pbx = pbx_path.read_text()
    check = 'set -eu\n/usr/bin/shasum -a 256 "${SRCROOT}/Externals/arm64/debug/libapp.a" | /usr/bin/grep -q "^' + library_hash + ' "\n'
    pbx, replacements = re.subn(r'shellScript = "(?:[^"\\]|\\.)*";',
                                lambda _: 'shellScript = ' + json.dumps(check) + ';', pbx)
    if replacements != 1:
        raise RuntimeError('Expected exactly one Rust build phase in the copied Xcode project')
    pbx_path.write_text(pbx.replace('name = "Build Rust Code";', 'name = "Verify prepared Rust library";'))
    info_path = project / 'negative-converter_iOS/Info.plist'
    info = plistlib.loads(info_path.read_bytes())
    for path in [ROOT / 'src-tauri/Info.plist', ROOT / 'src-tauri/Info.ios.plist']:
        if path.exists():
            info.update(plistlib.loads(path.read_bytes()))
    head = run(['git', 'rev-parse', 'HEAD'], capture=True).strip()
    info.update(NCValidationBuild=test_id, NCSourceCommit=head)
    info_path.write_bytes(plistlib.dumps(info))
    patch = run(['git', 'diff', '--binary', 'HEAD'], capture=True)
    (out / 'source-changes.patch').write_text(patch)
    if source_hashes != {p: digest(ROOT / p) for p in source_paths}:
        raise RuntimeError('Sources changed during preparation; choose a new output directory and rebuild')
    shutil.copy2(ROOT / 'negative2positive/src/app/p0DeviceRecovery.js', out / 'p0DeviceRecovery.js')
    write_json(out / 'manifest.json', {'id': test_id, 'head': head, 'sourcePatchSha256': digest(out / 'source-changes.patch'),
        'sourceHashes': source_hashes, 'librarySha256': library_hash, 'sources': sources, 'retry': retry,
        'preparedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'purpose': 'Development signing and physical iPhone validation only; no upload or release.'})
    # Restore normal distributable web output after freezing the test library.
    run(['npm', 'run', 'build:web'], log=out / 'web-normal-build.log')
    print(f'PREPARED: {out}', flush=True)


def events(path):
    collected, parts = [], []
    if not path.exists():
        return collected
    for line in path.read_text(errors='replace').splitlines():
        match = re.search(r'\[webview\] P0 (\d+) (\d+)/(\d+) (.*)$', line)
        if not match:
            continue
        _, number, total, content = match.groups()
        number, total = int(number), int(total)
        if number == 1:
            parts = []
        if number != len(parts) + 1:
            parts = []
            continue
        parts.append(content)
        if number == total:
            try:
                collected.append(json.loads(''.join(parts)))
            except json.JSONDecodeError:
                pass
            parts = []
    return collected


def verify_store(path, manifest):
    checkpoints = [json.loads(p.read_text()) for p in path.glob('checkpoint-*.json')]
    if not checkpoints:
        raise RuntimeError('No native checkpoints were copied from the device')
    checkpoint = max(checkpoints, key=lambda c: c['revision'])
    project = json.loads(checkpoint['project'])
    assert len(checkpoint['sourceIds']) == len(manifest['sources'])
    assert len(set(checkpoint['queueIds'])) == len(manifest['sources'])
    assert checkpoint['activeIndex'] == 1
    assert project['files'][0]['settings']['coreExposure'] == 17
    assert project['files'][1]['settings']['coreExposure'] == 31
    for source_id, expected in zip(checkpoint['sourceIds'], manifest['sources']):
        assert re.fullmatch('[a-f0-9]{32}', source_id)
        source = path / 'sources' / (source_id + '.bin')
        metadata = json.loads((path / 'sources' / (source_id + '.json')).read_text())
        assert source.stat().st_size == expected['size'] == metadata['size']
        assert digest(source) == expected['sha256'] == metadata['sha256']
        assert metadata['name'] == expected['name']
    return checkpoint


def verify_retry_store(path, manifest):
    """Only our exact fixture bytes may be replaced, after copying both generations."""
    expected = {s['name']: s for s in manifest['sources']}
    checkpoint_paths = list(path.glob('checkpoint-*.json'))
    assert checkpoint_paths, 'No backed-up checkpoint; refusing a retry'
    assert not list((path / 'sources').glob('*.part')), 'Original copying is still incomplete'
    known_ids = set()
    for metadata_path in (path / 'sources').glob('*.json'):
        metadata = json.loads(metadata_path.read_text())
        wanted = expected.get(metadata['name'])
        assert wanted, 'A non-fixture original is present; preserving the current roll'
        source = metadata_path.with_suffix('.bin')
        assert re.fullmatch('[a-f0-9]{32}', metadata_path.stem)
        assert source.stat().st_size == metadata['size'] == wanted['size']
        assert digest(source) == metadata['sha256'] == wanted['sha256'], 'Original is not the bundled fixture'
        known_ids.add(metadata_path.stem)
    assert known_ids and {p.stem for p in (path / 'sources').glob('*.bin')} == known_ids
    checkpoints = [json.loads(p.read_text()) for p in checkpoint_paths]
    for checkpoint in checkpoints:
        assert set(checkpoint['sourceIds']) <= known_ids
        project = json.loads(checkpoint['project'])
        assert len(project['files']) == len(checkpoint['sourceIds'])
    return max(checkpoints, key=lambda c: c['revision'])


def png_facts(path):
    # Independently check the exported file's complete PNG chunk CRCs and
    # decompress IDAT incrementally (bounded output) to catch truncated output.
    decoded = 0
    inflater = zlib.decompressobj()
    info = None
    with path.open('rb') as f:
        assert f.read(8) == b'\x89PNG\r\n\x1a\n', f'Invalid PNG: {path}'
        while True:
            header = f.read(8)
            assert len(header) == 8, f'Truncated PNG: {path}'
            length, kind = struct.unpack('>I4s', header)
            assert length <= path.stat().st_size
            crc = zlib.crc32(kind)
            remaining = length
            data_header = b''
            while remaining:
                data = f.read(min(128 * 1024, remaining))
                assert data
                remaining -= len(data)
                crc = zlib.crc32(data, crc)
                if kind == b'IHDR':
                    data_header += data
                if kind == b'IDAT':
                    while data:
                        decoded += len(inflater.decompress(data, 1024 * 1024))
                        data = inflater.unconsumed_tail
                        assert decoded <= 600 * 1024 ** 2
            assert f.read(4) == struct.pack('>I', crc & 0xffffffff), f'Bad CRC: {path}'
            if kind == b'IHDR':
                assert length == 13
                w, h, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', data_header)
                assert compression == filtering == interlace == 0
                channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
                assert depth in ({1, 2, 4, 8, 16} if color == 0 else {1, 2, 4, 8} if color == 3 else {8, 16})
                assert w > 0 and h > 0
                info = {'name': path.name, 'width': w, 'height': h, 'bitDepth': depth,
                        'decodedBytes': h * (1 + (w * channels * depth + 7) // 8)}
            if kind == b'IEND':
                assert inflater.eof and not f.read(1)
                break
    assert info and decoded == info['decodedBytes'], f'Incomplete pixels: {path}'
    return {**info, 'sha256': digest(path)}


def execute(out, device):
    manifest = json.loads((out / 'manifest.json').read_text())
    frozen = out / 'apple/Externals/arm64/debug/libapp.a'
    if digest(frozen) != manifest['librarySha256']:
        raise RuntimeError('Prepared native library changed; refusing to install')
    require_space(1.5)
    evidence = out / ('run-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
    evidence.mkdir()

    def device_command(args, name, timeout=60):
        result_path = evidence / (name + '.json')
        run(['xcrun', 'devicectl', '--timeout', str(timeout), '--json-output', str(result_path),
             'device', *args[:2], '--device', device, *args[2:]], log=evidence / (name + '.log'))
        return json.loads(result_path.read_text())

    def copy_from(source, destination, name):
        destination.parent.mkdir(parents=True, exist_ok=True)
        device_command(['copy', 'from', '--domain-type', 'appDataContainer', '--domain-identifier', BUNDLE,
                        '--source', source, '--destination', str(destination)], name, timeout=180)

    def launch(name, self_test=False):
        args = ['process', 'launch', '--terminate-existing']
        if self_test:
            args += ['--environment-variables', json.dumps({'NC_P0_SELFTEST': '1'})]
        args.append(BUNDLE)
        result = device_command(args, name)
        return result.get('result', {}).get('process', {}).get('processIdentifier')

    def wait_event(wanted, prefix):
        target = evidence / (prefix + '-diagnostics.log')
        start = time.monotonic()
        while time.monotonic() - start < 600:
            try:
                copy_from('Documents/p0-diagnostics.log', target, prefix + '-copy-log')
            except (subprocess.CalledProcessError, RuntimeError):
                time.sleep(3)
                continue
            parsed = events(target)
            write_json(evidence / (prefix + '-events.json'), parsed)
            matching = [e for e in parsed if e.get('id') == manifest['id']]
            failures = [e for e in matching if e['event'] in ['device-recovery-failed', 'device-recovery-blocked']]
            if failures:
                # Keep native data and actual exports even when a DOM assertion fails.
                for source, destination in [(STORE, 'store'), ('Documents', 'Documents')]:
                    try:
                        copy_from(source, evidence / 'failure' / destination, 'failure-copy-' + destination)
                    except (subprocess.CalledProcessError, RuntimeError):
                        pass
                write_json(evidence / 'result.json', {'installed': True, 'wholeAppRecovery': 'failed', 'failure': failures[-1]})
                raise RuntimeError(str(failures[-1]))
            done = [e for e in matching if e['event'] == wanted]
            if done:
                return parsed
            time.sleep(3)
        raise RuntimeError(f'Timed out waiting for {wanted}; keep the phone unlocked and inspect {target}')

    device_command(['info', 'details'], 'device')
    apps = device_command(['info', 'apps', '--bundle-id', BUNDLE], 'apps-before')
    installed = apps.get('result', {}).get('apps')
    if not isinstance(installed, list):
        raise RuntimeError('Unrecognized installed-app response; refusing an automatic data-changing test')
    retry = manifest.get('retry')
    baseline_exports = []
    if installed and retry:
        assert apps['result']['deviceIdentifier'] == retry['deviceIdentifier'], 'Retry device changed'
        assert len(installed) == 1 and installed[0]['url'] == retry['installationURL'], 'The previous test installation changed'
        copy_from(STORE, evidence / 'retry-backup/store', 'retry-copy-store')
        copy_from('Documents', evidence / 'retry-backup/Documents', 'retry-copy-documents')
        verify_retry_store(evidence / 'retry-backup/store', manifest)
        baseline_exports = [png_facts(p) for p in (evidence / 'retry-backup/Documents').rglob('*.png')]
        write_json(evidence / 'retry-backup/verified.json', {'previousId': retry['id'],
                   'originals': 'all bytes match bundled fixtures', 'exports': baseline_exports})
    project = out / 'apple/negative-converter.xcodeproj'
    run(['xcodebuild', '-project', str(project), '-scheme', 'negative-converter_iOS',
         '-configuration', 'debug', '-sdk', 'iphoneos', '-destination', 'generic/platform=iOS',
         '-derivedDataPath', str(out / 'DerivedData'), '-allowProvisioningUpdates',
         'CODE_SIGN_STYLE=Automatic', f'DEVELOPMENT_TEAM={TEAM}', 'build'], log=evidence / 'xcode-build.log')
    candidates = list((out / 'DerivedData/Build/Products/debug-iphoneos').glob('*.app'))
    candidates = [p for p in candidates if plistlib.loads((p / 'Info.plist').read_bytes()).get('CFBundleIdentifier') == BUNDLE]
    assert len(candidates) == 1, 'Expected one built app with the requested bundle identifier'
    app = candidates[0]
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    assert info['CFBundleIdentifier'] == BUNDLE and info['NCValidationBuild'] == manifest['id']
    run(['codesign', '--verify', '--deep', '--strict', str(app)], log=evidence / 'codesign-verify.log')
    # Inspect only non-secret profile fields; never print/store the profile or private key.
    profile = plistlib.loads(subprocess.check_output(['security', 'cms', '-D', '-i', str(app / 'embedded.mobileprovision')]))
    assert device in profile.get('ProvisionedDevices', []), 'The signing profile does not include this device'
    assert profile['Entitlements']['application-identifier'] == TEAM + '.' + BUNDLE
    assert profile['Entitlements'].get('get-task-allow') is True
    device_command(['install', 'app', str(app)], 'install', timeout=180)
    device_command(['info', 'apps', '--bundle-id', BUNDLE], 'apps-after')
    if installed and not retry:
        launch('launch-existing')
        write_json(evidence / 'result.json', {'installed': True, 'automatedValidation': 'skipped',
                    'reason': 'Existing installation preserved; test fixtures were not imported.'})
        print(f'INSTALLED. Existing data preserved; automatic fixture test skipped. Evidence: {evidence}', flush=True)
        return
    first_pid = launch('launch-prepare', self_test=True)
    before_events = wait_event('device-recovery-prepared', 'before')
    copy_from(STORE, evidence / 'before/store', 'copy-store-before')
    copy_from('Documents', evidence / 'before/Documents', 'copy-documents-before')
    before = verify_store(evidence / 'before/store', manifest)
    exports = [png_facts(p) for p in (evidence / 'before/Documents').rglob('*.png')]
    old_exports = {(p['name'], p['sha256']) for p in baseline_exports}
    new_exports = [p for p in exports if (p['name'], p['sha256']) not in old_exports]
    assert len(new_exports) >= len(FIXTURES), 'Some actual export files from this run are missing'
    assert isinstance(first_pid, int) and first_pid > 1, 'No verified app PID; refusing to signal a process'
    device_command(['process', 'signal', '--pid', str(first_pid), '--signal', 'SIGKILL'], 'terminate-app')
    second_pid = launch('launch-restore', self_test=True)
    assert isinstance(second_pid, int) and second_pid != first_pid
    after_events = wait_event('device-recovery-pass', 'after')
    copy_from(STORE, evidence / 'after/store', 'copy-store-after')
    copy_from('Documents', evidence / 'after/Documents', 'copy-documents-after')
    after = verify_store(evidence / 'after/store', manifest)
    assert before['sourceIds'] == after['sourceIds'] and before['queueIds'] == after['queueIds']
    after_exports = [png_facts(p) for p in (evidence / 'after/Documents').rglob('*.png')]
    assert len(after_exports) > len(exports), 'No additional export was written after restore'
    device_command(['info', 'processes'], 'processes-after')
    write_json(evidence / 'result.json', {'installed': True, 'wholeAppRecovery': 'passed',
        'sourceHashes': 'matched bundled fixtures before and after process termination',
        'recipeExposure': [17, 31], 'activeIndex': 1, 'beforePid': first_pid, 'afterPid': second_pid,
        'exportsBefore': exports, 'exportsAfter': after_exports,
        'pending': ['Manual touch/rotation/background validation', 'Separate WebContent termination', 'Physical iPad']})
    print(f'PHYSICAL IPHONE IMPORT/EXPORT + WHOLE-APP RECOVERY PASS. Evidence: {evidence}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['prepare', 'run'])
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--device')
    parser.add_argument('--retry-from', type=Path, help='Failed fresh-install run whose exact fixture data may be backed up and retried')
    args = parser.parse_args()
    out = args.output.expanduser().resolve()
    if args.mode == 'prepare':
        prepare(out, args.retry_from.expanduser().resolve() if args.retry_from else None)
    else:
        if not args.device:
            parser.error('--device is required for signing and installation')
        execute(out, args.device)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'STOPPED: {error}', file=sys.stderr, flush=True)
        raise SystemExit(1)
