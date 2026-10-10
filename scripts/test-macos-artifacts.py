#!/usr/bin/env python3
"""Exercise real codesign, DMG and tar payloads, including the old signing order."""

import importlib.util
import plistlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path


if sys.platform != "darwin":
    sys.exit("macOS is required for the artifact signing regression test")

spec = importlib.util.spec_from_file_location("verify", Path(__file__).with_name("verify-macos-artifacts.py"))
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


def package(source, output, label):
    dmg = output / f"{label}.dmg"
    archive = output / f"{label}.app.tar.gz"
    verify.run("hdiutil", "create", "-quiet", "-format", "UDZO", "-fs", "HFS+", "-volname",
               "Signing regression", "-srcfolder", str(source), str(dmg))
    with tarfile.open(archive, "w:gz") as stream:
        for child in source.iterdir():
            stream.add(child, arcname=child.name)
    return [dmg, archive]


def rejected(artifact, reason):
    try:
        verify.verify_artifact(artifact, require_adhoc=True)
    except RuntimeError as error:
        if reason not in str(error):
            raise AssertionError(f"Unexpected failure: {error}") from error
    else:
        raise AssertionError(f"Accepted invalid payload: {artifact}")


with tempfile.TemporaryDirectory(prefix="nc-signature-test-") as scratch:
    root = Path(scratch)
    source = root / "source"
    app = source / "Signing Fixture.app"
    contents = app / "Contents"
    (contents / "MacOS").mkdir(parents=True)
    (contents / "Resources").mkdir()
    binary = contents / "MacOS/fixture"
    # Copy bytes, not the protected system binary's filesystem flags.
    standalone = root / "standalone-fixture"
    shutil.copyfile("/usr/bin/true", standalone)
    standalone.chmod(0o755)
    verify.run("codesign", "--remove-signature", str(standalone))
    # Sign outside the bundle: codesign can locate and sign the enclosing app
    # when given Contents/MacOS/fixture, which would not reproduce this bug.
    verify.run("codesign", "--force", "--sign", "-", str(standalone))
    assert "Signature=adhoc" in verify.run("codesign", "--display", "--verbose=4", str(standalone))
    shutil.move(standalone, binary)
    with (contents / "Info.plist").open("wb") as stream:
        plistlib.dump({
            "CFBundleExecutable": "fixture", "CFBundlePackageType": "APPL",
            "CFBundleIdentifier": "com.neoanaloglab.signing-fixture",
            "CFBundleName": "Signing Fixture", "CFBundleVersion": "1",
            "CFBundleShortVersionString": "1.0.0",
        }, stream)
    resource = contents / "Resources/example.txt"
    resource.write_text("original resource\n")

    # Reproduce the broken release order: packaging first, then signing only
    # the loose app. Both distributables must still be rejected.
    unsigned = package(source, root, "before-signing")
    verify.run("codesign", "--force", "--sign", "-", str(app))
    verify.run("codesign", "--verify", "--deep", "--strict", str(app))
    for artifact in unsigned:
        rejected(artifact, "missing bundle resource signature")
    print("PASS: signing the loose app after packaging does not repair either artifact")

    signed = package(source, root, "signed")
    receipts = [verify.verify_artifact(artifact, require_adhoc=True) for artifact in signed]
    assert receipts[0]["cdHash"] == receipts[1]["cdHash"]
    assert all(receipt["signature"] == "adhoc" for receipt in receipts)
    print("PASS: DMG and updater archive preserve the same valid ad-hoc bundle signature")

    # A signature label alone must not admit a modified bundle.
    resource.write_text("tampered resource\n")
    for artifact in package(source, root, "tampered"):
        rejected(artifact, "codesign failed")
    print("PASS: both artifact types reject a broken resource seal")

    # The CLI must fail closed as well as the helper used above.
    result = subprocess.run([sys.executable, str(Path(__file__).with_name("verify-macos-artifacts.py")),
                             "--require-adhoc", str(unsigned[0])], capture_output=True, text=True)
    assert result.returncode == 1 and "missing bundle resource signature" in result.stderr
    print("PASS: verifier command rejects the old unsigned download")
