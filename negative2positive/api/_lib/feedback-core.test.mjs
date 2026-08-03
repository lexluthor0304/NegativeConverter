import assert from 'node:assert/strict';
import {
  MAX_MESSAGE_LENGTH,
  buildIssuePayload,
  resolveCorsOrigin,
  validateFeedback,
} from './feedback-core.mjs';

// --- resolveCorsOrigin ---
assert.equal(resolveCorsOrigin('https://negative-converter.tokugai.com'), 'https://negative-converter.tokugai.com');
assert.equal(resolveCorsOrigin('tauri://localhost'), 'tauri://localhost');
assert.equal(resolveCorsOrigin('http://tauri.localhost'), 'http://tauri.localhost');
assert.equal(resolveCorsOrigin('http://localhost:5173'), 'http://localhost:5173');
assert.equal(resolveCorsOrigin('http://127.0.0.1:4173'), 'http://127.0.0.1:4173');
assert.equal(resolveCorsOrigin('https://evil.example.com'), null);
assert.equal(resolveCorsOrigin('http://localhost.evil.com'), null);
assert.equal(resolveCorsOrigin(undefined), null);
assert.equal(resolveCorsOrigin(''), null);

// --- validateFeedback: rejects ---
assert.deepEqual(validateFeedback(null), { error: 'invalid_body' });
assert.deepEqual(validateFeedback('str'), { error: 'invalid_body' });
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
  assert.deepEqual(data, { type: 'bug', message: 'hello', lang: 'zh', source: 'desktop' });
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
  assert.ok(payload.body.includes('**User agent:** Mozilla/5.0 Test'));
  assert.ok(payload.body.endsWith('Line one\nLine two'));
  assert.deepEqual(payload.labels, ['feedback']);
}
{
  // Long messages get an ellipsized single-line title; UA is capped.
  const payload = buildIssuePayload(
    { type: 'idea', message: 'y'.repeat(500), lang: 'en', source: 'web' },
    'U'.repeat(1000)
  );
  assert.equal(payload.title, `[feedback] idea: ${'y'.repeat(60)}…`);
  assert.ok(payload.body.includes(`**User agent:** ${'U'.repeat(300)}\n`));
  assert.ok(!payload.body.includes('U'.repeat(301)));
}
{
  // No user agent -> no UA line.
  const payload = buildIssuePayload({ type: 'other', message: 'm', lang: 'en', source: 'web' });
  assert.ok(!payload.body.includes('**User agent:**'));
}

console.log('feedback-core tests passed');
