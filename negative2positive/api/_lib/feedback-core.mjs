// Shared logic for the /api/feedback serverless function.
// Framework-free so the unit tests can run it under plain node.

export const MAX_MESSAGE_LENGTH = 4000;
export const FEEDBACK_TYPES = ['bug', 'idea', 'other'];
export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;       // per image, decoded
// Decoded budget. base64 inflates by ~4/3, so a request at this cap is ~4.7MB on
// the wire and Vercel's 4.5MB body cap is what actually rejects it first.
export const MAX_TOTAL_IMAGE_BYTES = 3.5 * 1024 * 1024;
// Hard ceiling checked from Content-Length before the body is inspected, so an
// oversized POST never reaches validation (or GitHub). Matches Vercel's cap.
export const MAX_REQUEST_BYTES = 4.5 * 1024 * 1024;
export const MAX_TITLE_EXCERPT_LENGTH = 60;
export const MAX_USER_AGENT_LENGTH = 300;

// Best-effort per-IP throttle (see checkRateLimit).
export const RATE_LIMIT_MAX_REQUESTS = 5;
export const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_KEYS = 10000;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;

const IMAGE_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function asciiSlice(bytes, start, end) {
  let out = '';
  for (let i = start; i < end; i += 1) out += String.fromCharCode(bytes[i]);
  return out;
}

// Magic numbers for the three accepted formats. The declared MIME type is only a
// client claim; these bytes are what actually gets committed to a public repo.
const IMAGE_SIGNATURES = [
  {
    type: 'image/jpeg',
    ext: 'jpg',
    match: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    type: 'image/png',
    ext: 'png',
    match: (b) => b.length >= 8
      && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v),
  },
  {
    type: 'image/webp',
    ext: 'webp',
    match: (b) => b.length >= 12 && asciiSlice(b, 0, 4) === 'RIFF' && asciiSlice(b, 8, 12) === 'WEBP',
  },
];

const ALLOWED_ORIGINS = new Set([
  'https://negative-converter.tokugai.com',
  // Tauri desktop webview origins (macOS/Linux and Windows)
  'tauri://localhost',
  'http://tauri.localhost',
]);

const LOCAL_DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

// Localhost origins are reflected only when the caller says this is not a production
// deployment (the handler passes VERCEL_ENV !== 'production', plus an explicit env
// opt-in: `npm run tauri:dev` serves from http://127.0.0.1:4173 and posts to the
// production endpoint, so that flow needs FEEDBACK_ALLOW_LOCAL_ORIGINS=1).
// This never rejects a request — an unknown origin just gets no CORS headers, as before.
export function resolveCorsOrigin(origin, { allowLocalOrigins = false } = {}) {
  if (typeof origin !== 'string' || origin === '') return null;
  if (ALLOWED_ORIGINS.has(origin)) return origin;
  if (allowLocalOrigins && LOCAL_DEV_ORIGIN.test(origin)) return origin;
  return null;
}

// The endpoint only ever accepts a JSON document; anything else is rejected before
// the body is looked at.
export function isJsonContentType(contentType) {
  const value = Array.isArray(contentType) ? contentType[0] : contentType;
  if (typeof value !== 'string') return false;
  return /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i.test(value.trim());
}

// Content-Length is a client claim, but an honest oversized upload gets rejected
// here instead of being validated (the platform enforces the real cap).
export function isRequestTooLarge(headers = {}) {
  const raw = headers['content-length'];
  const declared = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(declared) && declared > MAX_REQUEST_BYTES;
}

export function clientKeyFromHeaders(headers = {}) {
  const pick = (name) => {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === 'string' ? value : '';
  };
  const realIp = pick('x-real-ip').trim();
  const forwarded = pick('x-forwarded-for').split(',')[0].trim();
  return (realIp || forwarded || 'unknown').slice(0, 64);
}

// Per-instance sliding window. Deliberately best effort: Vercel (Fluid Compute in
// particular) reuses warm instances but gives no guarantee about how many are live,
// so each instance keeps its own counters and a cold start resets them. It stops a
// naive curl loop from one IP; a real guarantee needs a shared store (KV/Redis) or a
// platform firewall rule. Header-derived keys are spoofable by non-browser clients
// too, so treat this as a speed bump rather than a control.
const rateLimitBuckets = new Map();

