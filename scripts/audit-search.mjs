// Read-only HTTP audit. No credentials, cookies, or analytics events.
const base = (process.argv[2] || 'https://negative-converter.tokugai.com').replace(/\/$/, '');
const sitemap = await fetch(`${base}/sitemap.xml`).then(r => r.text());
const paths = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => new URL(m[1]).pathname).filter(p => !/\.(txt|md)$/.test(p));
const tag = (text, re) => text.match(re)?.[1] || null;
const pages = [];
for (let i = 0; i < paths.length; i += 4) {
  const chunk = await Promise.all(paths.slice(i, i + 4).map(async path => {
    const start = performance.now(), res = await fetch(base + path), html = await res.text();
    const text = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
    return { path, status: res.status, finalUrl: res.url, ms: Math.round(performance.now() - start), bytes: Buffer.byteLength(html),
      title: tag(html, /<title>([^<]+)<\/title>/), description: tag(html, /<meta name="description" content="([^"]+)"/),
      canonical: tag(html, /<link rel="canonical" href="([^"]+)"/), robots: tag(html, /<meta name="robots" content="([^"]+)"/),
      h1: [...text.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map(m => m[1].replace(/<[^>]*>/g,'')),
      staticSchemaTypes: [...html.matchAll(/"@type"\s*:\s*"([^"]+)"/g)].map(m => m[1]),
      internalLinks: [...text.matchAll(/href="([^"#]+)"/g)].map(m => m[1]).filter(v=>v.startsWith('/')||v.startsWith('./')),
      headers: Object.fromEntries(['x-robots-tag','content-type','permissions-policy','cache-control'].map(k=>[k,res.headers.get(k)])) };
  }));
  pages.push(...chunk);
}
const missing = await fetch(`${base}/search-audit-nonexistent-page-20260907`).then(r => ({ status: r.status, url: r.url }));
const robots = await fetch(`${base}/robots.txt`).then(r => r.text());
console.log(JSON.stringify({ auditedAt: new Date().toISOString(), base, pages, missingPage: missing, robots,
  limitations: ['HTTP timings are single lab observations, not Core Web Vitals.', 'Schema here is static source only; rendered DOM is checked separately.', 'Index coverage and search/AI impressions require owner analytics.'] }, null, 2));
