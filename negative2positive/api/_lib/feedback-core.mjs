// Shared logic for the /api/feedback serverless function.
// Framework-free so the unit tests can run it under plain node.

export const MAX_MESSAGE_LENGTH = 4000;
export const FEEDBACK_TYPES = ['bug', 'idea', 'other'];

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
  return { data: { type, message, lang, source } };
}

export function buildIssuePayload(data, userAgent = '') {
  const excerptSource = data.message.replace(/\s+/g, ' ').trim();
  const excerpt = excerptSource.length > 60 ? `${excerptSource.slice(0, 60)}…` : excerptSource;
  const meta = [
    `**Type:** ${data.type}`,
    `**UI language:** ${data.lang}`,
    `**Source:** ${data.source}`,
  ];
  const ua = String(userAgent || '').slice(0, 300);
  if (ua) meta.push(`**User agent:** ${ua}`);
  return {
    title: `[feedback] ${data.type}: ${excerpt}`,
    body: `${meta.join('\n')}\n\n---\n\n${data.message}`,
    labels: ['feedback'],
  };
}
