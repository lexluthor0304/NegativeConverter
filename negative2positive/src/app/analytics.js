import { inject } from '@vercel/analytics';

if (typeof window !== 'undefined' && !window.__TAURI__) {
  inject();
}
