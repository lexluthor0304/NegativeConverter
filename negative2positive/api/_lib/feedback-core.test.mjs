import assert from 'node:assert/strict';
import {
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_MESSAGE_LENGTH,
  MAX_REQUEST_BYTES,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
  buildIssuePayload,
  checkRateLimit,
  clientKeyFromHeaders,
  fenceUserText,
  inlineUserText,
  isJsonContentType,
  isRequestTooLarge,
  resolveCorsOrigin,
  sniffImageType,
  validateFeedback,
  validateImages,
} from './feedback-core.mjs';

const TICK = '`';

// --- resolveCorsOrigin ---
assert.equal(resolveCorsOrigin('https://negative-converter.tokugai.com'), 'https://negative-converter.tokugai.com');
assert.equal(resolveCorsOrigin('tauri://localhost'), 'tauri://localhost');
assert.equal(resolveCorsOrigin('http://tauri.localhost'), 'http://tauri.localhost');
// Localhost is a dev-only allowance: production (allowLocalOrigins false) must not
// reflect it, so a page on someone's machine cannot drive the live endpoint.
assert.equal(resolveCorsOrigin('http://localhost:5173'), null);
assert.equal(resolveCorsOrigin('http://127.0.0.1:4173'), null);
assert.equal(resolveCorsOrigin('http://localhost:5173', { allowLocalOrigins: false }), null);
assert.equal(resolveCorsOrigin('http://localhost:5173', { allowLocalOrigins: true }), 'http://localhost:5173');
assert.equal(resolveCorsOrigin('http://127.0.0.1:4173', { allowLocalOrigins: true }), 'http://127.0.0.1:4173');
// The desktop origins stay allowed regardless of the dev flag.
assert.equal(resolveCorsOrigin('tauri://localhost', { allowLocalOrigins: false }), 'tauri://localhost');
assert.equal(resolveCorsOrigin('https://evil.example.com'), null);
assert.equal(resolveCorsOrigin('https://evil.example.com', { allowLocalOrigins: true }), null);
assert.equal(resolveCorsOrigin('http://localhost.evil.com', { allowLocalOrigins: true }), null);
assert.equal(resolveCorsOrigin(undefined), null);
assert.equal(resolveCorsOrigin(''), null);

// --- isJsonContentType ---
assert.equal(isJsonContentType('application/json'), true);
assert.equal(isJsonContentType('application/json; charset=utf-8'), true);
assert.equal(isJsonContentType('APPLICATION/JSON'), true);
assert.equal(isJsonContentType('application/merge-patch+json'), true);
assert.equal(isJsonContentType('text/plain'), false);
assert.equal(isJsonContentType('multipart/form-data; boundary=x'), false);
assert.equal(isJsonContentType('application/jsonp'), false);
assert.equal(isJsonContentType(undefined), false);

// --- isRequestTooLarge ---
assert.equal(isRequestTooLarge({}), false);
assert.equal(isRequestTooLarge({ 'content-length': '1024' }), false);
assert.equal(isRequestTooLarge({ 'content-length': String(MAX_REQUEST_BYTES) }), false);
assert.equal(isRequestTooLarge({ 'content-length': String(MAX_REQUEST_BYTES + 1) }), true);
assert.equal(isRequestTooLarge({ 'content-length': 'nonsense' }), false);

