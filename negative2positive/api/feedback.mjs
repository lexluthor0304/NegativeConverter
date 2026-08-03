// Vercel serverless function: receives feedback from the app and files it as a
// GitHub issue. Requires env vars:
//   FEEDBACK_GITHUB_TOKEN  fine-grained PAT with Issues read/write on the target repo
//   FEEDBACK_GITHUB_REPO   optional "owner/repo" override (defaults to the app repo)
import { buildIssuePayload, resolveCorsOrigin, validateFeedback } from './_lib/feedback-core.mjs';

const DEFAULT_REPO = 'lexluthor0304/NegativeConverter';
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;

export default async function handler(req, res) {
  const corsOrigin = resolveCorsOrigin(req.headers.origin);
  if (corsOrigin) {
    res.setHeader('Access-Control-Allow-Origin', corsOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const token = process.env.FEEDBACK_GITHUB_TOKEN;
  const repo = process.env.FEEDBACK_GITHUB_REPO || DEFAULT_REPO;
  if (!token || !REPO_PATTERN.test(repo)) {
    res.status(503).json({ error: 'not_configured' });
    return;
  }

  const result = validateFeedback(req.body);
  if (result.spam) {
    // Pretend success so bots don't learn they were filtered.
    res.status(201).json({ ok: true });
    return;
  }
  if (result.error) {
    res.status(400).json({ error: result.error });
    return;
  }

  const payload = buildIssuePayload(result.data, req.headers['user-agent']);
  try {
    const ghRes = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'negative-converter-feedback',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify(payload),
    });
    if (!ghRes.ok) {
      const detail = await ghRes.text().catch(() => '');
      console.error('GitHub issue creation failed', ghRes.status, detail.slice(0, 500));
      res.status(502).json({ error: 'upstream_failed' });
      return;
    }
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('GitHub request error', err);
    res.status(502).json({ error: 'upstream_failed' });
  }
}
