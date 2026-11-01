import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { createLanguageController } from '../site/i18n.js';
import * as previewCatalog from '../site/next/translations.js';
import { SITE_URL, structuredData } from '../site/metadata.js';
import { isMainModule } from '../src/system/main-module.js';

// Each page is published at its template's own route (Chinese by default) and
// one directory below it per language; every language lists the same alternates.
const languageRoutes = [['', 'zh-CN'], ['zh/', 'zh-CN'], ['en/', 'en']];
const alternateRoutes = [['zh-Hans', 'zh/'], ['en', 'en/'], ['x-default', '']];
const PREVIEW_BASE = 'next/';
const plain = node => node.textContent.replace(/\s+/g, ' ').trim();

function add(document, tag, attributes, text) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  if (text) element.textContent = text;
  document.head.append('\n    ', element);
  return element;
}

function markdown(document) {
  const lines = ['# ' + document.title, '', '> ' + document.querySelector('meta[name="description"]').content, ''];
  for (const chapter of document.querySelectorAll('.chapter:not(.hero-chapter)')) {
    const heading = chapter.querySelector('h2').cloneNode(true);
    for (const br of heading.querySelectorAll('br')) br.replaceWith(' ');
    lines.push('## ' + plain(heading), '', plain(chapter.querySelector('.chapter-copy > p:last-child')), '');
  }
  lines.push('## ' + plain(document.querySelector('#start-title')), '', plain(document.querySelector('.start > p:first-of-type')), '', '```sh');
  for (const code of document.querySelectorAll('.start li code')) lines.push(plain(code));
  lines.push('```', '');
  for (const link of document.querySelectorAll('.start-links a')) lines.push(`- [${plain(link)}](${link.href})`);
  lines.push('', 'Apache-2.0', '');
  return lines.join('\n');
}