// --- clientKeyFromHeaders ---
assert.equal(clientKeyFromHeaders({ 'x-real-ip': '203.0.113.7' }), '203.0.113.7');
assert.equal(clientKeyFromHeaders({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18' }), '203.0.113.7');
assert.equal(clientKeyFromHeaders({ 'x-real-ip': '', 'x-forwarded-for': ' 198.51.100.4 ' }), '198.51.100.4');
assert.equal(clientKeyFromHeaders({}), 'unknown');
assert.equal(clientKeyFromHeaders({ 'x-real-ip': 'a'.repeat(500) }).length, 64);

// --- checkRateLimit (injected clock + store so the module state stays clean) ---
{
  const store = new Map();
  let now = 1_000_000;
  for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
    assert.equal(checkRateLimit('1.2.3.4', now, store).allowed, true, `request ${i + 1} should pass`);
  }
  const blocked = checkRateLimit('1.2.3.4', now, store);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0);
  assert.ok(blocked.retryAfterSeconds <= RATE_LIMIT_WINDOW_MS / 1000);
  // Other clients are unaffected.
  assert.equal(checkRateLimit('5.6.7.8', now, store).allowed, true);
  // Still blocked inside the window, allowed once it has rolled past.
  now += RATE_LIMIT_WINDOW_MS - 1;
  assert.equal(checkRateLimit('1.2.3.4', now, store).allowed, false);
  now += 2;
  assert.equal(checkRateLimit('1.2.3.4', now, store).allowed, true);
  // Expired buckets get pruned rather than accumulating forever.
  checkRateLimit('9.9.9.9', now + RATE_LIMIT_WINDOW_MS * 10, store);
  assert.deepEqual([...store.keys()], ['9.9.9.9']);
}

// --- validateFeedback: rejects ---
assert.deepEqual(validateFeedback(null), { error: 'invalid_body' });
assert.deepEqual(validateFeedback('str'), { error: 'invalid_body' });
assert.deepEqual(validateFeedback([{ message: 'hi' }]), { error: 'invalid_body' });
assert.deepEqual(validateFeedback({}), { error: 'empty_message' });
assert.deepEqual(validateFeedback({ message: '   ' }), { error: 'empty_message' });
assert.deepEqual(validateFeedback({ message: 42 }), { error: 'empty_message' });
assert.deepEqual(
  validateFeedback({ message: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) }),
  { error: 'message_too_long' }
);

// --- validateFeedback: honeypot ---
assert.deepEqual(validateFeedback({ message: 'hi', website: 'http://spam.com' }), { spam: true });
// An empty honeypot value is what real browsers submit.
assert.equal(validateFeedback({ message: 'hi', website: '' }).spam, undefined);

// --- validateFeedback: normalization ---
{
  const { data } = validateFeedback({ message: '  hello  ', type: 'bug', lang: 'zh', source: 'desktop' });
  assert.deepEqual(data, { type: 'bug', message: 'hello', lang: 'zh', source: 'desktop', images: [] });
}
{
  const { data } = validateFeedback({ message: 'hi', type: 'exploit', lang: 'ZH!', source: 'weird' });
  assert.equal(data.type, 'other');
  assert.equal(data.lang, 'unknown');
  assert.equal(data.source, 'web');
}
{
  // Exactly at the limit passes.
  const { data } = validateFeedback({ message: 'x'.repeat(MAX_MESSAGE_LENGTH) });
  assert.equal(data.message.length, MAX_MESSAGE_LENGTH);
}

// --- fenceUserText / inlineUserText ---
assert.equal(fenceUserText('plain'), `${TICK.repeat(3)}text\nplain\n${TICK.repeat(3)}`);
// The fence always outruns the longest backtick run in the text, so nothing inside
// can close it early.
assert.equal(fenceUserText(TICK.repeat(3)), `${TICK.repeat(4)}text\n${TICK.repeat(3)}\n${TICK.repeat(4)}`);
assert.equal(
  fenceUserText(`a\n${TICK.repeat(7)}\nb`),
  `${TICK.repeat(8)}text\na\n${TICK.repeat(7)}\nb\n${TICK.repeat(8)}`
);
assert.equal(fenceUserText('a\r\nb'), `${TICK.repeat(3)}text\na\nb\n${TICK.repeat(3)}`);
assert.equal(inlineUserText('Mozilla/5.0'), `${TICK}Mozilla/5.0${TICK}`);
assert.equal(inlineUserText(`ev${TICK}il`), `${TICK}ev'il${TICK}`);
assert.equal(inlineUserText('  '), '');
assert.equal(inlineUserText(undefined), '');