export function checkRateLimit(key, now = Date.now(), store = rateLimitBuckets) {
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  for (const [bucketKey, hits] of store) {
    const kept = hits.filter((at) => at > windowStart);
    if (kept.length) store.set(bucketKey, kept);
    else store.delete(bucketKey);
  }
  // Memory guard for a long-lived instance under key-rotating abuse.
  if (store.size > RATE_LIMIT_MAX_KEYS) store.clear();

  const hits = store.get(key) || [];
  if (hits.length >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterSeconds = Math.max(1, Math.ceil((hits[0] + RATE_LIMIT_WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfterSeconds };
  }
  hits.push(now);
  store.set(key, hits);
  return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - hits.length };
}

// Returns { spam: true } | { error: string } | { data: {type, message, lang, source, images} }.
export function validateFeedback(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid_body' };
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

// Returns { type, ext } for the format the bytes actually are, or null.
export function sniffImageType(base64) {
  if (typeof base64 !== 'string' || base64 === '') return null;
  // 24 base64 chars decode to 18 bytes — more than the longest signature (WebP, 12).
  const head = Buffer.from(base64.slice(0, 24), 'base64');
  for (const sig of IMAGE_SIGNATURES) {
    if (sig.match(head)) return { type: sig.type, ext: sig.ext };
  }
  return null;
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
    if (!IMAGE_EXTENSIONS[img.type]) return { error: 'unsupported_image_type' };
    const data = typeof img.data === 'string' ? img.data : '';
    if (!data || data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) return { error: 'invalid_images' };
    const bytes = Math.floor(data.length * 3 / 4);
    if (bytes > MAX_IMAGE_BYTES) return { error: 'image_too_large' };
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) return { error: 'images_too_large' };
    // Size checks first (cheap), then the magic bytes: the extension we commit and
    // the bytes we host must agree with what the client claimed to be sending.
    const sniffed = sniffImageType(data);
    if (!sniffed || sniffed.type !== img.type) return { error: 'unsupported_image_type' };
    out.push({ data, ext: sniffed.ext });
  }
  return { images: out };
}

// GitHub renders the issue body as markdown authored by whoever owns the token, so
// raw user text could ping real accounts (`@someone`), cross-link real issues
// (`owner/repo#12`) or forge the metadata block. A fenced code block is the one
// construct GitHub scans for none of that; making the fence one backtick longer than
// the longest run inside the text means the text cannot close it (CommonMark only
// closes a fence with a run at least as long as the opener), so breakout is
// structurally impossible instead of a matter of escaping the right characters.
export function fenceUserText(text) {
  const value = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  let longestRun = 0;
  for (const run of value.match(/`+/g) || []) longestRun = Math.max(longestRun, run.length);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${value}\n${fence}`;
}

// Same idea for short single-line values: a code span, with backticks and control
// characters removed so the span always closes where we say it does.
export function inlineUserText(text) {
  const value = String(text == null ? '' : text)
    .replace(CONTROL_CHARS, ' ')
    .replace(/`/g, "'")
    .trim();
  return value ? `\`${value}\`` : '';
}

// imageOutcome: { urls: [string|null, ...] } — null entries are uploads that failed.
export function buildIssuePayload(data, userAgent = '', imageOutcome = null) {
  // Issue titles are plain text on GitHub (no markdown, no mention linkification),
  // so the excerpt only needs its whitespace and control characters flattened.
  const excerptSource = data.message
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const excerpt = excerptSource.length > MAX_TITLE_EXCERPT_LENGTH
    ? `${excerptSource.slice(0, MAX_TITLE_EXCERPT_LENGTH)}…`
    : excerptSource;
  const meta = [
    `**Type:** ${data.type}`,
    `**UI language:** ${data.lang}`,
    `**Source:** ${data.source}`,
  ];
  const ua = inlineUserText(String(userAgent || '').slice(0, MAX_USER_AGENT_LENGTH));
  if (ua) meta.push(`**User agent:** ${ua}`);
  let body = `${meta.join('\n')}\n\n---\n\n${fenceUserText(data.message)}`;
  const urls = imageOutcome && Array.isArray(imageOutcome.urls) ? imageOutcome.urls : [];
  if (urls.length) {
    // These URLs come from the upload response, not from user input.
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
