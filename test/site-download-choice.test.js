import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import { onMac, preferDownloadForThisComputer } from '../site/download-choice.js';
import * as stable from '../site/translations.js';
import * as preview from '../site/next/translations.js';

const page = (path) => parseHTML(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')).document;
const groups = (document) => [...document.querySelectorAll('[data-download-macos]')].map((mac) => mac.parentElement);
const order = (group) => [...group.querySelectorAll('[data-download-windows], [data-download-macos]')]
  .map((link) => `${'downloadMacos' in link.dataset ? 'mac' : 'windows'}${link.classList.contains('button-quiet') ? '-quiet' : ''}`);

const MAC = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', platform: 'MacIntel', maxTouchPoints: 0 };
const IPAD = { ...MAC, maxTouchPoints: 5 };
const WINDOWS = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32', maxTouchPoints: 0 };
const CHROME_MAC = { userAgent: '', platform: '', userAgentData: { platform: 'macOS' } };

test('a Mac is told apart from Windows and from an iPad', () => {
  assert.equal(onMac(MAC), true);
  assert.equal(onMac(CHROME_MAC), true);
  assert.equal(onMac(WINDOWS), false);
  assert.equal(onMac(IPAD), false);
});

test('on a Mac the macOS download comes first with the main style; elsewhere the page stays as shipped', () => {
  for (const path of ['site/index.html', 'site/next/index.html']) {
    const shipped = page(path);
    const before = groups(shipped).map(order);
    assert.ok(before.length > 0, path);
    preferDownloadForThisComputer(shipped, WINDOWS);
    assert.deepEqual(groups(shipped).map(order), before, `${path} on Windows`);

    const mac = page(path);
    preferDownloadForThisComputer(mac, MAC);
    for (const [index, group] of groups(mac).entries()) {
      const [first, second] = order(group);
      assert.equal(first, 'mac', `${path} group ${index}`);
      // A group that had a quiet button keeps one: now Windows.
      if (before[index].some((entry) => entry.endsWith('-quiet'))) assert.equal(second, 'windows-quiet', `${path} group ${index}`);
    }
  }
});

test('every macOS download says it needs Apple silicon, in both languages and in the shipped page', () => {
  for (const catalog of [stable.translations ?? stable.default ?? stable, preview.translations ?? preview.default ?? preview]) {
    const text = JSON.stringify(catalog);
    assert.match(text, /下载 macOS 版（Apple 芯片）/);
    assert.match(text, /Download for macOS \(Apple silicon\)/);
  }
  for (const path of ['site/index.html', 'site/next/index.html']) {
    for (const link of page(path).querySelectorAll('[data-download-macos]')) assert.match(link.textContent, /Apple 芯片/, path);
  }
});
