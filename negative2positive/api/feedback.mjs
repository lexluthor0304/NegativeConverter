// Vercel serverless function: receives feedback from the app and files it as a
// GitHub issue. Attached images are committed to the orphan branch
// `feedback-assets` via the Contents API and embedded in the issue body.
// Requires env vars:
//   FEEDBACK_GITHUB_TOKEN  fine-grained PAT with Issues RW (+ Contents RW for images)
//   FEEDBACK_GITHUB_REPO   optional "owner/repo" override (defaults to the app repo)
import { buildIssuePayload, resolveCorsOrigin, validateFeedback } from './_lib/feedback-core.mjs';

const DEFAULT_REPO = 'lexluthor0304/NegativeConverter';
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const ASSETS_BRANCH = 'feedback-assets';

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'negative-converter-feedback',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// Best effort: a failed upload becomes a null URL and the issue is still filed.
async function uploadImages(repo, token, images) {
  const urls = [];
  const stamp = Date.now();
  const month = new Date(stamp).toISOString().slice(0, 7);
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const path = `${month}/${stamp}-${i + 1}.${img.ext}`;
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
        method: 'PUT',
        headers: githubHeaders(token),
        body: JSON.stringify({
          // The assets branch carries a vercel.json with git.deploymentEnabled
          // false, so these commits don't spawn doomed builds.
          message: `Add feedback image ${stamp}-${i + 1}`,
          content: img.data,
          branch: ASSETS_BRANCH,
        }),
      });
      if (!res.ok) {
        console.error('Feedback image upload failed', res.status, (await res.text().catch(() => '')).slice(0, 300));
        urls.push(null);
        continue;
      }
      const payload = await res.json();
      urls.push(payload && payload.content && payload.content.download_url
        ? payload.content.download_url
        : `https://raw.githubusercontent.com/${repo}/${ASSETS_BRANCH}/${path}`);
    } catch (err) {
      console.error('Feedback image upload error', err);
      urls.push(null);
    }
  }
  return { urls };
}

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

  let imageOutcome = null;
  if (result.data.images.length) {
    imageOutcome = await uploadImages(repo, token, result.data.images);
  }

  const payload = buildIssuePayload(result.data, req.headers['user-agent'], imageOutcome);
  try {
    const ghRes = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: githubHeaders(token),
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
