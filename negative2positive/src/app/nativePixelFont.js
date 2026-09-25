import { nativePixelFontCoverage } from './nativePixelFontCoverage.js';

export const NATIVE_PIXEL_SIZE = 12;
// Literal new URL() calls, so Vite fingerprints each face into immutable
// /assets. pixel-fonts.css references the same files, so the UI and the
// film-edge canvas text share one URL, and one download, per face.
const faceUrls = {
  sc: new URL('../assets/fonts/fusion-pixel/fusion-pixel-12px-proportional-zh_hans.otf.woff2', import.meta.url).href,
  tc: new URL('../assets/fonts/fusion-pixel/fusion-pixel-12px-proportional-zh_hant.otf.woff2', import.meta.url).href,
  ja: new URL('../assets/fonts/fusion-pixel/fusion-pixel-12px-proportional-ja.otf.woff2', import.meta.url).href,
  ko: new URL('../assets/fonts/fusion-pixel/fusion-pixel-12px-proportional-ko.otf.woff2', import.meta.url).href,
};
const pendingFonts = new Map();
const readyFonts = new Set();

export function nativePixelFontLocale(locale = 'en') {
  const language = String(locale).toLowerCase();
  if (language.startsWith('ja')) return 'ja';
  if (language.startsWith('ko')) return 'ko';
  if (language === 'tc' || /^(zh-hant|zh-tw|zh-hk)/.test(language)) return 'tc';
  return 'sc';
}

export function nativePixelFontFamily(locale) {
  return `NC Film Edge ${nativePixelFontLocale(locale)}`;
}

export function hasNativePixelGlyph(char) {
  const code = char.codePointAt(0);
  let low = 0, high = nativePixelFontCoverage.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [first, last] = nativePixelFontCoverage[middle];
    if (code < first) high = middle - 1;
    else if (code > last) low = middle + 1;
    else return true;
  }
  return false;
}

export function isNativePixelFontReady(locale) {
  return readyFonts.has(nativePixelFontLocale(locale));
}

// Register the bundled face explicitly: canvas-only labels also work without
// a matching UI glyph having triggered CSS font loading first.
export function ensureNativePixelFont(locale) {
  const key = nativePixelFontLocale(locale);
  if (readyFonts.has(key)) return Promise.resolve();
  if (pendingFonts.has(key)) return pendingFonts.get(key);
  const fontSet = globalThis.document?.fonts || globalThis.fonts;
  if (typeof FontFace !== 'function' || !fontSet) {
    return Promise.reject(new Error('Native film-edge font loading is unavailable.'));
  }
  const url = faceUrls[key];
  const face = new FontFace(nativePixelFontFamily(key), `url("${url}")`, { weight: '400', style: 'normal' });
  const pending = face.load().then(loaded => {
    fontSet.add(loaded);
    readyFonts.add(key);
  }).finally(() => pendingFonts.delete(key));
  pendingFonts.set(key, pending);
  return pending;
}
