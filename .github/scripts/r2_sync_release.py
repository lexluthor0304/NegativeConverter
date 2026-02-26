#!/usr/bin/env python3

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse, urlunparse


INSTALLER_SUFFIXES = (
    ".dmg",
    ".msi",
    ".exe",
    ".deb",
    ".rpm",
    ".AppImage",
)


def _sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def _classify_asset(name: str) -> dict:
    lower = name.lower()
    if lower.endswith(".dmg"):
        os_name = "macos"
        kind = "dmg"
    elif lower.endswith(".msi"):
        os_name = "windows"
        kind = "msi"
    elif lower.endswith(".exe"):
        os_name = "windows"
        kind = "exe"
    elif name.endswith(".AppImage") or lower.endswith(".appimage"):
        os_name = "linux"
        kind = "appimage"
    elif lower.endswith(".deb"):
        os_name = "linux"
        kind = "deb"
    elif lower.endswith(".rpm"):
        os_name = "linux"
        kind = "rpm"
    else:
        os_name = "unknown"
        kind = "unknown"

    arch = "unknown"
    if re.search(r"(aarch64|arm64)", lower):
        arch = "arm64"
    elif re.search(r"(x86_64|amd64|x64)", lower):
        arch = "x64"

    return {"os": os_name, "type": kind, "arch": arch}


def _aws_s3_cp(*, src: Path, dest: str, endpoint: str, cache_control: str, content_type: str | None) -> None:
    cmd = [
        "aws",
        "s3",
        "cp",
        str(src),
        dest,
        "--endpoint-url",
        endpoint,
        "--only-show-errors",
        "--no-progress",
        "--cache-control",
        cache_control,
    ]
    if content_type:
        cmd.extend(["--content-type", content_type])

    subprocess.run(cmd, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync GitHub release installers to Cloudflare R2.")
    parser.add_argument("--source-dir", default="artifacts", help="Directory containing release assets to upload.")
    parser.add_argument("--bucket", required=True, help="R2 bucket name.")
    parser.add_argument("--endpoint", required=True, help="R2 S3 endpoint URL.")
    parser.add_argument("--prefix", default="negative-converter/release", help="Key prefix within the bucket.")
    parser.add_argument("--tag", required=True, help="Release tag (e.g. v0.1.0).")
    parser.add_argument(
        "--update-latest",
        action="store_true",
        help="If set, upload latest.json to <prefix>/latest.json after syncing installers.",
    )
    args = parser.parse_args()

    if not os.environ.get("AWS_ACCESS_KEY_ID") or not os.environ.get("AWS_SECRET_ACCESS_KEY"):
        print("Missing AWS credentials in environment (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY).", file=sys.stderr)
        return 2

    parsed_endpoint = urlparse(args.endpoint)
    endpoint_path = (parsed_endpoint.path or "").strip("/")
    if endpoint_path:
        if endpoint_path == args.bucket:
            normalized_endpoint = urlunparse(
                (
                    parsed_endpoint.scheme,
                    parsed_endpoint.netloc,
                    "",
                    "",
                    "",
                    "",
                )
            )
            print(
                f"Note: endpoint URL contains bucket path '/{endpoint_path}', normalizing endpoint to '{normalized_endpoint}'."
            )
            args.endpoint = normalized_endpoint
        else:
            print(
                f"Invalid endpoint: expected no path, or '/{args.bucket}', got path '/{endpoint_path}'.",
                file=sys.stderr,
            )
            return 2

    source_dir = Path(args.source_dir)
    if not source_dir.exists():
        print(f"Source directory does not exist: {source_dir}", file=sys.stderr)
        return 2

    prefix = args.prefix.strip("/").replace("\\", "/")
    tag = args.tag.strip()
    if not tag:
        print("Tag is empty.", file=sys.stderr)
        return 2

    installer_paths: list[Path] = []
    for suffix in INSTALLER_SUFFIXES:
        installer_paths.extend(source_dir.rglob(f"*{suffix}"))
    installer_paths = sorted({p for p in installer_paths if p.is_file()}, key=lambda p: p.name.lower())

    if not installer_paths:
        print(f"No installer assets found under {source_dir}.", file=sys.stderr)
        return 1

    version = tag[1:] if tag.startswith("v") else tag
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    files: list[dict] = []
    installers_prefix = f"{prefix}/{tag}"
    for path in installer_paths:
        name = path.name
        key = f"{installers_prefix}/{name}"
        info = _classify_asset(name)
        record = {
            "name": name,
            "key": key,
            "bytes": path.stat().st_size,
            "sha256": _sha256_file(path),
            **info,
        }
        files.append(record)

        dest = f"s3://{args.bucket}/{key}"
        print(f"Uploading: {name} -> {dest}")
        _aws_s3_cp(
            src=path,
            dest=dest,
            endpoint=args.endpoint,
            cache_control="public, max-age=31536000, immutable",
            content_type=None,
        )

    manifest = {
        "tag": tag,
        "version": version,
        "generatedAt": now,
        "prefix": prefix,
        "files": files,
    }

    latest_path = Path("latest.json")
    latest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote manifest: {latest_path} ({len(files)} file(s))")

    if args.update_latest:
        latest_key = f"{prefix}/latest.json"
        dest = f"s3://{args.bucket}/{latest_key}"
        print(f"Uploading: latest.json -> {dest}")
        _aws_s3_cp(
            src=latest_path,
            dest=dest,
            endpoint=args.endpoint,
            cache_control="public, max-age=60",
            content_type="application/json; charset=utf-8",
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
