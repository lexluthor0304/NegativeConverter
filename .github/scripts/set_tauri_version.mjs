import { readFileSync, writeFileSync } from 'node:fs';

const version = (process.argv[2] || '').trim();

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Invalid version '${version}'. Expected format: x.y.z`);
  process.exit(1);
}

const tauriConfigPath = 'src-tauri/tauri.conf.json';
const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, 'utf8'));
const currentTauriVersion = String(tauriConfig.version || '').trim();

const cargoTomlPath = 'src-tauri/Cargo.toml';
const cargoToml = readFileSync(cargoTomlPath, 'utf8');
const packageVersionPattern = /(\[package\][\s\S]*?^version\s*=\s*")([^"]+)(")/m;
const packageVersionMatch = cargoToml.match(packageVersionPattern);

if (!packageVersionMatch) {
  console.error('Failed to locate [package].version in src-tauri/Cargo.toml');
  process.exit(1);
}

const currentCargoVersion = packageVersionMatch[2];
const tauriNeedsUpdate = currentTauriVersion !== version;
const cargoNeedsUpdate = currentCargoVersion !== version;

if (!tauriNeedsUpdate && !cargoNeedsUpdate) {
  console.log(`Release version already applied: ${version}`);
  process.exit(0);
}

if (tauriNeedsUpdate) {
  tauriConfig.version = version;
  writeFileSync(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`, 'utf8');
}

if (cargoNeedsUpdate) {
  const updatedCargoToml = cargoToml.replace(packageVersionPattern, `$1${version}$3`);
  if (updatedCargoToml === cargoToml) {
    console.error('Failed to update [package].version in src-tauri/Cargo.toml');
    process.exit(1);
  }
  writeFileSync(cargoTomlPath, updatedCargoToml, 'utf8');
}

console.log(`Applied release version: ${version} (tauriUpdated=${tauriNeedsUpdate}, cargoUpdated=${cargoNeedsUpdate})`);