// --- buildIssuePayload ---
{
  const payload = buildIssuePayload(
    { type: 'bug', message: 'Line one\nLine two', lang: 'ja', source: 'web' },
    'Mozilla/5.0 Test'
  );
  assert.equal(payload.title, '[feedback] bug: Line one Line two');
  assert.ok(payload.body.includes('**Type:** bug'));
  assert.ok(payload.body.includes('**UI language:** ja'));
  assert.ok(payload.body.includes('**Source:** web'));
  assert.ok(payload.body.includes(`**User agent:** ${TICK}Mozilla/5.0 Test${TICK}`));
  assert.ok(payload.body.endsWith(`${TICK.repeat(3)}text\nLine one\nLine two\n${TICK.repeat(3)}`));
  assert.deepEqual(payload.labels, ['feedback']);
}
{
  // Long messages get an ellipsized single-line title; UA is capped.
  const payload = buildIssuePayload(
    { type: 'idea', message: 'y'.repeat(500), lang: 'en', source: 'web' },
    'U'.repeat(1000)
  );
  assert.equal(payload.title, `[feedback] idea: ${'y'.repeat(60)}…`);
  assert.ok(payload.body.includes(`**User agent:** ${TICK}${'U'.repeat(300)}${TICK}\n`));
  assert.ok(!payload.body.includes('U'.repeat(301)));
}
{
  // No user agent -> no UA line.
  const payload = buildIssuePayload({ type: 'other', message: 'm', lang: 'en', source: 'web' });
  assert.ok(!payload.body.includes('**User agent:**'));
}

// --- buildIssuePayload: markdown / mention injection ---
{
  // Everything a reporter types has to land inside the fence: GitHub would
  // otherwise ping real accounts and cross-link real issues as the token owner.
  const message = [
    'Ping @octocat and @ghost please',
    'refs lexluthor0304/NegativeConverter#1 plus #42 and GH-7',
    TICK.repeat(3),
    '**Type:** admin',
    '# Fake heading',
    '<img src=x onerror=alert(1)>',
    '[link](https://evil.example.com)',
  ].join('\n');
  const payload = buildIssuePayload(
    { type: 'bug', message, lang: 'en', source: 'web' },
    `Mozilla/5.0 (@evil ${TICK}break${TICK} owner/repo#9)`
  );
  const fence = TICK.repeat(4); // one longer than the ``` run inside the message
  const start = payload.body.indexOf(`${fence}text\n`);
  assert.ok(start > 0, 'message must be fenced');
  // The tail of the body is exactly opener + message + closer: no way out.
  assert.equal(payload.body.slice(start), `${fence}text\n${message}\n${fence}`);
  // Nothing user-controlled leaks into the metadata block above the fence…
  const meta = payload.body.slice(0, start);
  assert.ok(!meta.includes('@octocat'));
  assert.ok(!meta.includes('#42'));
  assert.ok(!meta.includes('Fake heading'));
  // …and the UA, which is header-controlled, is a code span with its backticks
  // neutralized so it cannot close early either.
  assert.ok(meta.includes(`**User agent:** ${TICK}Mozilla/5.0 (@evil 'break' owner/repo#9)${TICK}\n`));
  assert.equal(meta.split(TICK).length - 1, 2, 'UA code span must be the only backtick pair in the meta block');
  // Issue titles are plain text on GitHub, but keep them single-line and unpadded.
  assert.equal(payload.title, '[feedback] bug: Ping @octocat and @ghost please refs lexluthor0304/NegativeC…');
  assert.ok(!payload.title.includes('\n'));
}
{
  // A message that tries to out-fence the wrapper still cannot escape it.
  const message = `${TICK.repeat(6)}\n@octocat\n${TICK.repeat(6)}`;
  const payload = buildIssuePayload({ type: 'bug', message, lang: 'en', source: 'web' }, '');
  const fence = TICK.repeat(7);
  assert.ok(payload.body.endsWith(`${fence}text\n${message}\n${fence}`));
}
{
  // Control characters never break the title out of one line.
  const payload = buildIssuePayload(
    { type: 'bug', message: 'a\u0000b\u001fc\u007fd', lang: 'en', source: 'web' },
    'UA\u0007x'
  );
  assert.equal(payload.title, '[feedback] bug: a b c d');
  assert.ok(payload.body.includes(`**User agent:** ${TICK}UA x${TICK}`));
}

