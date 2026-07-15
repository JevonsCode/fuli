import assert from 'node:assert/strict';
import test from 'node:test';

import { readWebFile, webSource } from '../test-support/web-source.js';

test('local console keeps automatic observation available from pending work', () => {
  const html = readWebFile('index.html');
  const app = webSource('app.js', 'js/actions.js', 'js/elements.js');

  assert.match(html, /data-view-panel="pending"[\s\S]*id="observe-button"[\s\S]*检查改动/);
  assert.match(html, /id="refresh-button"[\s\S]*刷新/);
  assert.match(app, /\/api\/observe\/git-diff/);
  assert.match(app, /personalSpaceId: elements\.activePersonal\.value/);
  assert.match(app, /targetSpaceId: null/);
  assert.doesNotMatch(app, /resolveObservedTargetId|\.find\(\(space\)/);
  assert.match(app, /发现 \$\{result\.observed\.length\} 条改动/);
  assert.match(app, /'暂无新改动'/);
});

test('local console is a runtime surface rather than a manual capture surface', () => {
  const html = readWebFile('index.html');

  assert.match(html, /正在连接/);
  assert.doesNotMatch(html, /textarea|id="remember-|id="search-/);
  assert.doesNotMatch(html, /placeholder="写|placeholder="问/);
});

test('view switching has one small module and clears stale feedback', () => {
  const source = readWebFile('js/views.js');

  assert.match(source, /let activeView = 'overview'/);
  assert.match(source, /panel\.hidden = panel\.dataset\.viewPanel !== activeView/);
  assert.match(source, /button\.setAttribute\('aria-pressed'/);
  assert.match(source, /hideFeedback\(\)/);
});
