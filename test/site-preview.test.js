import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { createSitePages } from '../scripts/build-site.js';
import { sceneMessages as homeScenes } from '../site/translations.js';
import { messages, sceneMessages } from '../site/next/translations.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
// The preview page is built only while the package version is a prerelease, so these
// tests build a synthetic one; the stable package version gets the no-preview page.
const version = '0.23.0-beta.1';
const pages = siteVersion => createSitePages({ home: read('../site/index.html'), preview: read('../site/next/index.html'), version: siteVersion });
const files = pages(version);
const base = 'https://xn--8ovp9s.xn--m8txu.com/fuli/';
const home = parseHTML(read('../site/index.html')).document;
const installers = [
  'curl -fsSL https://xn--8ovp9s.xn--m8txu.com/fuli/install.sh | FULI_NPM_PACKAGE_SPEC=fuli-context@beta sh',
  "$env:FULI_NPM_PACKAGE_SPEC='fuli-context@beta'; irm https://xn--8ovp9s.xn--m8txu.com/fuli/install.ps1 | iex",
  'npm install --global fuli-context@beta && fuli setup',
];

test('the preview page is built at /next/ in Chinese by default and in English, with its prerelease version', () => {
  for (const [route, locale, prefix] of [['', 'zh-CN', '../'], ['zh/', 'zh-CN', '../../'], ['en/', 'en', '../../']]) {
    const { document } = parseHTML(files.get(`next/${route}index.html`));
    assert.equal(document.documentElement.lang, locale);
    assert.equal(document.title, messages[locale]['meta.title']);
    assert.equal(document.querySelector('[data-preview-version]').textContent, version);
    assert.equal(document.querySelector('[data-preview-release]').href, `https://github.com/JevonsCode/fuli/releases/tag/v${version}`);
    assert.equal(document.querySelector('link[rel="canonical"]').href, `${base}next/${route}`);
    const alternates = [...document.querySelectorAll('link[hreflang]')].map(node => [node.hreflang, node.href]);
    assert.deepEqual(alternates, [['zh-Hans', base + 'next/zh/'], ['en', base + 'next/en/'], ['x-default', base + 'next/']]);
    assert.deepEqual([...document.querySelectorAll('link[rel="stylesheet"]')].map(node => node.href), [prefix + 'style.css', prefix + 'scene.css']);
    assert.equal(document.querySelector('script[type="module"]').src, prefix + 'next.js');
    assert.equal(document.querySelector('.terminal').dataset.copy, 'npm install --global fuli-context@beta && fuli setup');
    assert.equal(document.querySelector('[data-i18n="next.stable"]').href, messages[locale]['next.stableUrl']);
    assert.ok(document.querySelectorAll('.preview-changes h3').length >= 3, 'a few headed sections summarize the release');
    assert.deepEqual([...document.querySelectorAll('.oneliner code')].map(node => node.textContent.slice(0, -node.querySelector('span').textContent.length)), installers);
    if (locale === 'en') {
      for (const element of document.querySelectorAll('.brand, .language-switch')) element.remove();
      assert.doesNotMatch(document.body.textContent, /[\u3400-\u9fff]/);
    }
  }
});

// The preview is the whole home site with this release's copy (Jevons 10-27), so it
// can replace the home page when the release goes stable.
test('the preview page has every part of the home page and its scroll story', () => {
  const { document } = parseHTML(files.get('next/index.html'));
  const ids = page => [...page.querySelectorAll('.chapter, [data-overlay], .chapter-nav a, .principles:not(.preview-changes) > div, #fragment-rig')].map(node => node.dataset.scene ?? node.dataset.overlay ?? node.getAttribute('href') ?? node.id ?? '');
  assert.deepEqual(ids(document), ids(home));
  for (const link of document.querySelectorAll('.nav nav > a[href^="#"], .chapter-nav a')) assert.ok(document.querySelector(link.getAttribute('href')), link.getAttribute('href'));
  assert.equal(document.querySelector('.brand').getAttribute('href'), '#top');
  assert.ok(document.querySelector('#motion-toggle'));
});

