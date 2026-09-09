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
import time
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

# Produced by `tauri build --config src-tauri/tauri.release.conf.json`
# (createUpdaterArtifacts): a minisign signature next to every installer, plus
# the macOS app archive the in-app updater downloads instead of the DMG.
UPDATER_ASSET_SUFFIXES = (
    ".sig",
    ".app.tar.gz",
)

DEFAULT_PUBLIC_BASE_URL = "https://download.neoanaloglab.com"

# `arch` as classified from the file name -> arch in tauri-plugin-updater keys.
UPDATER_KEY_ARCH = {
    "x64": "x86_64",
    "arm64": "aarch64",
}

DEFAULT_UPLOAD_ATTEMPTS = 5
DEFAULT_UPLOAD_RETRY_BASE_SECONDS = 5.0


def _sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def _classify_asset(name: str) -> dict:
    lower = name.lower()
    if lower.endswith(".app.tar.gz"):
        os_name = "macos"
        kind = "app-archive"
    elif lower.endswith(".dmg"):
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


def _updater_keys(info: dict) -> list[str]:
    """Keys under which tauri-plugin-updater looks this asset up in updater.json.

    The plugin searches `<os>-<arch>-<installer>` and then `<os>-<arch>`, so
    the primary installer of each platform also fills the bare key. The legacy
    glibc AppImage is compiled with its own target
    (`NC_UPDATER_TARGET=linux-x86_64-glibc235`) and looks up that exact key.
    """
    arch = UPDATER_KEY_ARCH.get(info.get("arch", ""))
    if not arch:
        return []
    os_name = info.get("os")
    kind = info.get("type")
    if os_name == "windows":
        if kind == "exe":
            return [f"windows-{arch}-nsis", f"windows-{arch}"]
        if kind == "msi":
            return [f"windows-{arch}-msi"]
        return []
    if os_name == "linux":
        if kind == "appimage":
            if info.get("variant") == "legacy":
                glibc = str(info.get("glibcMin", "")).replace(".", "")
                return [f"linux-{arch}-glibc{glibc}"] if glibc else []
            return [f"linux-{arch}-appimage", f"linux-{arch}"]
        if kind == "deb":
            return [f"linux-{arch}-deb"]
        if kind == "rpm":
            return [f"linux-{arch}-rpm"]
        return []
    if os_name == "macos" and kind == "app-archive":
        return [f"darwin-{arch}-app", f"darwin-{arch}"]
    return []


def build_updater_manifest(
    *,
    version: str,
    records: list[dict],
    public_base_url: str,
    generated_at: str,
    notes: str = "",
) -> dict:
    """Static manifest for tauri-plugin-updater.

    `records` are asset records (`key`, classification fields) that carry a
    `signature`; assets without one are skipped by the caller. Raises when two
    assets would claim the same key, since the updater would then install
    whichever one happened to be listed last.
    """
    base = public_base_url.rstrip("/")
    platforms: dict[str, dict] = {}
    for record in records:
        for key in _updater_keys(record):
            if key in platforms:
                raise RuntimeError(
                    f"Updater key {key!r} claimed by both {platforms[key]['url']} and {record['key']}"
                )
            platforms[key] = {
                "url": f"{base}/{quote(record['key'], safe='/')}",
                "signature": record["signature"],
            }
    return {
        "version": version,
        "notes": notes,
        "pub_date": generated_at,
        "platforms": platforms,
    }


def _aws_s3_put_object(
    *,
    src: Path,
    bucket: str,
    key: str,
    endpoint: str,
    cache_control: str,
    content_type: str | None,
) -> None:
    cmd = [
        "aws",
        "s3api",
        "put-object",
        "--bucket",
        bucket,
        "--key",
        key,
        "--body",
        str(src),
        "--endpoint-url",
        endpoint,
        "--cache-control",
        cache_control,
    ]
    if content_type:
        cmd.extend(["--content-type", content_type])

    subprocess.run(cmd, check=True)


