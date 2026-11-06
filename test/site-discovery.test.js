import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { createSitePages } from '../scripts/build-site.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const template = read('../site/index.html');
const pages = () => createSitePages({ home: template, preview: read('../site/next/index.html'), models: read('../site/models/index.html'), tech: read('../site/tech/index.html'), guide: read('../site/guide/index.html'), report: read('../site/report/index.html'), version: '0.0.0-beta.0' });
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
  for (const path of ['', 'zh/', 'en/', 'next/', 'next/zh/', 'next/en/', 'models/', 'models/zh/', 'models/en/', 'tech/', 'tech/zh/', 'tech/en/', 'guide/', 'guide/zh/', 'guide/en/', 'report/', 'report/zh/', 'report/en/']) assert.ok(sitemap.includes(`<loc>${base}${path}</loc>`));
  assert.doesNotMatch(sitemap, /127\.0\.0\.1|localhost|v0/);
  assert.match(files.get('llms.txt'), /AI agent/);
  assert.ok(files.get('llms.txt').includes(base + 'en/index.md'));
  const markdown = files.get('en/index.md');
  assert.match(markdown, /MCP/);
  assert.match(markdown, /npm install --global fuli-context/);
  assert.match(markdown, /Neo4j/);
  assert.doesNotMatch(markdown, /<script|<style/);
});

// A guide page (/models/, /tech/, /guide/) in each language: complete without JavaScript, with its
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

test('the quick start walks through install, connect, use, an optional model and help, with exact console labels', () => {
  assertGuidePages('guide', (document, locale) => {
    assert.deepEqual([...document.querySelectorAll('main > section[id]')].map(node => node.id), ['install', 'connect', 'use', 'model', 'help']);
    assert.deepEqual([...document.querySelectorAll('.step-index')].map(node => node.textContent), ['1', '2', '3', '4', '5']);
    assert.equal(document.querySelector('.guide-hero .button').href, 'https://github.com/JevonsCode/fuli/releases/latest');
    assert.match(document.querySelector('#install').textContent, /FULI-Setup-<.+>.exe/);
    assert.match(document.querySelector('#install').textContent, /fuli-macos-arm64-<.+>.dmg/);
    assert.ok(document.querySelector('#model').textContent.includes('qwen3-embedding:0.6b'));
    const models = document.querySelector('#model [data-i18n="guide.model.guide"]').href;
    assert.equal(models, base + 'models/' + (locale === 'en' ? 'en/' : ''));
  });
});

test('the report shows each measured number with its method folded beside it, and keeps a spot for Tonborg', () => {
  assertGuidePages('report', (document, locale) => {
    assert.deepEqual([...document.querySelectorAll('main > section[id]')].map(node => node.id), ['tokens', 'recall', 'outcome', 'tonborg', 'history', 'gaps', 'related']);
    assert.deepEqual([...document.querySelectorAll('#tokens .stat b')].map(node => node.textContent), ['1.53×', '1.42×', '24.3 KB']);
    assert.match(document.querySelector('#recall').textContent, /25\/32/);
    assert.match(document.querySelector('#outcome').textContent, /18\/18/);
    // Every measured section names its method in a fold; the key numbers stay outside it.
    for (const id of ['tokens', 'recall', 'outcome']) {
      const method = document.querySelector(`#${id} details.fold`).textContent;
      assert.match(method, /20\d\d-\d\d-\d\d/, id);
      assert.equal(document.querySelector(`#${id} details .table-wrap`), null, id);
    }
    assert.ok(document.querySelector('#tonborg #tonborg-strong.is-pending'));
    assert.ok(document.querySelector('#tonborg').textContent.includes('60.4%'));
    assert.ok(document.querySelectorAll('#gaps li').length >= 4);
    const models = document.querySelector('#related [data-i18n="report.related.models"]').href;
    assert.equal(models, base + 'models/' + (locale === 'en' ? 'en/' : ''));
  });
});

