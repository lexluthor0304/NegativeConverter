import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(process.cwd());
const sourceDir = resolve(repoRoot, 'negative2positive', 'dist');
const targetDir = resolve(repoRoot, 'dist');

if (!existsSync(sourceDir)) {
  throw new Error(`Web build output not found: ${sourceDir}`);
}

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true });

console.log(`Synced web build: ${sourceDir} -> ${targetDir}`);
