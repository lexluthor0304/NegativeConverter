import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { root, site, searchFiles, canonicalPath } from './search-files.mjs';
import { searchPages } from '../negative2positive/content/search-pages.mjs';
const files=searchFiles();
const pages=new Map(files.map(file=>[site+canonicalPath(file), {file,html:readFileSync(resolve(root,file),'utf8')}]));
const normalize=s=>s.replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/\s+/g,' ').trim();
const sitemap=readFileSync(resolve(root,'public/sitemap.xml'),'utf8');
const locations=[...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m=>m[1]);
assert.equal(locations.length,new Set(locations).size,'sitemap duplicate URLs');
assert.deepEqual(new Set(locations),new Set(pages.keys()),'sitemap and published HTML must match');
const schemaNodes=[];
function walk(node){if(Array.isArray(node))return node.forEach(walk);if(node&&typeof node==='object'){schemaNodes.push(node);Object.values(node).forEach(walk);}}
for(const [url,{file,html}] of pages){
  const body=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'');
  assert.equal([...body.matchAll(/<h1\b/g)].length,1,`${file}: exactly one static H1`);
  assert.ok(html.includes(`<link rel="canonical" href="${url}">`),`${file}: self canonical`);
  assert.ok(!/name="robots"[^>]*noindex/.test(html),`${file}: indexable`);
  for(const block of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)){
    let parsed;try{parsed=JSON.parse(block[1]);}catch(e){assert.fail(`${file}: invalid JSON-LD: ${e.message}`);}walk(parsed);
  }
  const alternates=[...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g)];
  assert.ok(alternates.some(m=>m[2]===url&&m[1]!=='x-default'),`${file}: self hreflang`);
  for(const [,language,target] of alternates){
    assert.ok(pages.has(target),`${file}: alternate target exists: ${target}`);
    if(target!==url)assert.ok(pages.get(target).html.includes(`href="${url}"`),`${file}: reciprocal alternate from ${language}`);
  }
  for(const [,href] of body.matchAll(/<a\b[^>]*href="([^"]+)"/g)){
    const link=new URL(href,url);
    if(link.origin!==site||link.pathname==='/')continue;
    const target=link.pathname.endsWith('/')?link.pathname.slice(1)+'index.html':link.pathname.slice(1);
    assert.ok(existsSync(resolve(root,target))||existsSync(resolve(root,'public',target)),`${file}: broken internal link ${href}`);
  }
  for(const img of body.matchAll(/<img\b([^>]+)>/g))assert.match(img[1],/\balt="[^"]*"/,`${file}: image missing alt`);
  if(searchPages.some(page=>page.path===file)){
    const page=searchPages.find(page=>page.path===file);
    for(const [q,a] of page.faqs){assert.ok(normalize(body).includes(normalize(q)),`${file}: visible FAQ question`);assert.ok(normalize(body).includes(normalize(a)),`${file}: visible FAQ answer`);}
  }
}
assert.ok(schemaNodes.some(n=>n['@type']==='WebApplication'&&n.name==='Negative Converter'));
assert.ok(schemaNodes.some(n=>n['@type']==='Organization'&&n.name==='NeoAnalogLab'));
assert.ok(!schemaNodes.some(n=>n['@type']==='AggregateRating'),'Do not invent ratings for rich results');
const robots=readFileSync(resolve(root,'public/robots.txt'),'utf8');
assert.ok(robots.includes('User-agent: OAI-SearchBot\nAllow: /'));
assert.ok(robots.includes('User-agent: PerplexityBot\nAllow: /'));
assert.ok(robots.includes(`Sitemap: ${site}/sitemap.xml`));
for(const script of ['generate-search-pages.mjs','generate-sitemap.mjs'])execFileSync(process.execPath,[resolve(root,'../scripts',script),'--check'],{stdio:'inherit'});
console.log(`Search contract: ${pages.size} pages, static headings, JSON-LD, language reciprocity, internal links and sitemap passed`);
