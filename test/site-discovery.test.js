import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { createSitePages } from '../scripts/build-site.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const template = read('../site/index.html');
const pages = () => createSitePages({ home: template, preview: read('../site/next/index.html'), models: read('../site/models/index.html'), tech: read('../site/tech/index.html'), version: '0.0.0-beta.0' });
const base = 'https://xn--8ovp9s.xn--m8txu.com/fuli/';

test('each language is complete without JavaScript and has reciprocal discovery links', () => {
  const files = pages();
  for (const [path, locale] of [['', 'zh-CN'], ['zh/', 'zh-CN'], ['en/', 'en']]) {
    const { document } = parseHTML(files.get(path + 'index.html'));
    assert.equal(document.documentElement.lang, locale);
    assert.ok(document.title.includes('AI Agent'), 'A descriptive title is present in the initial HTML');
    assert.match(document.querySelector('#database .chapter-copy > p:last-child').textContent, /Neo4j/);
    assert.equal(document.querySelector('link[rel="canonical"]').href, base + path);
    assert.equal(document.querySelector('meta[property="og:url"]').content, base + path);
    assert.equal(document.querySelector('meta[name="robots"]').content.includes('noindex'), false);
    const alternates = [...document.querySelectorAll('link[hreflang]')].map(node => [node.hreflang, node.href]);
    assert.deepEqual(alternates, [['zh-Hans', base + 'zh/'], ['en', base + 'en/'], ['x-default', base]]);
    for (const link of document.querySelectorAll('.language-switch a')) assert.match(link.href, /(?:zh|en)\/$/);
    assert.equal(document.querySelector('link[rel="alternate"][type="text/markdown"]').href, base + path + 'index.md');
    assert.equal(document.querySelector('link[rel="describedby"]').href, base + 'llms.txt');
    if (path) {
      assert.equal(document.documentElement.dataset.pageLocale, locale);
      assert.equal(document.querySelector('script[type="module"]').src, '../site.js');
    }
    if (locale === 'en') {
      document.querySelector('.brand').remove();
      document.querySelector('.language-switch').remove();
      assert.doesNotMatch(document.body.textContent, /[\u3400-\u9fff]/);
      assert.match(document.querySelector('h1').textContent, /collaboration/);
    }
    const schema = JSON.parse(document.querySelector('#site-schema').textContent);
    const app = schema['@graph'].find(item => item['@type'] === 'SoftwareApplication');
    const page = schema['@graph'].find(item => item['@type'] === 'WebPage');
    assert.equal(app.url, base);
    assert.equal(page.url, base + path);
    assert.equal(page.inLanguage, locale);
    assert.ok(app.featureList.length >= 4);
    assert.equal(app.aggregateRating, undefined);
    assert.equal(app.review, undefined);
  }
});

test('sitemap and machine-readable summaries describe the same public product', () => {
  const files = pages();
  assert.deepEqual(files, pages(), 'Generation is deterministic');
  const sitemap = files.get('sitemap.xml');
  for (const path of ['', 'zh/', 'en/', 'next/', 'next/zh/', 'next/en/', 'models/', 'models/zh/', 'models/en/', 'tech/', 'tech/zh/', 'tech/en/']) assert.ok(sitemap.includes(`<loc>${base}${path}</loc>`));
  assert.doesNotMatch(sitemap, /127\.0\.0\.1|localhost|v0/);
  assert.match(files.get('llms.txt'), /AI agent/);
  assert.ok(files.get('llms.txt').includes(base + 'en/index.md'));
  const markdown = files.get('en/index.md');
  assert.match(markdown, /MCP/);
  assert.match(markdown, /npm install --global fuli-context/);
  assert.match(markdown, /Neo4j/);
  assert.doesNotMatch(markdown, /<script|<style/);
});

