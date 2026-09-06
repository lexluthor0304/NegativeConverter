// Vercel serverless function: receives feedback from the app and files it as a
// GitHub issue. Attached images are committed to the orphan branch
// `feedback-assets` via the Contents API and embedded in the issue body.
// Requires env vars:
//   FEEDBACK_GITHUB_TOKEN  fine-grained PAT with Issues RW (+ Contents RW for images)
//   FEEDBACK_GITHUB_REPO   optional "owner/repo" override (defaults to the app repo)
//   FEEDBACK_ALLOW_LOCAL_ORIGINS  set to "1" to keep reflecting http://localhost:*
//                          origins in production CORS (needed only while testing the
//                          desktop app with `npm run tauri:dev`, which serves from
//                          http://127.0.0.1:4173 but posts to the production endpoint)
import {
  buildIssuePayload,
  checkRateLimit,
  clientKeyFromHeaders,
  isJsonContentType,
  isRequestTooLarge,
  resolveCorsOrigin,
  validateFeedback,
} from './_lib/feedback-core.mjs';

const DEFAULT_REPO = 'lexluthor0304/NegativeConverter';
const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const ASSETS_BRANCH = 'feedback-assets';

// Token scope. FEEDBACK_GITHUB_TOKEN needs the minimum that still works:
//   Issues: read & write   — required, to POST the issue
//   Contents: read & write — required ONLY to commit attached images to the
//                            `feedback-assets` branch; drop it if image uploads
//                            are ever removed, and scope the PAT to this single repo.
// Contents:write is the sharp edge: it is repo-wide, not branch-scoped, so anyone
// who reads this token out of the Vercel environment can also push to `main` — and
// merging to main auto-releases the desktop app (see docs/mas-release.md). Mitigate
// with a ruleset on `main` requiring a PR with an empty bypass list, or by moving the
// assets to a throwaway repo with its own Contents-only token. Nothing else here
// needs write access: no PR, workflow, or Actions permissions.
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
// Also reports what landed in the branch so a failed issue can be rolled back.
async function uploadImages(repo, token, images) {
  const urls = [];
  const uploaded = [];
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
      if (payload && payload.content && payload.content.sha) {
        uploaded.push({ path, sha: payload.content.sha });
      }
      urls.push(payload && payload.content && payload.content.download_url
        ? payload.content.download_url
        : `https://raw.githubusercontent.com/${repo}/${ASSETS_BRANCH}/${path}`);
    } catch (err) {
      console.error('Feedback image upload error', err);
      urls.push(null);
    }
  }
  return { urls, uploaded };
}

// Images have to be committed before the issue body can reference them, so a run
// that fails at the issue step would otherwise leave anonymous blobs in a public
// branch with nothing pointing at them. Best effort: log and move on if a delete
// fails, since the caller has already decided the request failed.
async function deleteUploadedImages(repo, token, uploaded) {
  for (const { path, sha } of uploaded) {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
        method: 'DELETE',
        headers: githubHeaders(token),
        body: JSON.stringify({
          message: `Remove orphaned feedback image ${path}`,
          sha,
          branch: ASSETS_BRANCH,
        }),
      });
      if (!res.ok) {
        console.error('Orphaned feedback image cleanup failed', res.status, path);
      }
    } catch (err) {
      console.error('Orphaned feedback image cleanup error', err);
    }
  }
}

export default async function handler(req, res) {
  // Localhost origins are reflected outside production only, so a page on a
  // developer's machine can't drive the live endpoint from a visitor's browser.
  const allowLocalOrigins = process.env.VERCEL_ENV !== 'production'
    || process.env.FEEDBACK_ALLOW_LOCAL_ORIGINS === '1';
  const corsOrigin = resolveCorsOrigin(req.headers.origin, { allowLocalOrigins });
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

  // Cheap rejects before anything is parsed, throttled or forwarded to GitHub.
  if (isRequestTooLarge(req.headers)) {
    res.status(413).json({ error: 'payload_too_large' });
    return;
  }
  if (!isJsonContentType(req.headers['content-type'])) {
    res.status(400).json({ error: 'invalid_content_type' });
    return;
  }

  // Per-IP throttle. Best effort only — see checkRateLimit for why an in-memory
  // counter cannot be a guarantee on serverless instances.
  const rate = checkRateLimit(clientKeyFromHeaders(req.headers));
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSeconds));
    res.status(429).json({ error: 'rate_limited' });
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
      if (imageOutcome) await deleteUploadedImages(repo, token, imageOutcome.uploaded || []);
      res.status(502).json({ error: 'upstream_failed' });
      return;
    }
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('GitHub request error', err);
    if (imageOutcome) await deleteUploadedImages(repo, token, imageOutcome.uploaded || []);
    res.status(502).json({ error: 'upstream_failed' });
  }
}
