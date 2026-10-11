import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { createSitePages } from '../scripts/build-site.js';

const template = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const base = 'https://xn--8ovp9s.xn--m8txu.com/fuli/';

test('each language is complete without JavaScript and has reciprocal discovery links', () => {
  const files = createSitePages(template);
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
  const files = createSitePages(template);
  assert.deepEqual(files, createSitePages(template), 'Generation is deterministic');
  const sitemap = files.get('sitemap.xml');
  for (const path of ['', 'zh/', 'en/']) assert.ok(sitemap.includes(`<loc>${base}${path}</loc>`));
  assert.doesNotMatch(sitemap, /127\.0\.0\.1|localhost|v0/);
  assert.match(files.get('llms.txt'), /AI agent/);
  assert.ok(files.get('llms.txt').includes(base + 'en/index.md'));
  const markdown = files.get('en/index.md');
  assert.match(markdown, /MCP/);
  assert.match(markdown, /npm install --global fuli-context/);
  assert.match(markdown, /Neo4j/);
  assert.doesNotMatch(markdown, /<script|<style/);
});
