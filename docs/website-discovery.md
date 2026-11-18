# Website discovery

Run `npm run build:site` and serve `dist/site` to preview the complete website. GitHub Pages publishes that same directory after the website tests pass.

The stable pages name and download the newest GitHub release that is public, not a prerelease, no newer than the build's version and carries both installers (`FULI-Setup-<v>.exe`, `fuli-macos-arm64-<v>.dmg`). The deploy reads the release list first (`FULI_SITE_RELEASES`), so a draft, a beta or a release still uploading keeps the last complete one, and runs again when the publish workflow ends, so the site switches once both installers are attached. With the same list, `/next/` shows the newest public prerelease (beta) that carries both installers and is ahead of that stable release, whether or not this build packages it: after a stable release the last beta is still a valid preview, and a newer draft or incomplete beta is passed over. A beta this build does not package keeps its version, installers and release notes link, and points to those notes instead of the change list written for another version; with no complete beta ahead, `/next/` says there is no preview. A local build without that list names its own version.

The original homepage detects the browser language or uses the reader's saved choice. `/zh/` and `/en/` always serve their named language, including without JavaScript. The language links preserve the current chapter. All pages share one source template and translation dictionary.

The build adds descriptive metadata, canonical URLs, reciprocal `hreflang` links, a sitemap, and JSON-LD for the software and its pages. It also generates Markdown versions from the visible product copy and an `llms.txt` index. These do not add visible page sections. They describe existing capabilities; no fabricated reviews, ratings, or hidden keyword content are included.

The public sitemap is `https://xn--8ovp9s.xn--m8txu.com/fuli/sitemap.xml`. After deployment, it can be submitted through the site's verified Google Search Console and Bing Webmaster Tools accounts. Submission and indexing are separate from building the site.

`robots.txt` is controlled at the domain root, outside this project site's `/fuli/` directory. A `/fuli/robots.txt` file would not control crawling. Keep the domain and CDN accessible to search crawlers, including OAI-SearchBot; AI search access and model-training policies are separate controls. This build does not change the domain's policies.

References: [Google AI features](https://developers.google.com/search/docs/appearance/ai-features), [multilingual sites](https://developers.google.com/search/docs/specialty/international/managing-multi-regional-sites), [OpenAI crawlers](https://developers.openai.com/api/docs/bots), and the [llms.txt proposal](https://llmstxt.org/). None of these configurations guarantees indexing, rankings or AI citations.