test('the home story walks through the product in order, with measured numbers and what is still coming', () => {
  const files = pages();
  for (const path of ['index.html', 'en/index.html', 'next/index.html', 'next/en/index.html']) {
    const { document } = parseHTML(files.get(path));
    assert.deepEqual([...document.querySelectorAll('.chapter')].map(node => node.dataset.scene),
      ['scatter', 'memory', 'knowledge', 'projects', 'owner', 'growth', 'workbench', 'team', 'roundtable', 'database'], path);
    // 沉淀 and 项目 say what a model changes; 沉淀 shows real console screens in both languages.
    for (const id of ['knowledge', 'projects']) {
      assert.ok(document.querySelector(`#${id} .model-modes .is-base`) && document.querySelector(`#${id} .model-modes .is-model`), path + id);
    }
    assert.ok(document.querySelector('#knowledge .screen-figure .screen-zh') && document.querySelector('#knowledge .screen-figure .screen-en'), path);
    assert.ok(document.querySelector('[data-overlay="knowledge"][data-copy="#knowledge .screen-figure"]'), path);
    // 项目 grows a graph: projects around 我, each with its knowledge; three start temporary and two of
    // them become projects with a lead; late items (hidden on phone) make it dense. Played along the chapter.
    const graph = document.querySelector('#projects .project-graph');
    assert.equal(graph.querySelectorAll('.pg-me').length, 1, path);
    const projects = [...graph.querySelectorAll('.pg-project')];
    assert.equal(projects.length, 5, path);
    assert.equal(projects.filter(node => node.classList.contains('is-temp')).length, 3, path);
    assert.equal(projects.filter(node => /--grad:/.test(node.getAttribute('style'))).length, 2, path);
    assert.equal(projects.filter(node => node.querySelector('.pg-lead[src*="assets/avatars/fla-"]')).length, 4, path);
    for (const node of projects) assert.ok(node.querySelector('em').textContent.trim(), path);
    const items = graph.querySelectorAll('.pg-node').length;
    assert.ok(items >= 30 && graph.querySelectorAll('.pg-node:not(.is-extra)').length <= 30, `${path}: ${items} items`);
    assert.ok(graph.querySelectorAll('.pg-link').length >= items, path);
    assert.ok(document.querySelector('[data-overlay="projects"][data-copy="#projects .project-graph"]')?.hasAttribute('data-progress'), path);
    // 沉淀 surfaces preferences in the person's own words: two each of taste, personality and judgment,
    // a few landing big, all behind the window; without the story they are a plain list.
    const quotes = [...document.querySelectorAll('#knowledge .pref-quotes .pq')];
    assert.deepEqual(quotes.map(node => node.querySelector('small').getAttribute('data-i18n').split('.').pop()).sort(), ['judgment', 'judgment', 'personality', 'personality', 'taste', 'taste'], path);
    assert.equal(quotes.filter(node => node.classList.contains('is-impact')).length, 3, path);
    for (const node of quotes) assert.ok(node.querySelector('span').textContent.trim(), path);
    const quotesOverlay = document.querySelector('[data-overlay="knowledge"][data-copy="#knowledge .pref-quotes"]');
    assert.ok(quotesOverlay?.hasAttribute('data-progress'), path);
    assert.equal(quotesOverlay.nextElementSibling.dataset.copy, '#knowledge .screen-figure', path);
    // The model's lines read the same everywhere: the 接了模型 pill.
    assert.ok(document.querySelectorAll('.model-modes .is-model .model-tag').length >= 4, path);
    for (const link of document.querySelectorAll('.nav nav > a[href^="#"]')) assert.ok(document.querySelector(link.getAttribute('href')), path + link.getAttribute('href'));
    // Tokens and accuracy: the report's numbers, and the link says plainly that FULI still adds input.
    assert.deepEqual([...document.querySelectorAll('#memory .chapter-stats b')].map(node => node.textContent), ['24.3 KB', '4/6', '18/18'], path);
    assert.match(document.querySelector('#memory .chapter-link').textContent, /1.53/, path);
    // Growth is drawn: lessons out of the work, the kept ones ticked, checks marked as coming, then the app and its surfaces.
    // The chapter says only that FLAs grow; the drawing says how.
    assert.deepEqual([...document.querySelectorAll('#growth .chapter-copy > :not(.eyebrow)')].map(node => node.tagName), ['H2'], path);
    assert.match(document.querySelector('#growth h2').textContent, /^(FLA 会自己成长。|FLAs grow on their own.)$/, path);
    const growth = document.querySelector('#growth .growth-anim');
    assert.equal(growth.querySelectorAll('.ga-lesson').length, 5, path);
    assert.equal(growth.querySelectorAll('.ga-lesson.is-kept .ga-tick').length, 3, path);
    assert.ok(growth.querySelector('.ga-checks [data-i18n="growth.soon"]'), path);
    for (const part of ['.ga-avatar', '.ga-app', '.ga-workbench', '.ga-workflow']) assert.ok(growth.querySelector(part), path + part);
    assert.ok(document.querySelector('[data-overlay="growth"]'), path);
    // Real FLA portraits, not a letter: the card's FLA cycles through four, and the chapter ends in a crowd of groups,
    // some talking (one line each, translated), some producing work.
    assert.equal(growth.querySelector('.ga-avatar').textContent.trim(), '', path);
    assert.equal(growth.querySelectorAll('.ga-avatar img[src*="assets/avatars/fla-"]').length, 4, path);
    const crowd = document.querySelector('#growth .ga-crowd');
    assert.equal(crowd.getAttribute('aria-hidden'), 'true', path);
    assert.equal(crowd.querySelectorAll('.ga-group').length, 8, path);
    assert.deepEqual([...crowd.querySelectorAll('.ga-group.is-talking .ga-bubble')].map(node => node.getAttribute('data-i18n')), [1, 2, 3, 4].map(n => `growth.crowd.line${n}`), path);
    assert.equal(crowd.querySelectorAll('.ga-group.is-working .ga-output').length, 4, path);
    // A phone shows the first five, each with its own place below the title.
    for (const group of [...crowd.querySelectorAll('.ga-group')].slice(0, 5)) assert.match(group.getAttribute('style'), /--px: \d+%; --py: \d+%/, path);
    assert.ok(document.querySelector('[data-overlay="growth"][data-copy="#growth .ga-crowd"]'), path);
    assert.deepEqual([...document.querySelectorAll('#workbench .growth-cards b')].map(node => node.textContent), ['Workbench', 'Workflow', 'Agent App'], path);
    // Upcoming work sits only under the 即将 / Coming badge, never among the shipped cards.
    assert.equal(document.querySelectorAll('#workbench .growth-next li').length, 2, path);
    assert.ok(document.querySelector('#workbench .growth-next .growth-badge'), path);
    assert.deepEqual([...document.querySelectorAll('#team .member b')].slice(0, 4).map(node => node.textContent), ['Astro', 'Jefa', 'Bole', 'Tonborg'], path);
  }
  // On the stable page the client downloads lead the hero; npm is one link to the server install.
  const { document } = parseHTML(files.get('index.html'));
  assert.deepEqual([...document.querySelectorAll('.hero-actions [data-download-windows], .hero-actions [data-download-macos]')].length, 2);
  assert.equal(document.querySelector('.hero-actions .hero-server').getAttribute('href'), '#start');
  assert.equal(document.querySelector('.terminal'), null);
});

