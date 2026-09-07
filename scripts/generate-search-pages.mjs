// Author content once; visible answers and structured data share that source.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchPages } from '../negative2positive/content/search-pages.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'negative2positive');
const site = 'https://negative-converter.tokugai.com';
const date = '2026-09-07';
const esc = value => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const localeLinks = [['en', '/'], ['zh-Hans', '/zh/'], ['ja', '/ja/'], ['x-default', '/']];
const labels = {
  en: { home:'Home', open:'Open converter', guide:'Guide', about:'About', faq:'Questions and answers', updated:'Updated', publisher:'Published by', related:'Related guides', langs:'Languages' },
  'zh-Hans': {home:'首页',open:'打开转换器',guide:'英文指南',about:'关于项目（英文）',faq:'常见问题',updated:'更新日期',publisher:'发布者',related:'相关英文指南',langs:'语言'},
  ja: {home:'ホーム',open:'変換ツールを開く',guide:'英語ガイド',about:'プロジェクト情報（英語）',faq:'よくある質問',updated:'更新日',publisher:'公開元',related:'関連ガイド（英語）',langs:'言語'}
};
const pathFor = page => '/' + page.path.replace(/index\.html$/, '');
const related = searchPages.filter(page=>page.lang==='en'&&page.path!=='about.html');
let stale = false;
for (const page of searchPages) {
  const ui = labels[page.lang], path = pathFor(page), url = site + path;
  const langQuery = page.lang === 'zh-Hans' ? 'zh' : page.lang;
  const app = page.lang==='en' ? '/' : `/?lang=${langQuery}`;
  const alts = page.homeAlternate ? localeLinks : [[page.lang,path],['x-default',path]];
  const article = { '@type': page.homeAlternate ? 'WebPage' : 'Article', '@id':url+'#article', headline:page.heading,
    name:page.heading, description:page.description, url, inLanguage:page.lang, datePublished:date,dateModified:date,
    mainEntityOfPage:url, author:{'@id':site+'/#org'},publisher:{'@id':site+'/#org'},image:site+'/og-cover.png',isAccessibleForFree:true };
  const graph = [article,
    {'@type':'Organization','@id':site+'/#org',name:'NeoAnalogLab',url:site+'/about.html',sameAs:['https://github.com/lexluthor0304/NegativeConverter']},
    {'@type':'BreadcrumbList','@id':url+'#breadcrumbs',itemListElement:[{'@type':'ListItem',position:1,name:ui.home,item:site+'/'},{'@type':'ListItem',position:2,name:page.heading,item:url}]},
    {'@type':'FAQPage','@id':url+'#faq',inLanguage:page.lang,mainEntity:page.faqs.map(([name,text])=>({'@type':'Question',name,acceptedAnswer:{'@type':'Answer',text}}))}
  ];
  const body = `<!DOCTYPE html>
<html lang="${page.lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(page.title)}</title>
  <meta name="description" content="${esc(page.description)}">
  <meta name="author" content="NeoAnalogLab">
  <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1">
  <link rel="canonical" href="${url}">
${alts.map(([lang,href])=>`  <link rel="alternate" hreflang="${lang}" href="${site+href}">`).join('\n')}
  <link rel="stylesheet" href="/seo-content.css">
  <meta property="og:type" content="${page.homeAlternate?'website':'article'}">
  <meta property="og:site_name" content="Negative Converter by NeoAnalogLab">
  <meta property="og:title" content="${esc(page.title)}">
  <meta property="og:description" content="${esc(page.description)}">
  <meta property="og:url" content="${url}">
  <meta property="og:image" content="${site}/og-cover.png">
  <meta property="og:image:alt" content="Negative Converter by NeoAnalogLab">
  <meta property="og:locale" content="${page.lang==='ja'?'ja_JP':page.lang==='zh-Hans'?'zh_CN':'en_US'}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(page.title)}">
  <meta name="twitter:description" content="${esc(page.description)}">
  <meta name="twitter:image" content="${site}/og-cover.png">
  <meta name="theme-color" content="#17141f">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <script type="application/ld+json">
${JSON.stringify({'@context':'https://schema.org','@graph':graph},null,2).replace(/</g,'\\u003c')}
  </script>
  <script type="module" src="${page.path.includes('/')?'../':'./'}src/app/analytics.js"></script>
</head>
<body>
  <a class="skip-link" href="#content">${page.lang==='ja'?'本文へ':page.lang==='zh-Hans'?'跳至正文':'Skip to content'}</a>
  <header class="site-header"><a class="brand" href="/">NeoAnalogLab · Negative Converter</a><nav aria-label="${esc(ui.guide)}"><a href="/guide.html">${ui.guide}</a><a href="/about.html">${ui.about}</a><a class="cta" href="${app}">${ui.open}</a></nav></header>
  <main id="content">
    <nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">${ui.home}</a> / <span>${esc(page.heading)}</span></nav>
    <article>
      <section class="hero"><h1>${esc(page.heading)}</h1><p class="lead">${esc(page.lead)}</p><p class="page-meta">${ui.publisher} <a href="/about.html">NeoAnalogLab</a> · ${ui.updated}: <time datetime="${date}">${date}</time></p><div class="cta-row"><a class="btn primary" href="${app}">${ui.open}</a></div></section>
${page.sections.map(([heading,html],i)=>`      <section id="section-${i+1}"><h2>${esc(heading)}</h2>${html}</section>`).join('\n')}
      <section id="faq"><h2>${ui.faq}</h2>${page.faqs.map(([q,a])=>`<h3>${esc(q)}</h3><p>${esc(a)}</p>`).join('\n')}</section>
      <section><h2>${ui.related}</h2><ul>${related.filter(other=>other.path!==page.path).map(other=>`<li><a href="/${other.path}">${esc(other.heading)}</a></li>`).join('')}</ul></section>
    </article>
  </main>
  <footer><p>NeoAnalogLab · <a href="/about.html">${ui.about}</a> · <a href="/privacy.html">${page.lang==='ja'?'プライバシー':page.lang==='zh-Hans'?'隐私政策':'Privacy'}</a></p><nav aria-label="${ui.langs}"><a href="/" lang="en" hreflang="en">English</a> · <a href="/zh/" lang="zh-Hans" hreflang="zh-Hans">中文</a> · <a href="/ja/" lang="ja" hreflang="ja">日本語</a></nav></footer>
</body>
</html>
`;
  const target = resolve(root,page.path);
  if(process.argv.includes('--check')) {
    let actual='';try{actual=readFileSync(target,'utf8');}catch{}
    if(actual!==body){console.error(`Stale search page: ${page.path}`);stale=true;}
  } else { mkdirSync(dirname(target),{recursive:true});writeFileSync(target,body); }
}
if(stale) process.exit(1);
console.log(`Search pages: ${searchPages.length} ${process.argv.includes('--check')?'in sync':'generated'}`);
