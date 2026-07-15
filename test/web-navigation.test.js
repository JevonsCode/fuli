import assert from 'node:assert/strict';
import test from 'node:test';

import { readWebFile, webSource } from '../test-support/web-source.js';

test('local console uses the four runtime views without legacy action entries', () => {
  const html = readWebFile('index.html');
  const source = webSource(
    'index.html',
    'app.js',
    'js/actions.js',
    'js/elements.js',
    'js/render.js',
    'js/state.js'
  );

  assert.deepEqual(
    [...html.matchAll(/data-view="([^"]+)"[^>]*>(?:\s*<[^>]+>[^<]*<\/[^>]+>\s*)?([^<]+)/g)]
      .map((match) => [match[1], match[2].trim()]),
    [
      ['overview', '概览'],
      ['memory', '记忆'],
      ['pending', '待确认'],
      ['connections', '连接']
    ]
  );
  assert.equal([...html.matchAll(/data-view-panel=/g)].length, 4);
  for (const prefix of ['记', '问', '看']) assert.equal(source.includes(`${prefix}一下`), false);
  assert.doesNotMatch(html, /data-entry=|data-entry-panel=|remember-form|search-form/);
});

test('runtime status starts neutral and only reports success after state loads', () => {
  const html = readWebFile('index.html');
  const source = webSource('app.js', 'js/elements.js', 'js/state.js', 'js/status.js');

  assert.match(html, /id="runtime-status">正在连接<\/strong>/);
  assert.doesNotMatch(html, /<strong>本地运行中<\/strong>/);
  assert.match(source, /setRuntimeStatus\('online'\)/);
  assert.match(source, /catch \(error\)[\s\S]*setRuntimeStatus\('error'\)[\s\S]*handleActionError\(error\)/);
});
