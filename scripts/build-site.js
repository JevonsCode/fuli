import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseHTML } from 'linkedom';
import { createLanguageController } from '../site/i18n.js';
import { SITE_URL, structuredData } from '../site/metadata.js';

const variants = [['', 'zh-CN'], ['zh/', 'zh-CN'], ['en/', 'en']];
const alternates = [['zh-Hans', 'zh/'], ['en', 'en/'], ['x-default', '']];
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

export function createSitePages(template) {
  const files = new Map();
  for (const [path, locale] of variants) {
    const { document } = parseHTML(template);
    if (path) document.documentElement.dataset.pageLocale = locale;
    createLanguageController({ document, languages: [locale] });
    const pageUrl = SITE_URL + path;
    const prefix = path ? '../' : './';
    for (const element of document.querySelectorAll('[href], [src]')) {
      for (const attribute of ['href', 'src']) {
        const value = element.getAttribute(attribute);
        if (value?.startsWith('./')) element.setAttribute(attribute, prefix + value.slice(2));
      }
    }
    document.querySelector('link[rel="canonical"]').href = pageUrl;
    document.querySelector('meta[property="og:url"]').content = pageUrl;
    add(document, 'meta', { name: 'robots', content: 'index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1' });
    add(document, 'meta', { property: 'og:site_name', content: 'FULI' });
    add(document, 'meta', { property: 'og:image:alt', content: 'FULI logo' });
    add(document, 'meta', { name: 'twitter:title', 'data-i18n-content': 'meta.title', content: document.title });
    add(document, 'meta', { name: 'twitter:description', 'data-i18n-content': 'meta.description', content: document.querySelector('meta[name="description"]').content });
    add(document, 'meta', { name: 'twitter:image', content: SITE_URL + 'assets/fuli-logo.png' });
    for (const [language, route] of alternates) add(document, 'link', { rel: 'alternate', hreflang: language, href: SITE_URL + route });
    add(document, 'link', { rel: 'alternate', type: 'text/markdown', href: pageUrl + 'index.md' });
    add(document, 'link', { rel: 'describedby', type: 'text/plain', href: SITE_URL + 'llms.txt' });
    add(document, 'link', { rel: 'sitemap', type: 'application/xml', href: SITE_URL + 'sitemap.xml' });
    add(document, 'script', { id: 'site-schema', type: 'application/ld+json' }, JSON.stringify(structuredData(locale, pageUrl)).replace(/</g, '\\u003c'));
    files.set(path + 'index.html', document.toString());
    files.set(path + 'index.md', markdown(document));
  }

  const urls = variants.map(([path]) => `  <url>\n    <loc>${SITE_URL}${path}</loc>\n${alternates.map(([locale, route]) => `    <xhtml:link rel="alternate" hreflang="${locale}" href="${SITE_URL}${route}" />`).join('\n')}\n  </url>`);
  files.set('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`);
  files.set('llms.txt', `# FULI\n\n> FULI (Fuli, 复利; npm: fuli-context) is a collaboration layer for persistent AI agents across MCP-compatible clients.\n\nFULI connects task ownership, agent working memory, personal and project preferences, and direct conversations between agents. It retrieves relevant context through CLI, MCP and HTTP. Generic MCP configuration is available through fuli connect; automatic conversation capture and wake/resume require dedicated client adapters. The relationship graph and conversation records are stored on the user's computer.\n\n## Product\n\n- [Product overview in English](${SITE_URL}en/index.md): Capabilities, architecture and installation.\n- [产品介绍（中文）](${SITE_URL}zh/index.md): 功能、架构与安装。\n\n## Documentation\n\n- [English documentation](https://raw.githubusercontent.com/JevonsCode/fuli/main/README.md): Setup and usage.\n- [中文文档](https://raw.githubusercontent.com/JevonsCode/fuli/main/README.zh-CN.md): 安装与使用。\n\n## Optional\n\n- [Source repository](https://github.com/JevonsCode/fuli): Source code and issues.\n- [npm package](https://www.npmjs.com/package/fuli-context): Published installation package.\n- [Release notes](https://github.com/JevonsCode/fuli/releases): Version history.\n`);
  return files;
}

export async function buildSite() {
  const source = new URL('../site/', import.meta.url);
  const output = new URL('../dist/site/', import.meta.url);
  await cp(source, output, { recursive: true });
  const files = createSitePages(await readFile(new URL('index.html', source), 'utf8'));
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildSite();
  console.log('Built website in dist/site');
}
