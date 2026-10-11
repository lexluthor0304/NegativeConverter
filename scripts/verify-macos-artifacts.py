#!/usr/bin/env python3
"""Verify the app inside each distributable, without modifying or launching it."""

import argparse
import json
import plistlib
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path


def run(*args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=120)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed: {(result.stderr or result.stdout).strip()}")
    return result.stdout + result.stderr


def verify_app(directory, require_adhoc):
    apps = list(directory.glob("*.app"))
    if len(apps) != 1:
        raise RuntimeError(f"Expected one app in {directory}, found {len(apps)}")
    app = apps[0]
    if app.is_symlink() or not app.is_dir():
        raise RuntimeError(f"{app.name}: expected an app directory inside the artifact")
    # A linker-signed arm64 executable can say Signature=adhoc while the
    # containing app is unsigned. Require the bundle's resource envelope too.
    if not (app / "Contents/_CodeSignature/CodeResources").is_file():
        raise RuntimeError(f"{app.name}: missing bundle resource signature")
    run("codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app))
    description = run("codesign", "--display", "--verbose=4", str(app))
    fields = dict(line.split("=", 1) for line in description.splitlines() if "=" in line)
    if require_adhoc and fields.get("Signature") != "adhoc":
        raise RuntimeError(f"{app.name}: expected an ad-hoc bundle signature")
    with (app / "Contents/Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    if fields.get("Identifier") != info.get("CFBundleIdentifier"):
        raise RuntimeError(f"{app.name}: signature identifier does not match Info.plist")
    if "not bound" in fields.get("Info.plist", "") or "linker-signed" in description:
        raise RuntimeError(f"{app.name}: executable was signed without binding the app bundle")
    return {
        "app": app.name,
        "identifier": info["CFBundleIdentifier"],
        "version": info["CFBundleShortVersionString"],
        "signature": fields.get("Signature", "certificate"),
        "cdHash": fields.get("CDHash"),
        "resourceSeal": True,
        "strictVerification": True,
    }


def verify_artifact(artifact, require_adhoc=False):
    artifact = Path(artifact).resolve(strict=True)
    if not artifact.is_file():
        raise RuntimeError(f"Expected a packaged artifact, got {artifact}")
    with tempfile.TemporaryDirectory(prefix="nc-signature-") as scratch:
        directory = Path(scratch) / "payload"
        directory.mkdir()
        if artifact.name.endswith(".dmg"):
            mounted = False
            try:
                run("hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint",
                    str(directory), str(artifact))
                mounted = True
                receipt = verify_app(directory, require_adhoc)
            finally:
                if mounted or directory.is_mount():
                    run("hdiutil", "detach", str(directory))
        elif artifact.name.endswith(".app.tar.gz"):
            with tarfile.open(artifact) as archive:
                archive.extractall(directory, filter="data")
            receipt = verify_app(directory, require_adhoc)
        else:
            raise RuntimeError(f"Unsupported artifact: {artifact.name}")
    return {"artifact": artifact.name, **receipt}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--require-adhoc", action="store_true")
    parser.add_argument("artifacts", type=Path, nargs="+")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("macOS is required to inspect codesign and DMG payloads")
    try:
        for artifact in args.artifacts:
            print(json.dumps(verify_artifact(artifact, args.require_adhoc)), flush=True)
    except (OSError, RuntimeError, subprocess.TimeoutExpired, tarfile.TarError, ValueError) as error:
        print(f"macOS artifact verification failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