// Renders one language route of a page template; `base` is the template's own route.
function renderPage(template, base, route, locale, catalog) {
  const { document } = parseHTML(template);
  if (route) document.documentElement.dataset.pageLocale = locale;
  createLanguageController({ document, languages: [locale], catalog });
  const pageUrl = SITE_URL + base + route;
  // A language route sits one directory below its template, so relative URLs gain one "../".
  if (route) {
    for (const element of document.querySelectorAll('[href], [src]')) {
      for (const attribute of ['href', 'src']) {
        const value = element.getAttribute(attribute);
        if (value?.startsWith('./')) element.setAttribute(attribute, '../' + value.slice(2));
        else if (value?.startsWith('../')) element.setAttribute(attribute, '../' + value);
      }
    }
  }
  document.querySelector('link[rel="canonical"]').href = pageUrl;
  document.querySelector('meta[property="og:url"]').content = pageUrl;
  add(document, 'meta', { name: 'robots', content: 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1' });
  add(document, 'meta', { property: 'og:site_name', content: 'FULI' });
  add(document, 'meta', { property: 'og:image:alt', content: 'FULI logo' });
  const title = document.querySelector('title').getAttribute('data-i18n');
  const description = document.querySelector('meta[name="description"]');
  add(document, 'meta', { name: 'twitter:title', 'data-i18n-content': title, content: document.title });
  add(document, 'meta', { name: 'twitter:description', 'data-i18n-content': description.getAttribute('data-i18n-content'), content: description.content });
  add(document, 'meta', { name: 'twitter:image', content: SITE_URL + 'assets/brand/fuli-mark-color-512.png' });
  for (const [language, alternate] of alternateRoutes) add(document, 'link', { rel: 'alternate', hreflang: language, href: SITE_URL + base + alternate });
  return { document, pageUrl };
}

function homePages(template, files) {
  for (const [route, locale] of languageRoutes) {
    const { document, pageUrl } = renderPage(template, '', route, locale);
    add(document, 'link', { rel: 'alternate', type: 'text/markdown', href: pageUrl + 'index.md' });
    add(document, 'link', { rel: 'describedby', type: 'text/plain', href: SITE_URL + 'llms.txt' });
    add(document, 'link', { rel: 'sitemap', type: 'application/xml', href: SITE_URL + 'sitemap.xml' });
    add(document, 'script', { id: 'site-schema', type: 'application/ld+json' }, JSON.stringify(structuredData(locale, pageUrl)).replace(/</g, '\\u003c'));
    files.set(route + 'index.html', document.toString());
    files.set(route + 'index.md', markdown(document));
  }
}

// The preview channel names the version this build packages (package.json is its only source).
function previewPages(template, version, files) {
  for (const [route, locale] of languageRoutes) {
    const { document } = renderPage(template, PREVIEW_BASE, route, locale, previewCatalog);
    add(document, 'link', { rel: 'sitemap', type: 'application/xml', href: SITE_URL + 'sitemap.xml' });
    for (const element of document.querySelectorAll('[data-preview-version]')) element.textContent = version;
    for (const link of document.querySelectorAll('[data-preview-release]')) link.href = `https://github.com/JevonsCode/fuli/releases/tag/v${version}`;
    files.set(PREVIEW_BASE + route + 'index.html', document.toString());
  }
}

// With no preview ahead of the stable release, /next/ says so and links home in its language.
const noPreviewCopy = {
  'zh-CN': { title: 'FULI 复利 · 暂无预览版', heading: '现在没有比稳定版更新的预览版', body: version => `稳定版 ${version} 就是最新版本。下一个预览版发布后，会在这里介绍。`, home: '回到首页' },
  en: { title: 'FULI · No preview right now', heading: 'No preview is newer than the stable release', body: version => `Stable ${version} is the latest release. The next preview will be introduced here when it is published.`, home: 'Back to the home page' },
};

function noPreviewPages(version, files) {
  for (const [route, locale] of languageRoutes) {
    const copy = noPreviewCopy[locale];
    const home = SITE_URL + route;
    const assets = route ? '../../' : '../';
    files.set(PREVIEW_BASE + route + 'index.html', `<!DOCTYPE html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${copy.title}</title>
    <meta name="robots" content="noindex, follow">
    <link rel="canonical" href="${home}">
    <link rel="icon" href="${assets}assets/brand/favicon.ico" sizes="any">
    <link rel="stylesheet" href="${assets}style.css">
  </head>
  <body>
    <main class="start no-preview" id="main">
      <h1>${copy.heading}</h1>
      <p>${copy.body(version)}</p>
      <p class="start-links"><a class="button" href="${home}">${copy.home}</a></p>
    </main>
  </body>
</html>
`);
  }
}

export function createSitePages({ home, preview, version }) {
  const files = new Map();
  // A prerelease version (0.23.0-beta.1) is a preview; a stable one has none ahead of it.
  const hasPreview = version.includes('-');
  homePages(home, files);
  if (hasPreview) previewPages(preview, version, files);
  else noPreviewPages(version, files);

  const urls = (hasPreview ? ['', PREVIEW_BASE] : ['']).flatMap(base => languageRoutes.map(([route]) => `  <url>\n    <loc>${SITE_URL}${base}${route}</loc>\n${alternateRoutes.map(([locale, alternate]) => `    <xhtml:link rel="alternate" hreflang="${locale}" href="${SITE_URL}${base}${alternate}" />`).join('\n')}\n  </url>`));
  files.set('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`);
  files.set('llms.txt', `# FULI\n\n> FULI (Fuli, 复利; npm: fuli-context) is a collaboration layer for persistent AI agents across MCP-compatible clients.\n\nFULI connects task ownership, agent working memory, personal and project preferences, and direct conversations between agents. Every space includes Jefa for project management, Bole for Agent resources (recruiting and staffing), and Tonborg for preference-guided judgment. Tonborg reviews within the chosen autonomy level and recommends clients and models; the host performs the actual execution. Decision logs accept thumbs up, thumbs down and an optional reason to guide later judgments. FULI retrieves relevant context through CLI, MCP and HTTP. Generic MCP configuration is available through fuli connect; automatic conversation capture and wake/resume require dedicated client adapters. The relationship graph and conversation records are stored on the user's computer.\n\n## Product\n\n- [Product overview in English](${SITE_URL}en/index.md): Capabilities, architecture and installation.\n- [产品介绍（中文）](${SITE_URL}zh/index.md): 功能、架构与安装。\n\n## Documentation\n\n- [English documentation](https://raw.githubusercontent.com/JevonsCode/fuli/main/README.md): Setup and usage.\n- [中文文档](https://raw.githubusercontent.com/JevonsCode/fuli/main/README.zh-CN.md): 安装与使用。\n\n## Optional\n\n- [Source repository](https://github.com/JevonsCode/fuli): Source code and issues.\n- [npm package](https://www.npmjs.com/package/fuli-context): Published installation package.\n- [Release notes](https://github.com/JevonsCode/fuli/releases): Version history.\n`);
  return files;
}

export async function buildSite() {
  const source = new URL('../site/', import.meta.url);
  const output = new URL('../dist/site/', import.meta.url);
  await cp(source, output, { recursive: true });
  const files = createSitePages({
    home: await readFile(new URL('index.html', source), 'utf8'),
    preview: await readFile(new URL(PREVIEW_BASE + 'index.html', source), 'utf8'),
    version: JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version,
  });
  for (const [path, content] of files) {
    const destination = new URL(path, output);
    await mkdir(new URL('./', destination), { recursive: true });
    await writeFile(destination, content);
  }
  // The archived design remains accessible, while search focuses on the current pages.
  const archivePath = new URL('v0/index.html', output);
  const archive = await readFile(archivePath, 'utf8');
  await writeFile(archivePath, archive.replace('</head>', '<meta name="robots" content="noindex, follow" />\n</head>'));
  return fileURLToPath(output);
}

if (isMainModule(import.meta.url)) {
  await buildSite();
  console.log('Built website in dist/site');
}
