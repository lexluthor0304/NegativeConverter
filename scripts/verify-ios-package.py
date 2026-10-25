#!/usr/bin/env python3
"""Validate the distribution profile and the exact exported IPA before upload."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import zipfile

BUNDLE_ID = "com.neoanaloglab.negativeconverter"
TEAM_ID = "X93Y44J36C"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_profile(profile, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    require(profile.get("TeamIdentifier") == [TEAM_ID], "Wrong distribution team")
    require("iOS" in profile.get("Platform", []), "An iOS profile is required, not a Mac profile")
    require(profile.get("IsXcodeManaged") is not True,
            "Xcode-managed profile; the manual signing of the release lane needs a manually managed App Store profile")
    require("ProvisionedDevices" not in profile and not profile.get("ProvisionsAllDevices"),
            "An App Store distribution profile is required, not development/ad-hoc/enterprise")
    entitlements = profile.get("Entitlements", {})
    require(entitlements.get("application-identifier") == f"{TEAM_ID}.{BUNDLE_ID}", "Wrong profile bundle ID")
    require(not entitlements.get("get-task-allow", False), "Debugging is enabled in the profile")
    expiry = profile.get("ExpirationDate")
    require(isinstance(expiry, datetime.datetime), "Missing profile expiration")
    expiry = expiry.replace(tzinfo=datetime.timezone.utc) if expiry.tzinfo is None else expiry
    require(expiry > now, "Expired distribution profile")
    return {"team": TEAM_ID, "bundleId": BUNDLE_ID, "profileExpires": expiry.isoformat()}


def decode_profile(path):
    return plistlib.loads(subprocess.check_output(["security", "cms", "-D", "-i", str(path)]))


def validate_signing_certificate(certificate, profile):
    require(bool(certificate) and certificate in profile.get("DeveloperCertificates", []),
            "The IPA signing certificate is not permitted by its provisioning profile")


def validate_info(info, version, build):
    require(info.get("CFBundleIdentifier") == BUNDLE_ID, "Wrong IPA bundle ID")
    require(info.get("CFBundleShortVersionString") == version, "Wrong IPA marketing version")
    require(info.get("CFBundleVersion") == build, "Wrong IPA build number")
    require(set(info.get("UIDeviceFamily", [])) == {1, 2}, "The IPA must support both iPhone and iPad")
    require(info.get("CFBundleSupportedPlatforms") == ["iPhoneOS"], "A physical-device IPA is required")
    require(info.get("MinimumOSVersion") == "17.0", "Unexpected iOS deployment target")


def verify_ipa(export_dir, output, version, build):
    ipas = list(export_dir.glob("*.ipa"))
    require(len(ipas) == 1, f"Expected one exported IPA, found {len(ipas)}")
    ipa = ipas[0]
    with tempfile.TemporaryDirectory(prefix="nc-ios-verify-") as temp:
        unpacked = Path(temp)
        with zipfile.ZipFile(ipa) as archive:
            for name in archive.namelist():
                require(not name.startswith("/") and ".." not in Path(name).parts, "Unsafe IPA entry")
                require("p0-fixtures" not in Path(name).parts, "Device fixtures must not ship")
            require(archive.testzip() is None, "Corrupt IPA ZIP entry")
        # Preserve executable modes and framework links for codesign verification.
        subprocess.run(["ditto", "-x", "-k", str(ipa), str(unpacked)], check=True)
        apps = list((unpacked / "Payload").glob("*.app"))
        require(len(apps) == 1, "Expected one application in Payload")
        app = apps[0]
        info = plistlib.loads((app / "Info.plist").read_bytes())
        validate_info(info, version, build)
        profile_data = decode_profile(app / "embedded.mobileprovision")
        profile = validate_profile(profile_data)
        # codesign reads -R/--test-requirement as a file path unless the text is
        # prefixed with "=" (man codesign); without it: "invalid requirement
        # specification" (third TestFlight dispatch, 2026-10-26).
        subprocess.run(["codesign", "--verify", "--deep", "--strict",
                        "--test-requirement", "=anchor apple generic", str(app)], check=True)
        certificate_prefix = unpacked / "signer"
        subprocess.run(["codesign", "--display", f"--extract-certificates={certificate_prefix}",
                        str(app)], check=True, stderr=subprocess.DEVNULL)
        certificate_path = unpacked / "signer0"
        require(certificate_path.is_file(), "Unable to extract the IPA signing certificate")
        validate_signing_certificate(certificate_path.read_bytes(), profile_data)
        entitlements = plistlib.loads(subprocess.check_output(
            ["codesign", "--display", "--entitlements=:-", str(app)], stderr=subprocess.DEVNULL))
        require(not entitlements.get("get-task-allow", False), "IPA signature permits debugging")
        require(entitlements.get("application-identifier") == f"{TEAM_ID}.{BUNDLE_ID}", "Wrong signed application ID")
        require(entitlements.get("com.apple.developer.team-identifier") == TEAM_ID, "Wrong signed team")
        executable = app / info["CFBundleExecutable"]
        archs = subprocess.check_output(["xcrun", "lipo", "-archs", str(executable)], text=True).split()
        require(archs == ["arm64"], f"Unexpected IPA architectures: {archs}")
    output.mkdir(parents=True, exist_ok=True)
    destination = output / "NegativeConverter.ipa"
    shutil.copy2(ipa, destination)
    with destination.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    report = {**profile, "version": version, "build": build, "sha256": digest,
              "deviceFamilies": ["iPhone", "iPad"], "architectures": archs,
              "signatureVerified": True, "signerMatchesProfile": True, "fixtureFilesInPackage": False,
              "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()}
    (output / "verification.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--profile", type=Path)
    source.add_argument("--export-dir", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.profile:
        print(json.dumps(validate_profile(decode_profile(args.profile)), indent=2))
    else:
        require(args.output is not None, "--output is required with --export-dir")
        verify_ipa(args.export_dir, args.output, os.environ["APP_VERSION"], os.environ["BUILD_NUMBER"])


if __name__ == "__main__":
    main()