def _env_int(name: str, default: int, minimum: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        print(f"Ignoring invalid {name}={raw!r}; using {default}.", file=sys.stderr)
        return default
    return max(minimum, value)


def _env_float(name: str, default: float, minimum: float) -> float:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        print(f"Ignoring invalid {name}={raw!r}; using {default}.", file=sys.stderr)
        return default
    return max(minimum, value)


def _upload_with_retries(label: str, upload_fn) -> None:
    attempts = _env_int("R2_UPLOAD_ATTEMPTS", DEFAULT_UPLOAD_ATTEMPTS, 1)
    base_delay = _env_float("R2_UPLOAD_RETRY_BASE_SECONDS", DEFAULT_UPLOAD_RETRY_BASE_SECONDS, 0.1)

    for attempt in range(1, attempts + 1):
        try:
            upload_fn()
            return
        except (subprocess.CalledProcessError, RuntimeError, TimeoutError, OSError) as error:
            if attempt >= attempts:
                print(f"Upload failed after {attempts} attempt(s): {label}", file=sys.stderr)
                raise

            delay = min(base_delay * (2 ** (attempt - 1)), 60.0)
            print(
                f"Upload failed for {label} on attempt {attempt}/{attempts}: {error}. "
                f"Retrying in {delay:.1f}s...",
                file=sys.stderr,
            )
            time.sleep(delay)


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
        help="If set, upload latest.json and updater.json to <prefix>/ after syncing installers.",
    )
    parser.add_argument(
        "--public-base-url",
        default=DEFAULT_PUBLIC_BASE_URL,
        help="Public origin the bucket is served from; updater.json needs absolute download URLs.",
    )
    parser.add_argument(
        "--manifest-dir",
        default=".",
        help="Directory to write latest.json and updater.json into before uploading.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Classify assets and write the manifests without uploading anything (no credentials needed).",
    )
    args = parser.parse_args()

    has_aws_creds = bool(os.environ.get("AWS_ACCESS_KEY_ID")) and bool(os.environ.get("AWS_SECRET_ACCESS_KEY"))
    has_cf_creds = bool(_cf_api_token()) and bool(_cf_account_id())

    upload_mode = "aws" if has_aws_creds else "cloudflare" if has_cf_creds else None
    if args.dry_run:
        upload_mode = "dry-run"
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

    updater_paths: list[Path] = []
    for suffix in UPDATER_ASSET_SUFFIXES:
        updater_paths.extend(source_dir.rglob(f"*{suffix}"))
    updater_paths = sorted({p for p in updater_paths if p.is_file()}, key=lambda p: p.name.lower())

    version = tag[1:] if tag.startswith("v") else tag
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    installers_prefix = f"{prefix}/{tag}"
    cf_account_id = _cf_account_id() if upload_mode == "cloudflare" else None

    def put_object(name: str, src: Path, key: str, cache_control: str, content_type: str | None) -> None:
        if upload_mode == "dry-run":
            print(f"[dry-run] Would upload: {name} -> {key}")
            return
        if upload_mode == "aws":
            dest = f"s3://{args.bucket}/{key}"
            print(f"Uploading: {name} -> {dest}")
            _upload_with_retries(
                name,
                lambda: _aws_s3_put_object(
                    src=src,
                    bucket=args.bucket,
                    key=key,
                    endpoint=args.endpoint,
                    cache_control=cache_control,
                    content_type=content_type,
                ),
            )
        else:
            dest = f"r2://{args.bucket}/{key}"
            print(f"Uploading: {name} -> {dest}")
            _upload_with_retries(
                name,
                lambda: _cf_r2_put_object(
                    account_id=cf_account_id or "",
                    bucket=args.bucket,
                    key=key,
                    src=src,
                    cache_control=cache_control,
                    content_type=content_type,
                ),
            )

    immutable = "public, max-age=31536000, immutable"

    files: list[dict] = []
    updater_records: list[dict] = []
    for path in installer_paths + [p for p in updater_paths if not p.name.endswith(".sig")]:
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
        # latest.json feeds the download page, which offers installers only.
        if info["type"] != "app-archive":
            files.append(record)

        signature_path = path.with_name(f"{name}.sig")
        if signature_path.is_file():
            signature = signature_path.read_text(encoding="utf-8").strip()
            if signature:
                updater_records.append({**record, "signature": signature})
        elif _updater_keys(info):
            print(f"Note: no updater signature next to {name}; it will not be offered in-app.")

        put_object(name, path, key, immutable, None)

    for path in updater_paths:
        if not path.name.endswith(".sig"):
            continue
        put_object(path.name, path, f"{installers_prefix}/{path.name}", immutable, "text/plain; charset=utf-8")

    manifest = {
        "tag": tag,
        "version": version,
        "generatedAt": now,
        "prefix": prefix,
        "files": files,
    }

    manifest_dir = Path(args.manifest_dir)
    manifest_dir.mkdir(parents=True, exist_ok=True)
    latest_path = manifest_dir / "latest.json"
    latest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote manifest: {latest_path} ({len(files)} file(s))")

    updater_manifest = build_updater_manifest(
        version=version,
        records=updater_records,
        public_base_url=args.public_base_url,
        generated_at=now,
        notes=f"Negative Converter {version}",
    )
    updater_path = manifest_dir / "updater.json"
    updater_path.write_text(json.dumps(updater_manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote updater manifest: {updater_path} ({', '.join(sorted(updater_manifest['platforms'])) or 'no platforms'})")

    if args.update_latest:
        if not updater_manifest["platforms"]:
            print(
                "updater.json has no platforms: no signed installers were found. "
                "Release builds need TAURI_SIGNING_PRIVATE_KEY and tauri.release.conf.json.",
                file=sys.stderr,
            )
            return 1
        manifest_cache = "public, max-age=60"
        manifest_type = "application/json; charset=utf-8"
        put_object("latest.json", latest_path, f"{prefix}/latest.json", manifest_cache, manifest_type)
        put_object("updater.json", updater_path, f"{prefix}/updater.json", manifest_cache, manifest_type)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
