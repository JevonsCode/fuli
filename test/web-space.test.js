import assert from 'node:assert/strict';
import test from 'node:test';

import { readWebFile, webSource } from '../test-support/web-source.js';

test('local console bootstraps an empty store without setup questions', () => {
  const app = readWebFile('js/state.js');

  assert.match(app, /ensureStarterSpaces/);
  assert.match(app, /\/api\/bootstrap/);
});

test('connections view localizes space kinds and subscription direction', () => {
  const html = readWebFile('index.html');
  const app = webSource('js/render-connections.js', 'js/util.js');

  assert.match(html, /<option value="personal">个人<\/option>/);
  assert.match(html, /<option value="public">公共<\/option>/);
  assert.match(app, /spaceKindLabel\(space\.kind\)/);
  assert.match(app, /space\.kind === 'personal' \? sub\.personalSpaceId === space\.id : sub\.spaceId === space\.id/);
  assert.match(app, /`\$\{count\} 个订阅` : `\$\{count\} 人订阅`/);
});

test('connections view keeps space management collapsed', () => {
  const html = readWebFile('index.html');

  assert.match(html, /<details class="space-tools data-section">[\s\S]*<summary>管理空间<\/summary>/);
  assert.match(html, /form id="space-form"/);
  assert.match(html, /form id="subscription-form"/);
  assert.doesNotMatch(html, /<details class="space-tools data-section" open>/);
});

test('connections management controls have accessible names', () => {
  const html = readWebFile('index.html');

  assert.match(html, /id="space-name"[^>]*aria-label="空间名称"/);
  assert.match(html, /id="space-kind"[^>]*aria-label="空间类型"/);
});