test('the preview copy covers both languages and every scene', () => {
  assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(messages['zh-CN']).sort());
  const { document } = parseHTML(read('../site/next/index.html'));
  for (const element of document.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      if (!attribute.name.startsWith('data-i18n')) continue;
      for (const locale of ['en', 'zh-CN']) assert.ok(messages[locale][attribute.value], `Missing ${locale}: ${attribute.value}`);
    }
  }
  for (const locale of ['en', 'zh-CN']) {
    assert.deepEqual(Object.keys(sceneMessages[locale]).sort(), Object.keys(homeScenes[locale]).sort());
    for (const labels of Object.values(sceneMessages[locale])) assert.equal(labels.length, 12);
  }
  assert.doesNotMatch(JSON.stringify(sceneMessages.en), /[㐀-鿿]/);
});

// The preview page sums up everything since the current stable release, not just
// the last beta (Jevons 10-27): it names that baseline and links the notes of every
// release line between it and this version, whose own notes are the release link.
test('the preview page covers every release line since the stable baseline', () => {
  const minor = value => Number(value.split('.')[1]);
  for (const [route, locale] of [['', 'zh-CN'], ['en/', 'en']]) {
    const { document } = parseHTML(files.get(`next/${route}index.html`));
    const baseline = document.querySelector('[data-preview-baseline]')?.dataset.previewBaseline;
    assert.match(baseline ?? '', /^\d+\.\d+\.\d+$/);
    assert.ok(minor(baseline) < minor(version), 'the baseline is the stable release before this preview');
    assert.ok(messages[locale]['next.description'].includes(baseline));
    assert.ok(messages[locale]['next.changes'].includes(baseline));
    const notes = new Map([...document.querySelectorAll('[data-release-notes]')].map(link => [link.dataset.releaseNotes, link.href]));
    for (let line = minor(baseline) + 1; line < minor(version); line += 1) {
      const release = `0.${line}.0`;
      assert.equal(notes.get(release), `https://github.com/JevonsCode/fuli/blob/main/docs/releases/${release}.md`);
      assert.ok(read(`../docs/releases/${release}.md`).length > 0);
    }
  }
});

test('the preview install commands use the variable the site installers read', () => {
  assert.match(read('../site/install.sh'), /package_spec="\$\{FULI_NPM_PACKAGE_SPEC:-fuli-context@latest\}"/);
  assert.match(read('../site/install.ps1'), /\$env:FULI_NPM_PACKAGE_SPEC/);
});

test('the stable page links to the preview page in its own language', () => {
  for (const [route, locale] of [['', 'zh-CN'], ['en/', 'en']]) {
    const { document } = parseHTML(files.get(route + 'index.html'));
    assert.equal(document.querySelector('.start-links [data-i18n="start.preview"]').href, messages[locale]['start.previewUrl']);
  }
  assert.equal(messages['zh-CN']['start.previewUrl'], base + 'next/');
  assert.equal(messages.en['start.previewUrl'], base + 'next/en/');
});

test('a stable version has no newer preview, so /next/ says so and links home in its language', () => {
  const site = pages('0.22.0');
  for (const [route, locale] of [['', 'zh-CN'], ['zh/', 'zh-CN'], ['en/', 'en']]) {
    const { document } = parseHTML(site.get(`next/${route}index.html`));
    assert.equal(document.documentElement.lang, locale);
    assert.match(document.querySelector('meta[name="robots"]').content, /noindex/);
    assert.equal(document.querySelector('link[rel="canonical"]').href, base + route);
    assert.ok(document.querySelector('main p').textContent.includes('0.22.0'));
    assert.deepEqual([...document.querySelectorAll('a')].map(link => link.href), [base + route]);
    assert.equal(document.querySelector('.preview-changes, [data-preview-version], .terminal'), null);
    if (locale === 'en') assert.doesNotMatch(document.documentElement.textContent, /[㐀-鿿]/);
  }
  assert.doesNotMatch(site.get('sitemap.xml'), /\/next\//);
});
