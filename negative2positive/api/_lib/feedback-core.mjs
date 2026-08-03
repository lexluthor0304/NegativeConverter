// Shared logic for the /api/feedback serverless function.
// Framework-free so the unit tests can run it under plain node.

export const MAX_MESSAGE_LENGTH = 4000;
export const FEEDBACK_TYPES = ['bug', 'idea', 'other'];
export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;       // per image, decoded
export const MAX_TOTAL_IMAGE_BYTES = 3.5 * 1024 * 1024; // request stays under Vercel's 4.5MB body cap

const IMAGE_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const ALLOWED_ORIGINS = new Set([
  'https://negative-converter.tokugai.com',
  // Tauri desktop webview origins (macOS/Linux and Windows)
  'tauri://localhost',
  'http://tauri.localhost',
]);

const LOCAL_DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function resolveCorsOrigin(origin) {
  if (typeof origin !== 'string' || origin === '') return null;
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (LOCAL_DEV_ORIGIN.test(origin)) return origin;
  return null;
}

// Returns { spam: true } | { error: string } | { data: {type, message, lang, source} }.
export function validateFeedback(body) {
  if (!body || typeof body !== 'object') return { error: 'invalid_body' };
  // Honeypot: the form hides this field, so any value means a bot filled it in.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return { spam: true };
  }
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return { error: 'empty_message' };
  if (message.length > MAX_MESSAGE_LENGTH) return { error: 'message_too_long' };
  const type = FEEDBACK_TYPES.includes(body.type) ? body.type : 'other';
  const lang = typeof body.lang === 'string' && /^[a-z]{2}(-[A-Za-z0-9-]{1,10})?$/.test(body.lang)
    ? body.lang
    : 'unknown';
  const source = body.source === 'desktop' ? 'desktop' : 'web';
  const imageResult = validateImages(body.images);
  if (imageResult.error) return { error: imageResult.error };
  return { data: { type, message, lang, source, images: imageResult.images } };
}

// Returns { error } | { images: [{ data: <base64>, ext }] }. Absent/empty input is fine.
export function validateImages(images) {
  if (images === undefined || images === null) return { images: [] };
  if (!Array.isArray(images)) return { error: 'invalid_images' };
  if (images.length > MAX_IMAGES) return { error: 'too_many_images' };
  const out = [];
  let totalBytes = 0;
  for (const img of images) {
    if (!img || typeof img !== 'object') return { error: 'invalid_images' };
    const ext = IMAGE_EXTENSIONS[img.type];
    if (!ext) return { error: 'unsupported_image_type' };
    const data = typeof img.data === 'string' ? img.data : '';
    if (!data || data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) return { error: 'invalid_images' };
    const bytes = Math.floor(data.length * 3 / 4);
    if (bytes > MAX_IMAGE_BYTES) return { error: 'image_too_large' };
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) return { error: 'images_too_large' };
    out.push({ data, ext });
  }
  return { images: out };
}

// imageOutcome: { urls: [string|null, ...] } — null entries are uploads that failed.
export function buildIssuePayload(data, userAgent = '', imageOutcome = null) {
  const excerptSource = data.message.replace(/\s+/g, ' ').trim();
  const excerpt = excerptSource.length > 60 ? `${excerptSource.slice(0, 60)}…` : excerptSource;
  const meta = [
    `**Type:** ${data.type}`,
    `**UI language:** ${data.lang}`,
    `**Source:** ${data.source}`,
  ];
  const ua = String(userAgent || '').slice(0, 300);
  if (ua) meta.push(`**User agent:** ${ua}`);
  let body = `${meta.join('\n')}\n\n---\n\n${data.message}`;
  const urls = imageOutcome && Array.isArray(imageOutcome.urls) ? imageOutcome.urls : [];
  if (urls.length) {
    const shown = urls
      .map((url, i) => (url ? `![feedback image ${i + 1}](${url})` : null))
      .filter(Boolean);
    const failed = urls.length - shown.length;
    const parts = [];
    if (shown.length) parts.push(shown.join('\n\n'));
    if (failed) parts.push(`_(${failed} attached image${failed > 1 ? 's' : ''} failed to upload)_`);
    body += `\n\n---\n\n${parts.join('\n\n')}`;
  }
  return {
    title: `[feedback] ${data.type}: ${excerpt}`,
    body,
    labels: ['feedback'],
  };
}
