// The iOS device self-test (#298, docs/ios-p0-feasibility.md) bundles its
// fixtures from negative2positive/public/p0-fixtures, an ignored directory of
// real RAW files that must never ride along in anything but a build made for
// that run. Vite copies the whole public directory, so this plugin removes the
// directory from the output unless NC_P0_FIXTURES=1 asked for it; build.rs
// refuses to embed a dist that still carries it, which also covers an Xcode
// archive or a `tauri build` that never rebuilt the web assets.
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

export const P0_FIXTURES_DIR = 'p0-fixtures';
export const P0_FIXTURES_ENV = 'NC_P0_FIXTURES';

export function p0FixturesAllowed(env = process.env) {
  return env[P0_FIXTURES_ENV] === '1';
}

export function p0FixturesPlugin() {
  let outDir = null;
  return {
    name: 'nc-p0-fixtures',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      if (!outDir) return;
      const copied = resolve(outDir, P0_FIXTURES_DIR);
      if (!existsSync(copied)) return;
      if (p0FixturesAllowed()) {
        console.warn(`[p0-fixtures] ${P0_FIXTURES_DIR} kept in the build (${P0_FIXTURES_ENV}=1): a device self-test build only`);
        return;
      }
      rmSync(copied, { recursive: true, force: true });
      console.warn(`[p0-fixtures] removed ${P0_FIXTURES_DIR} from the build: set ${P0_FIXTURES_ENV}=1 for a device self-test build`);
    }
  };
}
