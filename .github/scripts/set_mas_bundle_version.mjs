import { readFileSync, writeFileSync } from 'node:fs';

const version = (process.argv[2] || '').trim();
const attempt = Number(process.argv[3] || '1');

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Invalid version '${version}'. Expected format: x.y.z`);
  process.exit(1);
}
if (!Number.isInteger(attempt) || attempt < 1) {
  console.error(`Invalid run attempt '${process.argv[3]}'. Expected a positive integer.`);
  process.exit(1);
}

// Mac App Store build numbers must increase across *every* upload of the app,
// not just within one version. Deriving the number from the release version
// keeps it monotonic and far above the hand-numbered uploads ("1", "2") that
// shipped 1.0.0; the run attempt digit lets a re-run of a failed submission
// re-upload the same version with a fresh build number.
//
// Field widths: major | minor (3 digits) | patch (3 digits) | attempt (2
// digits). The previous formula gave patch only two digits, so 1.0.100 would
// have collided with 1.1.0 and 1.0.101 would have exceeded it. Every value
// this formula produces for 1.0.0 and later (>= 100000000) is above every
// value the old one ever produced for a shipped release (1.0.12 -> 1001200),
// so the sequence stays strictly increasing across the change.
const [major, minor, patch] = version.split('.').map(Number);
if (minor > 999 || patch > 999) {
  console.error(`Version '${version}' overflows the bundleVersion layout (minor and patch must be <= 999).`);
  process.exit(1);
}
if (attempt > 100) {
  console.error(`Run attempt ${attempt} overflows the bundleVersion layout (must be <= 100).`);
  process.exit(1);
}
const bundleVersion = String(
  major * 100_000_000 + minor * 100_000 + patch * 100 + (attempt - 1),
);

const confPath = 'src-tauri/tauri.appstore.conf.json';
const conf = JSON.parse(readFileSync(confPath, 'utf8'));
conf.bundle = conf.bundle || {};
conf.bundle.macOS = conf.bundle.macOS || {};
conf.bundle.macOS.bundleVersion = bundleVersion;
writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`, 'utf8');

console.log(`Applied MAS bundleVersion: ${bundleVersion} (version ${version}, attempt ${attempt})`);
