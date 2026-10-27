import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { createSitePages } from '../scripts/build-site.js';
import { messages } from '../site/translations.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const { version } = JSON.parse(read('../package.json'));
const files = createSitePages({ home: read('../site/index.html'), preview: read('../site/next/index.html'), version });
const base = 'https://xn--8ovp9s.xn--m8txu.com/fuli/';
const installers = [
  'curl -fsSL https://xn--8ovp9s.xn--m8txu.com/fuli/install.sh | FULI_NPM_PACKAGE_SPEC=fuli-context@beta sh',
  "$env:FULI_NPM_PACKAGE_SPEC='fuli-context@beta'; irm https://xn--8ovp9s.xn--m8txu.com/fuli/install.ps1 | iex",
  'npm install --global fuli-context@beta && fuli setup',
];

test('the preview page is built at /next/ in Chinese by default and in English, with the packaged version', () => {
  for (const [route, locale, prefix] of [['', 'zh-CN', '../'], ['zh/', 'zh-CN', '../../'], ['en/', 'en', '../../']]) {
    const { document } = parseHTML(files.get(`next/${route}index.html`));
    assert.equal(document.documentElement.lang, locale);
    assert.equal(document.title, messages[locale]['next.meta.title']);
    assert.equal(document.querySelector('[data-preview-version]').textContent, version);
    assert.equal(document.querySelector('[data-preview-release]').href, `https://github.com/JevonsCode/fuli/releases/tag/v${version}`);
    assert.equal(document.querySelector('link[rel="canonical"]').href, `${base}next/${route}`);
    const alternates = [...document.querySelectorAll('link[hreflang]')].map(node => [node.hreflang, node.href]);
    assert.deepEqual(alternates, [['zh-Hans', base + 'next/zh/'], ['en', base + 'next/en/'], ['x-default', base + 'next/']]);
    assert.equal(document.querySelector('link[rel="stylesheet"]').href, prefix + 'style.css');
    assert.equal(document.querySelector('script[type="module"]').src, prefix + 'next.js');
    assert.equal(document.querySelector('.brand').href, prefix);
    assert.equal(document.querySelector('[data-i18n="next.stable"]').href, messages[locale]['next.stableUrl']);
    assert.ok(document.querySelectorAll('.principles h3').length >= 3, 'a few headed sections summarize the release');
    assert.deepEqual([...document.querySelectorAll('.oneliner code')].map(node => node.textContent.slice(0, -node.querySelector('span').textContent.length)), installers);
    if (locale === 'en') {
      for (const element of document.querySelectorAll('.brand, .language-switch')) element.remove();
      assert.doesNotMatch(document.body.textContent, /[\u3400-\u9fff]/);
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
