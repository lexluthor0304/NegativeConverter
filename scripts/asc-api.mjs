// App Store Connect API client shared by the release lanes
// (ios-ensure-store-profile.mjs, .github/scripts/asc_mas_state.mjs): an
// ES256 JWT signed with the team key and a JSON fetch that throws with
// Apple's error detail. Credentials come from the release secrets
// ASC_API_KEY_ID, ASC_API_ISSUER_ID and ASC_API_KEY_P8 (the .p8 as base64).
import { createSign } from 'node:crypto';

const b64url = (buffer) => Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function ascToken({ keyId, issuerId, keyP8Base64, ttlSeconds = 900 }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: issuerId, iat: now, exp: now + ttlSeconds, aud: 'appstoreconnect-v1' }));
  const signer = createSign('SHA256');
  signer.update(`${header}.${payload}`);
  const key = Buffer.from(keyP8Base64, 'base64').toString('utf8');
  return `${header}.${payload}.${b64url(signer.sign({ key, dsaEncoding: 'ieee-p1363' }))}`;
}

// Returns request(method, path, body): the parsed JSON (null for 204), or an
// Error "<METHOD> <path> -> HTTP <status>: <errors>" when Apple refuses.
export function ascClient(credentials) {
  const token = ascToken(credentials);
  return async function request(method, path, body) {
    const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 204) return null;
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
    if (!response.ok) {
      const detail = JSON.stringify(json.errors ?? json).slice(0, 700);
      throw new Error(`${method} ${path} -> HTTP ${response.status}: ${detail}`);
    }
    return json;
  };
}

export const ASC_ENV_NAMES = ['ASC_API_KEY_ID', 'ASC_API_ISSUER_ID', 'ASC_API_KEY_P8'];

export function ascClientFromEnv(env = process.env) {
  const missing = ASC_ENV_NAMES.filter((name) => !env[name]);
  if (missing.length) throw new Error(`missing ${missing.join(', ')}`);
  return ascClient({ keyId: env.ASC_API_KEY_ID, issuerId: env.ASC_API_ISSUER_ID, keyP8Base64: env.ASC_API_KEY_P8 });
}