// A guide page (/models/, /tech/) in each language: complete without JavaScript, with its
// own canonical and alternates, one H1, one H2 per section, no repeated titles and no
// Chinese on the English page. `check` adds the page's own assertions.
function assertGuidePages(name, check) {
  const files = pages();
  for (const [route, locale, prefix] of [['', 'zh-CN', '../'], ['zh/', 'zh-CN', '../../'], ['en/', 'en', '../../']]) {
    const { document } = parseHTML(files.get(name + '/' + route + 'index.html'));
    const url = base + name + '/';
    assert.equal(document.documentElement.lang, locale);
    assert.equal(document.querySelector('link[rel="canonical"]').href, url + route);
    assert.equal(document.querySelector('meta[property="og:url"]').content, url + route);
    assert.equal(document.querySelector('meta[name="robots"]').content.includes('noindex'), false);
    const alternates = [...document.querySelectorAll('link[hreflang]')].map(node => [node.hreflang, node.href]);
    assert.deepEqual(alternates, [['zh-Hans', url + 'zh/'], ['en', url + 'en/'], ['x-default', url]]);
    assert.deepEqual([...document.querySelectorAll('link[rel="stylesheet"]')].map(node => node.href), [prefix + 'style.css', prefix + 'guide-page.css', (route ? '../' : './') + name + '.css']);
    assert.equal(document.querySelector('script[type="module"]').src, prefix + name + '.js');
    if (route) assert.equal(document.documentElement.dataset.pageLocale, locale);
    assert.equal(document.querySelectorAll('h1').length, 1);
    const headings = [...document.querySelectorAll('h2, h3')].map(node => node.textContent.trim());
    for (const section of document.querySelectorAll('main > section')) assert.equal(section.querySelectorAll('h1, h2').length, 1);
    assert.equal(new Set(headings).size, headings.length, 'no repeated titles');
    for (const element of document.querySelectorAll('[data-i18n]')) assert.notEqual(element.textContent.trim(), '', element.getAttribute('data-i18n'));
    check(document, locale);
    if (locale === 'en') {
      for (const element of document.querySelectorAll('.brand, .language-switch')) element.remove();
      assert.doesNotMatch(document.body.textContent, /[㐀-鿿]/);
      for (const element of document.querySelectorAll('[aria-label], meta[content]')) {
        assert.doesNotMatch(element.getAttribute('aria-label') ?? element.getAttribute('content'), /[㐀-鿿]/);
      }
    }
  }
}

test('the model guide is complete without JavaScript in each language, with its own canonical and alternates', () => {
  assertGuidePages('models', document => {
    assert.equal(document.querySelectorAll('.use-card').length, 6);
    assert.equal(document.querySelectorAll('.use-card .bolt').length, 6);
    assert.ok(document.querySelector('#semantic-search').textContent.includes('qwen3-embedding:0.6b'));
    assert.ok(document.querySelector('#dreaming').textContent.includes('143,292'));
    assert.ok(document.querySelector('#tonborg').textContent.includes('60.4%'));
  });
});

test('the technology page covers the architecture, every shipped Skill, the data design and the principles', () => {
  const shipped = readdirSync(new URL('../skills/', import.meta.url), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assertGuidePages('tech', (document, locale) => {
    assert.deepEqual([...document.querySelectorAll('main > section[id]')].map(node => node.id), ['architecture', 'skills', 'data', 'principles', 'related']);
    assert.equal(document.querySelectorAll('#architecture .layer-grid > li').length, 4);
    assert.deepEqual([...document.querySelectorAll('#skills h3 code')].map(node => node.textContent).sort(), shipped);
    assert.match(document.querySelector('#data').textContent, /RELATES_TO/);
    const models = document.querySelector('#related [data-i18n="tech.related.models"]').href;
    assert.equal(models, base + 'models/' + (locale === 'en' ? 'en/' : ''));
  });
});

test('the home and preview pages link the guide pages in their own language', () => {
  const files = pages();
  for (const [path, suffix] of [['index.html', ''], ['en/index.html', 'en/'], ['next/index.html', ''], ['next/en/index.html', 'en/']]) {
    const { document } = parseHTML(files.get(path));
    assert.equal(document.querySelector('.footer [data-i18n="footer.models"]').href, base + 'models/' + suffix, path);
    assert.equal(document.querySelector('.footer [data-i18n="footer.tech"]').href, base + 'tech/' + suffix, path);
  }
});
