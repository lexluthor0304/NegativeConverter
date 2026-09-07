# Search, answer and generative engine audit — 2026-09-07

Scope: the public Negative Converter site, its generated HTML, and the product claims accompanying positive processing, import identification and local AI repair. The same crawlable, accurate content supports SEO, AEO and GEO. This audit does not promise indexing, rankings or AI citations.

## Findings and implementation

| Priority | Observed issue | Implemented change |
| --- | --- | --- |
| High | The production home source had no H1; its welcome content was created by JavaScript. | A static product heading, description and discovery links are reused by Studio. They remain visible without JavaScript. |
| High | Search content did not explain positive correction, identification without film borders, or local AI repair. | Dedicated guides explain the actual workflows, limitations and source implementation. |
| High | English metadata accompanied Chinese initial download/privacy headings; query-based language alternates conflicted with canonical URLs. | English initial content and dedicated Chinese/Japanese overview URLs with reciprocal alternates. |
| Medium | Publisher naming varied; a schema claim incorrectly said there was no tracking. | NeoAnalogLab publisher identity, an About page, and consistent local-photo-processing versus page-analytics disclosures. |
| Medium | The sitemap included supplemental text resources and lacked new canonical pages. | A generated sitemap covers all 16 canonical HTML URLs and their language alternates. |
| Medium | Content updates could leave structured data and discovery links stale. | Shared FAQ source generates visible answers and JSON-LD; tests validate page heads, internal links, language alternates and sitemap parity. |
| Medium | Duplicate index URLs had no explicit canonical redirect policy. | Permanent index redirects and consistent locale directory slashes in both Vercel configurations. |

Production's unknown URL already returned 404. Search bots were already allowed by robots.txt; no additional training-crawler policy was introduced. The existing llms.txt is updated as a supplemental product reference, without treating it as a ranking requirement.

## Search intent and answer coverage

| Intent | Canonical destination |
| --- | --- |
| Free negative converter; product overview | `/` |
| Correct slide film; Positive versus Edit only | `/slide-film-correction.html` |
| Identify negative or positive; cropped scans; B&W ambiguity | `/film-type-detection.html` |
| Local AI dust removal; repair brush; reconstruction limits | `/ai-film-photo-repair.html` |
| Publisher, source, license and support | `/about.html` |
| Chinese/Japanese product discovery | `/zh/`, `/ja/` |
| RAW, ProRAW, batch, orange mask, sprockets, comparisons | Existing dedicated guides, linked to the new workflows |

Answers precede detailed instructions. Visible FAQs and structured answers share one source. Article authors and publisher identities are real project entities; there are no invented reviews, ratings, benchmarks or accuracy percentages. FAQ markup is not presented as eligibility for Google's restricted FAQ rich results.

## Validation and repeatable checks

- `npm run seo:generate` regenerates six pages and the sitemap.
- `npm run test:seo` checks all 16 pages and generated-file freshness; these checks also run in `npm test`.
- `npm run build:web` verifies the production bundle, including nested language-page assets.
- `node scripts/audit-search.mjs <deployment-origin>` checks every sitemap HTML URL, response status, source headings, metadata, schema presence, robots and an unknown URL. Timings are single HTTP observations, not Core Web Vitals.
- A real headless Chrome check against the production build verified nine changed/new pages at 390px: visible single H1, no horizontal overflow and parseable rendered JSON-LD. The home heading and discovery links also passed with page JavaScript disabled.

The original browser-tool profile was already occupied, so the browser check used its own temporary profile. No Lighthouse score is claimed. Redirects, headers and final canonical responses require the deployed preview/production environment, since Vite preview does not apply Vercel configuration.

## Measurement still requiring site-owner data

Search Console index coverage, submitted sitemap processing, search impressions/clicks and field Core Web Vitals were not available in this workspace. AI answer visibility also needs repeated, documented query sampling or owner referral data. Compare branded and non-branded query groups and the above landing pages after release; separate crawl/index changes from measured traffic changes. Do not infer visibility from valid markup alone.

Useful follow-up signals: indexing of `/zh/` and `/ja/`; canonical selection; impressions for slide correction and borderless negatives; entrances and conversion starts from each guide; factual accuracy of AI answers and whether they cite the actual supporting page.

## Primary guidance

- [Google: AI features and your website](https://developers.google.com/search/docs/appearance/ai-features)
- [Google: optimizing for AI experiences](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide)
- [Google: FAQ and HowTo rich-result changes](https://developers.google.com/search/blog/2023/08/howto-faq-changes)
- [OpenAI crawler roles](https://developers.openai.com/api/docs/bots)
- [Vercel project configuration](https://vercel.com/docs/project-configuration/vercel-json)

Google's guidance prioritizes accessible, useful content and existing SEO fundamentals; it does not require a special AI schema or text file. OpenAI search crawling is distinct from its training crawler. These distinctions informed this implementation.
