#!/usr/bin/env python3

import argparse
import hashlib
import http.client
import json
import os
import re
import ssl
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlparse, urlunparse


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

    result = {"os": os_name, "type": kind, "arch": arch, "variant": "standard"}
    if os_name == "linux":
        legacy_match = re.search(r"legacy[-_]?glibc[-_]?([0-9]+)(?:[._-]([0-9]+))?", lower)
        if legacy_match:
            major_raw = legacy_match.group(1)
            minor_raw = legacy_match.group(2)
            if minor_raw:
                glibc_min = f"{int(major_raw)}.{int(minor_raw)}"
            elif len(major_raw) >= 2:
                glibc_min = f"{int(major_raw[0])}.{int(major_raw[1:])}"
            else:
                glibc_min = f"{int(major_raw)}.0"
            result["variant"] = "legacy"
            result["glibcMin"] = glibc_min

    return result


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


def _cf_api_token() -> str | None:
    token = os.environ.get("CLOUDFLARE_API_TOKEN") or os.environ.get("CF_API_TOKEN")
    token = (token or "").strip()
    return token or None


def _cf_account_id() -> str | None:
    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID") or os.environ.get("CF_ACCOUNT_ID")
    account_id = (account_id or "").strip()
    return account_id or None


def _cf_base_url() -> str:
    return (os.environ.get("CLOUDFLARE_BASE_URL") or "https://api.cloudflare.com/client/v4").strip().rstrip("/")


def _cf_r2_put_object(
    *,
    account_id: str,
    bucket: str,
    key: str,
    src: Path,
    cache_control: str,
    content_type: str | None,
) -> None:
    if not account_id.strip():
        raise RuntimeError("Missing CLOUDFLARE_ACCOUNT_ID.")
    token = _cf_api_token()
    if not token:
        raise RuntimeError("Missing CLOUDFLARE_API_TOKEN.")

    parsed = urlparse(_cf_base_url())
    if parsed.scheme not in ("https", "http") or not parsed.netloc:
        raise RuntimeError(f"Invalid CLOUDFLARE_BASE_URL: {_cf_base_url()!r}")

    base_path = (parsed.path or "").rstrip("/")
    object_path = quote(key, safe="/")
    url_path = f"{base_path}/accounts/{account_id}/r2/buckets/{bucket}/objects/{object_path}"

    if parsed.scheme == "https":
        conn: http.client.HTTPConnection = http.client.HTTPSConnection(
            parsed.netloc, context=ssl.create_default_context()
        )
    else:
        conn = http.client.HTTPConnection(parsed.netloc)

    try:
        conn.putrequest("PUT", url_path)
        conn.putheader("Authorization", f"Bearer {token}")
        conn.putheader("User-Agent", "negative-converter/r2-sync")
        conn.putheader("Cache-Control", cache_control)
        if content_type:
            conn.putheader("Content-Type", content_type)
        conn.putheader("Content-Length", str(src.stat().st_size))
        conn.endheaders()

        with src.open("rb") as handle:
            while True:
                chunk = handle.read(1024 * 1024)
                if not chunk:
                    break
                conn.send(chunk)

        resp = conn.getresponse()
        body = resp.read()
        if not (200 <= resp.status < 300):
            snippet = body[:500].decode("utf-8", errors="replace")
            raise RuntimeError(f"R2 upload failed ({resp.status} {resp.reason}): {snippet}")
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync GitHub release installers to Cloudflare R2.")
    parser.add_argument("--source-dir", default="artifacts", help="Directory containing release assets to upload.")
    parser.add_argument("--bucket", required=True, help="R2 bucket name.")
    parser.add_argument("--endpoint", help="R2 S3 endpoint URL (required for S3 upload).")
    parser.add_argument("--prefix", default="negative-converter/release", help="Key prefix within the bucket.")
    parser.add_argument("--tag", required=True, help="Release tag (e.g. v0.1.0).")
    parser.add_argument(
        "--update-latest",
        action="store_true",
        help="If set, upload latest.json to <prefix>/latest.json after syncing installers.",
    )
    args = parser.parse_args()

    has_aws_creds = bool(os.environ.get("AWS_ACCESS_KEY_ID")) and bool(os.environ.get("AWS_SECRET_ACCESS_KEY"))
    has_cf_creds = bool(_cf_api_token()) and bool(_cf_account_id())

    upload_mode = "aws" if has_aws_creds else "cloudflare" if has_cf_creds else None
    if not upload_mode:
        print(
            "Missing R2 credentials.\n"
            "Provide either:\n"
            "  - AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (R2 S3 token)\n"
            "  - CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID (Cloudflare API upload)\n",
            file=sys.stderr,
        )
        return 2

    if upload_mode == "aws":
        endpoint = (args.endpoint or "").strip()
        if not endpoint:
            print("Missing --endpoint (R2 S3 endpoint URL).", file=sys.stderr)
            return 2

        parsed_endpoint = urlparse(endpoint)
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
                endpoint = normalized_endpoint
            else:
                print(
                    f"Invalid endpoint: expected no path, or '/{args.bucket}', got path '/{endpoint_path}'.",
                    file=sys.stderr,
                )
                return 2
        args.endpoint = endpoint

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
    cf_account_id = _cf_account_id() if upload_mode == "cloudflare" else None
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

        if upload_mode == "aws":
            dest = f"s3://{args.bucket}/{key}"
            print(f"Uploading: {name} -> {dest}")
            _aws_s3_cp(
                src=path,
                dest=dest,
                endpoint=args.endpoint,
                cache_control="public, max-age=31536000, immutable",
                content_type=None,
            )
        else:
            dest = f"r2://{args.bucket}/{key}"
            print(f"Uploading: {name} -> {dest}")
            _cf_r2_put_object(
                account_id=cf_account_id or "",
                bucket=args.bucket,
                key=key,
                src=path,
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
        if upload_mode == "aws":
            dest = f"s3://{args.bucket}/{latest_key}"
            print(f"Uploading: latest.json -> {dest}")
            _aws_s3_cp(
                src=latest_path,
                dest=dest,
                endpoint=args.endpoint,
                cache_control="public, max-age=60",
                content_type="application/json; charset=utf-8",
            )
        else:
            dest = f"r2://{args.bucket}/{latest_key}"
            print(f"Uploading: latest.json -> {dest}")
            _cf_r2_put_object(
                account_id=cf_account_id or "",
                bucket=args.bucket,
                key=latest_key,
                src=latest_path,
                cache_control="public, max-age=60",
                content_type="application/json; charset=utf-8",
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
