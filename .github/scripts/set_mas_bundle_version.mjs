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
const [major, minor, patch] = version.split('.').map(Number);
const bundleVersion = String((major * 10000 + minor * 100 + patch) * 100 + (attempt - 1));

const confPath = 'src-tauri/tauri.appstore.conf.json';
const conf = JSON.parse(readFileSync(confPath, 'utf8'));
conf.bundle = conf.bundle || {};
conf.bundle.macOS = conf.bundle.macOS || {};
conf.bundle.macOS.bundleVersion = bundleVersion;
writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`, 'utf8');

console.log(`Applied MAS bundleVersion: ${bundleVersion} (version ${version}, attempt ${attempt})`);
