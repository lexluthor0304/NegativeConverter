// Harness-only Vite config for `vite preview` (scripts/perf/lib/build.mjs):
// the app's own config (NC_PERF_APP_CONFIG, the ref under test) plus the
// preview-only /__perf routes. Never used by `npm run build:web`.
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ncPerfPreviewPlugin, optionsFromEnv } from './preview-plugin.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export default async function perfPreviewConfig(env) {
  const appConfigPath = process.env.NC_PERF_APP_CONFIG || join(here, '..', '..', 'negative2positive', 'vite.config.js');
  const imported = (await import(pathToFileURL(appConfigPath).href)).default;
  const app = typeof imported === 'function' ? await imported(env) : imported;
  return {
    ...app,
    plugins: [...(app.plugins || []), ncPerfPreviewPlugin(optionsFromEnv())],
    preview: { ...(app.preview || {}), host: '127.0.0.1', strictPort: true }
  };
}