test('the install chapter leads with the client: four steps beside real screens, npm folded for servers', () => {
  const files = pages();
  for (const [path, lang] of [['index.html', 'zh'], ['en/index.html', 'en']]) {
    const { document } = parseHTML(files.get(path));
    // 不会配？: a 「?」 card's prompt goes to the person's own AI client, which sets the model up.
    // What has shipped is said plainly; the 「?」 prompt and WebMCP sit under the 即将 / Coming badge.
    const aiSetup = document.querySelector('#start .ai-setup');
    assert.equal(aiSetup.querySelector('.ai-help-prompt q').textContent, aiSetup.querySelector('.ai-setup-chat .msg.user').textContent, path);
    assert.ok(aiSetup.querySelector('.ai-help-head [data-i18n="aiSetup.soon"]'), path);
    assert.match(aiSetup.querySelector('.ai-setup-soon').textContent, /WebMCP/, path);
    assert.equal([...aiSetup.querySelectorAll('p, b, q')].filter(node => /WebMCP/.test(node.textContent) && !node.closest('.ai-setup-soon')).length, 0, path);
    assert.match(aiSetup.querySelector('.ai-setup-control').textContent, lang === 'zh' ? /AI 权限.*密钥/ : /AI permissions.*keys/, path);
    const story = document.querySelector('#start .install-story');
    assert.equal(story.querySelectorAll('.install-steps > li').length, 4, path);
    // The download drawn first, then six console screens, each in both languages.
    const frames = [...story.querySelectorAll('.app-frame')];
    assert.equal(frames.length, 7, path);
    assert.ok(frames[0].classList.contains('install-download'), path);
    for (const frame of frames.slice(1)) assert.ok(frame.querySelector('.screen-zh') && frame.querySelector('.screen-en'), path);
    assert.equal(story.querySelectorAll('.install-static').length, 1, path);
    assert.ok(story.querySelector('[data-download-windows]') && story.querySelector('[data-download-macos]'), path);
    // The terminal install is the folded path for servers and VMs.
    const server = document.querySelector('#start details.install-server');
    assert.match(server.textContent, /npm install --global fuli-context/, path);
    assert.ok(document.querySelector(`#start .screen-${lang}`), path);
  }
});

test('the home and preview pages link the guide pages in their own language', () => {
  const files = pages();
  for (const [path, suffix] of [['index.html', ''], ['en/index.html', 'en/'], ['next/index.html', ''], ['next/en/index.html', 'en/']]) {
    const { document } = parseHTML(files.get(path));
    assert.equal(document.querySelector('.footer [data-i18n="footer.models"]').href, base + 'models/' + suffix, path);
    assert.equal(document.querySelector('.footer [data-i18n="footer.tech"]').href, base + 'tech/' + suffix, path);
    assert.equal(document.querySelector('.footer [data-i18n="footer.guide"]').href, base + 'guide/' + suffix, path);
    assert.equal(document.querySelector('.footer [data-i18n="footer.report"]').href, base + 'report/' + suffix, path);
    assert.equal(document.querySelector('#memory .chapter-link').href, base + 'report/' + suffix, path);
  }
});
