# Website discovery

Run `npm run build:site` and serve `dist/site` to preview the complete website. GitHub Pages publishes that same directory after the website tests pass.

The original homepage detects the browser language or uses the reader's saved choice. `/zh/` and `/en/` always serve their named language, including without JavaScript. The language links preserve the current chapter. All pages share one source template and translation dictionary.

The build adds descriptive metadata, canonical URLs, reciprocal `hreflang` links, a sitemap, and JSON-LD for the software and its pages. It also generates Markdown versions from the visible product copy and an `llms.txt` index. These do not add visible page sections. They describe existing capabilities; no fabricated reviews, ratings, or hidden keyword content are included.

The public sitemap is `https://xn--8ovp9s.xn--m8txu.com/fuli/sitemap.xml`. After deployment, it can be submitted through the site's verified Google Search Console and Bing Webmaster Tools accounts. Submission and indexing are separate from building the site.

`robots.txt` is controlled at the domain root, outside this project site's `/fuli/` directory. A `/fuli/robots.txt` file would not control crawling. Keep the domain and CDN accessible to search crawlers, including OAI-SearchBot; AI search access and model-training policies are separate controls. This build does not change the domain's policies.

References: [Google AI features](https://developers.google.com/search/docs/appearance/ai-features), [multilingual sites](https://developers.google.com/search/docs/specialty/international/managing-multi-regional-sites), [OpenAI crawlers](https://developers.openai.com/api/docs/bots), and the [llms.txt proposal](https://llmstxt.org/). None of these configurations guarantees indexing, rankings or AI citations.
