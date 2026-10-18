import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(process.cwd());
const sourceDir = resolve(repoRoot, 'negative2positive', 'dist');
const targetDir = resolve(repoRoot, 'dist');

if (!existsSync(sourceDir)) {
  throw new Error(`Web build output not found: ${sourceDir}`);
}

// The iOS device self-test (#298, docs/ios-p0-feasibility.md) bundles its
// fixtures from negative2positive/public/p0-fixtures, an ignored directory of
// real RAW files. They belong in a debug build made for that run only.
if (existsSync(resolve(sourceDir, 'p0-fixtures')) && process.env.NC_P0_FIXTURES !== '1') {
  throw new Error('negative2positive/public/p0-fixtures is in the web build: remove it, or set NC_P0_FIXTURES=1 for a device self-test build');
}

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });

console.log(`Synced web build: ${sourceDir} -> ${targetDir}`);
