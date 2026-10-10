import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { createLanguageController, resolveLanguage } from '../site/i18n.js';
import { messages, sceneMessages } from '../site/translations.js';

const html = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
const page = () => parseHTML(html).document;

test('the first supported browser language is used, with English as fallback', () => {
  assert.equal(resolveLanguage(['zh-TW', 'en-US']), 'zh-CN');
  assert.equal(resolveLanguage(['zh-Hans-CN']), 'zh-CN');
  assert.equal(resolveLanguage(['en-GB', 'zh-CN']), 'en');
  assert.equal(resolveLanguage(['fr-FR', 'zh-CN']), 'zh-CN');
  assert.equal(resolveLanguage(['ja-JP']), 'en');
  assert.equal(resolveLanguage([]), 'en');
  assert.equal(resolveLanguage(['zh-CN'], 'en'), 'en');
  assert.equal(resolveLanguage(['en-US'], 'zh-CN'), 'zh-CN');
  assert.equal(resolveLanguage(['en-US'], 'invalid'), 'en');
});

test('only an explicit language choice is saved and restored on the next visit', () => {
  const saved = new Map();
  const getStorage = () => ({ getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) });
  const document = page();
  const language = createLanguageController({ document, languages: ['en-US'], getStorage });
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(saved.size, 0);
  let notified;
  language.subscribe(locale => { notified = locale; });
  language.setLocale('zh-CN');
  assert.equal(notified, 'zh-CN');
  assert.equal(document.documentElement.lang, 'zh-CN');
  assert.equal(document.querySelector('[data-locale="zh-CN"]').getAttribute('aria-current'), 'true');
  assert.equal(createLanguageController({ document: page(), languages: ['en-US'], getStorage }).locale, 'zh-CN');
});

test('a language-specific page takes precedence over browser and saved preferences', () => {
  const document = page();
  document.documentElement.dataset.pageLocale = 'en';
  const language = createLanguageController({ document, languages: ['zh-CN'], getStorage: () => ({ getItem: () => 'zh-CN' }) });
  assert.equal(language.locale, 'en');
});

test('language selection still works when reading or writing storage is blocked', () => {
  for (const getStorage of [
    () => { throw new Error('storage blocked'); },
    () => ({ getItem: () => null, setItem: () => { throw new Error('quota exceeded'); } }),
  ]) {
    const language = createLanguageController({ document: page(), languages: ['en-US'], getStorage });
    language.setLocale('zh-CN');
    assert.equal(language.locale, 'zh-CN');
  }
});

test('both languages cover the complete page, accessibility text, metadata and scene labels', () => {
  assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(messages['zh-CN']).sort());
  const document = page();
  const language = createLanguageController({ document, languages: ['en-US'] });
  assert.equal(document.title, messages.en['meta.title']);
  assert.equal(document.querySelector('#database .chapter-copy > p:last-child').textContent, messages.en['database.description']);
  for (const element of document.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      if (!attribute.name.startsWith('data-i18n')) continue;
      assert.ok(messages.en[attribute.value], `Missing English: ${attribute.value}`);
      assert.ok(messages['zh-CN'][attribute.value], `Missing Chinese: ${attribute.value}`);
    }
  }
  // Brand spelling and the language selector intentionally retain their native names.
  for (const element of document.querySelectorAll('.brand, .language-switch')) element.remove();
  assert.doesNotMatch(document.documentElement.textContent, /[\u3400-\u9fff]/);
  for (const element of document.querySelectorAll('[aria-label], meta[content]')) {
    assert.doesNotMatch(element.getAttribute('aria-label') ?? element.getAttribute('content'), /[\u3400-\u9fff]/);
  }
  assert.match(document.querySelector('.start-links .button').href, /\/README\.md$/);
  for (const [scene, labels] of Object.entries(sceneMessages.en)) {
    assert.equal(labels.length, 12, scene);
    assert.equal(sceneMessages['zh-CN'][scene].length, 12, scene);
    assert.doesNotMatch(JSON.stringify(labels), /[\u3400-\u9fff]/);
  }
  const commands = [...document.querySelectorAll('.terminal code, .start code')].map(node => node.textContent);
  language.setLocale('zh-CN');
  assert.deepEqual([...document.querySelectorAll('.terminal code, .start code')].map(node => node.textContent), commands);
  assert.match(document.querySelector('.start-links .button').href, /\/README\.zh-CN\.md$/);
  assert.doesNotMatch(document.documentElement.textContent, /不按天数遗忘/);
});
