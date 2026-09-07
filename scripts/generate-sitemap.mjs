import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root, site, searchFiles, canonicalPath } from './search-files.mjs';
const entries=searchFiles().map(file=>{
  const html=readFileSync(resolve(root,file),'utf8');
  const date=html.match(/"dateModified"\s*:\s*"(\d{4}-\d{2}-\d{2})"/)?.[1];
  const alternates=[...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g)];
  return `  <url>\n    <loc>${site+canonicalPath(file)}</loc>${date?`\n    <lastmod>${date}</lastmod>`:''}\n${alternates.map(m=>`    <xhtml:link rel="alternate" hreflang="${m[1]}" href="${m[2]}"/>`).join('\n')}\n  </url>`;
});
const xml=`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${entries.join('\n')}\n</urlset>\n`;
const target=resolve(root,'public/sitemap.xml');
if(process.argv.includes('--check')) {
  if(readFileSync(target,'utf8')!==xml){console.error('Sitemap is stale; run npm run seo:generate');process.exit(1);}
} else writeFileSync(target,xml);
console.log(`Sitemap: ${entries.length} canonical HTML pages ${process.argv.includes('--check')?'in sync':'generated'}`);
