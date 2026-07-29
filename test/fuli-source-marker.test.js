import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFuliSourceMarker,
  sourceConsoleUrl
} from '../src/graphiti/source-marker.js';

test('matched Fuli source marker uses terminal-safe Markdown deep links', () => {
  const marker = createFuliSourceMarker({
    consoleUrl: 'http://127.0.0.1:4545',
    facts: [{
      id: 'relationship-1',
      scope: 'personal',
      spaceId: 'personal-space',
      source_entity: '需求',
      target_entity: '实现'
    }],
    entities: [{
      id: 'entity-1',
      scope: 'project',
      space_id: 'project-space',
      name: '来源标记'
    }]
  });

  assert.equal(marker.required, true);
  assert.equal(marker.status, 'matched');
  assert.equal(marker.count, 2);
  assert.match(marker.leadMarkdown, /^\*\*\[🌠 FULI · 知识增强\]/);
  assert.match(
    marker.leadMarkdown,
    /http:\/\/127\.0\.0\.1:4545\/#\/knowledge\/personal\/personal-space\/relationship\/relationship-1/
  );
  assert.equal(marker.markdown, [
    '**FULI 来源 · 2 条**',
    '',
    '- [需求 → 实现](http://127.0.0.1:4545/#/knowledge/personal/' +
      'personal-space/relationship/relationship-1)',
    '- 另有 1 条命中，可在 Fuli 中查看'
  ].join('\n'));
  assert.doesNotMatch(marker.markdown, /<\/?(?:details|summary)>/i);
});

test('empty Fuli search produces an explicit no-match marker without fake citations', () => {
  const marker = createFuliSourceMarker();

  assert.equal(marker.status, 'no_match');
  assert.equal(marker.count, 0);
  assert.equal(
    marker.leadMarkdown,
    '**[◇ FULI · 已检索，未命中](http://127.0.0.1:2727/)**'
  );
  assert.equal(marker.markdown, [
    '**FULI 来源 · 未命中**',
    '',
    '- [打开 Fuli](http://127.0.0.1:2727/)'
  ].join('\n'));
  assert.doesNotMatch(marker.markdown, /<\/?(?:details|summary)>/i);
  assert.doesNotMatch(marker.markdown, /#\/knowledge\//);
});

test('source marker uses the configured local console origin and rejects non-loopback URLs', () => {
  const configured = sourceConsoleUrl('/data/graph-runtime.json', {
    readText: () => JSON.stringify({ url: 'http://localhost:3838/ignored/path' })
  });
  const rejected = sourceConsoleUrl('/data/graph-runtime.json', {
    readText: () => JSON.stringify({ url: 'https://console.example' })
  });

  assert.equal(configured, 'http://localhost:3838');
  assert.equal(rejected, 'http://127.0.0.1:2727');
});