// --- sniffImageType / validateImages ---
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const JPEG = b64([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const WEBP = b64([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
const NOT_AN_IMAGE = 'aGVsbG8='; // "hello"

assert.deepEqual(sniffImageType(JPEG), { type: 'image/jpeg', ext: 'jpg' });
assert.deepEqual(sniffImageType(PNG), { type: 'image/png', ext: 'png' });
assert.deepEqual(sniffImageType(WEBP), { type: 'image/webp', ext: 'webp' });
assert.equal(sniffImageType(NOT_AN_IMAGE), null);
assert.equal(sniffImageType(''), null);
assert.equal(sniffImageType(undefined), null);

assert.deepEqual(validateImages(undefined), { images: [] });
assert.deepEqual(validateImages(null), { images: [] });
assert.deepEqual(validateImages('nope'), { error: 'invalid_images' });
assert.deepEqual(
  validateImages(Array.from({ length: MAX_IMAGES + 1 }, () => ({ type: 'image/jpeg', data: JPEG }))),
  { error: 'too_many_images' }
);
assert.deepEqual(validateImages([{ type: 'image/gif', data: JPEG }]), { error: 'unsupported_image_type' });
assert.deepEqual(validateImages([{ type: 'image/jpeg', data: 'not base64!!' }]), { error: 'invalid_images' });
assert.deepEqual(validateImages([{ type: 'image/jpeg', data: '' }]), { error: 'invalid_images' });
// The declared MIME type is not trusted: the bytes have to match it.
assert.deepEqual(validateImages([{ type: 'image/jpeg', data: NOT_AN_IMAGE }]), { error: 'unsupported_image_type' });
assert.deepEqual(validateImages([{ type: 'image/png', data: JPEG }]), { error: 'unsupported_image_type' });
assert.deepEqual(validateImages([{ type: 'image/webp', data: PNG }]), { error: 'unsupported_image_type' });
{
  const big = 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES + 4) * 4 / 3 / 4) * 4);
  // Size is checked before the signature, so an oversized blob is still too large.
  assert.deepEqual(validateImages([{ type: 'image/jpeg', data: big }]), { error: 'image_too_large' });
}
{
  const { images } = validateImages([
    { type: 'image/jpeg', data: JPEG },
    { type: 'image/png', data: PNG },
    { type: 'image/webp', data: WEBP },
  ]);
  assert.deepEqual(images.map(i => i.ext), ['jpg', 'png', 'webp']);
}
{
  // validateFeedback threads image errors and defaults to empty list
  assert.deepEqual(validateFeedback({ message: 'hi', images: 'x' }), { error: 'invalid_images' });
  assert.deepEqual(validateFeedback({ message: 'hi' }).data.images, []);
  // What the web/desktop client actually sends (canvas JPEG) still passes.
  assert.deepEqual(
    validateFeedback({ message: 'hi', images: [{ type: 'image/jpeg', data: JPEG }] }).data.images,
    [{ data: JPEG, ext: 'jpg' }]
  );
}

// --- buildIssuePayload with images ---
{
  const data = { type: 'bug', message: 'm', lang: 'en', source: 'web', images: [] };
  const payload = buildIssuePayload(data, '', { urls: ['https://x/1.jpg', null, 'https://x/3.jpg'] });
  assert.ok(payload.body.includes('![feedback image 1](https://x/1.jpg)'));
  assert.ok(payload.body.includes('![feedback image 3](https://x/3.jpg)'));
  assert.ok(payload.body.includes('_(1 attached image failed to upload)_'));
}
{
  // No images -> no screenshots section
  const payload = buildIssuePayload({ type: 'bug', message: 'm', lang: 'en', source: 'web' }, '', { urls: [] });
  assert.ok(!payload.body.includes('feedback image'));
}

console.log('feedback-core tests passed');
