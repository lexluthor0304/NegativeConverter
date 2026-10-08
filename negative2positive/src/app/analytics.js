import { inject } from '@vercel/analytics';

// Production loads the same-origin /_vercel/insights/script.js. Under `vite
// dev` inject() would load the cross-origin debug script from
// va.vercel-scripts.com as a classic script without `crossorigin`, which the
// dev server's cross-origin isolation headers (#264) block, so dev skips it.
// The desktop app never injects it.
if (typeof window !== 'undefined' && !window.__TAURI__ && !import.meta.env?.DEV) {
  inject();
}
