// Where download.html reads the release manifest (#229 review R2-048, R2-050).
//
// latest.json lists the desktop installers. The page builds every download
// link on the base it read the manifest from and shows the SHA-256 values the
// manifest gives. The release workflows publish it in one place only, the
// release bucket's public origin, which answers with
// `Access-Control-Allow-Origin: *`; the site has no copy
// (scripts/check-updater-manifest.mjs holds the page to it).
//
// `?r2_base=<base>` (or `?r2Base=`) points the page at another bucket, to
// try a release before it is public. Only a loopback host or a Vercel preview
// deployment honours it: on the site, a crafted link would show another
// origin's installers and hashes on the official domain.

export const RELEASE_BASE_URL = 'https://download.neoanaloglab.com';
export const RELEASE_MANIFEST_PATH = 'negative-converter/release/latest.json';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const PREVIEW_HOST_SUFFIX = '.vercel.app';

/** A base URL without surrounding blanks and trailing slashes. */
export function normalizeBaseUrl(base) {
  if (!base) return '';
  return String(base).trim().replace(/\/+$/, '');
}

function parseHttpUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** Whether the page at `pageUrl` takes `?r2_base=` into account. */
export function honoursReleaseBaseOverride(pageUrl) {
  const page = parseHttpUrl(pageUrl);
  if (!page) return false;
  const host = page.hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(host) || host.endsWith(PREVIEW_HOST_SUFFIX);
}

/** The bases to read latest.json from, in order, for the page at `pageUrl`. */
export function releaseManifestBases(pageUrl) {
  const bases = [];
  if (honoursReleaseBaseOverride(pageUrl)) {
    const params = new URL(pageUrl).searchParams;
    const override = parseHttpUrl(params.get('r2_base') || params.get('r2Base'));
    if (override) bases.push(normalizeBaseUrl(override.href));
  }
  bases.push(RELEASE_BASE_URL);
  return Array.from(new Set(bases));
}

/** Where latest.json lives under `base`. */
export function releaseManifestUrl(base) {
  return `${normalizeBaseUrl(base)}/${RELEASE_MANIFEST_PATH}`;
}
