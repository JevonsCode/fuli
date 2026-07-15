import assert from 'node:assert/strict';
import test from 'node:test';

import { readWebFile, webSource } from '../test-support/web-source.js';

test('local console leaves capture and querying to agents', () => {
  const html = readWebFile('index.html');
  const app = webSource('app.js', 'js/actions.js', 'js/elements.js');

  assert.doesNotMatch(html, /remember-form|search-form|remember-body|search-query/);
  assert.doesNotMatch(app, /export async function remember|export async function search/);
  assert.match(html, /data-view="overview"/);
  assert.match(html, /data-view="pending"/);
});

test('local console keeps stable layout and accessible focus states', () => {
  const css = webSource('styles/base.css', 'styles/controls.css', 'styles/layout.css');

  assert.match(css, /\[hidden\] {\s*display: none !important;/);
  assert.match(css, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /outline: 2px solid #171d1a/);
});

test('mobile navigation stays compact as a two by two grid', () => {
  const css = readWebFile('styles/responsive.css');

  assert.match(css, /\.console-nav,\s*\.metric-grid {\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(css, /\.console-nav {\s*grid-template-columns: 1fr/);
});
