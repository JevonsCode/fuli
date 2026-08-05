import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFuliSourceMarker,
  sourceConsoleUrl
} from '../src/graphiti/source-marker.js';

test('matched Fuli source marker uses terminal-safe history deep links', () => {
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
    /http:\/\/127\.0\.0\.1:4545\/knowledge\/personal\/personal-space\/directory\/relationship\/relationship-1/
  );
  assert.equal(marker.markdown, [
    '**FULI 来源 · 2 条**',
    '',
    '- [需求 → 实现](http://127.0.0.1:4545/knowledge/personal/' +
      'personal-space/directory/relationship/relationship-1)',
    '- 另有 1 条命中，可在 Fuli 中查看'
  ].join('\n'));
  assert.doesNotMatch(marker.markdown, /<\/?(?:details|summary)>/i);
});

test('empty Fuli search keeps only the lead marker and omits a duplicate footer', () => {
  const marker = createFuliSourceMarker();

  assert.equal(marker.status, 'no_match');
  assert.equal(marker.count, 0);
  assert.equal(
    marker.leadMarkdown,
    '**[◇ FULI · 已检索，未命中](http://127.0.0.1:2727/)**'
  );
  assert.equal(marker.markdown, '');
  assert.doesNotMatch(marker.markdown, /<\/?(?:details|summary)>/i);
  assert.doesNotMatch(marker.markdown, /#\/knowledge\//);
});

test('source marker boosts exact-project knowledge over a nearby personal-global match', () => {
  const marker = createFuliSourceMarker({
    facts: [{
      id: 'global-fact',
      scope: 'personal',
      space_id: 'personal-space',
      source_entity: 'Other project',
      target_entity: 'Release note',
      defined_project_id: null,
      score: 1.4
    }],
    entities: [{
      id: 'local-runbook',
      scope: 'personal',
      space_id: 'personal-space',
      name: 'Current project release runbook',
      defined_project_id: 'current-project',
      scope_distance: 0,
      score: 1
    }]
  });

  assert.match(marker.leadMarkdown, /\/entity\/local-runbook/);
  assert.match(marker.markdown, /Current project release runbook/);
  assert.doesNotMatch(marker.markdown, /Other project/);
});

test('source marker keeps substantially stronger global evidence ahead of weak local noise', () => {
  const marker = createFuliSourceMarker({
    facts: [{
      id: 'strong-global-fact',
      scope: 'personal',
      space_id: 'personal-space',
      source_entity: 'Exact global preference',
      target_entity: 'Current answer',
      defined_project_id: null,
      score: 9
    }],
    entities: [{
      id: 'weak-local-item',
      scope: 'personal',
      space_id: 'personal-space',
      name: 'Weak local candidate',
      defined_project_id: 'current-project',
      score: 1
    }]
  });

  assert.match(marker.leadMarkdown, /\/relationship\/strong-global-fact/);
});

test('strict project priority keeps project knowledge ahead for automatic task recall', () => {
  const marker = createFuliSourceMarker({
    projectScopePriority: 'strict',
    facts: [{
      id: 'strong-global-fact',
      scope: 'personal',
      space_id: 'personal-space',
      source_entity: 'Global release note',
      target_entity: 'Current answer',
      defined_project_id: null,
      score: 9
    }],
    entities: [{
      id: 'local-runbook',
      scope: 'personal',
      space_id: 'personal-space',
      name: 'Current project release runbook',
      defined_project_id: 'current-project',
      score: 1
    }]
  });

  assert.match(marker.leadMarkdown, /\/entity\/local-runbook/);
});

test('strict project priority keeps the exact project ahead of inherited knowledge', () => {
  const marker = createFuliSourceMarker({
    projectScopePriority: 'strict',
    facts: [{
      id: 'inherited-runbook',
      scope: 'personal',
      space_id: 'personal-space',
      source_entity: 'Parent project',
      target_entity: 'Release runbook',
      defined_project_id: 'parent-project',
      scope_distance: 1,
      score: 9
    }],
    entities: [{
      id: 'exact-runbook',
      scope: 'personal',
      space_id: 'personal-space',
      name: 'Exact project release runbook',
      defined_project_id: 'current-project',
      scope_distance: 0,
      score: 1
    }]
  });

  assert.match(marker.leadMarkdown, /\/entity\/exact-runbook/);
});

test('strict task priority keeps primary knowledge ahead of validation metadata', () => {
  const marker = createFuliSourceMarker({
    projectScopePriority: 'strict',
    facts: [{
      id: 'validation-edge',
      scope: 'personal',
      space_id: 'personal-space',
      source_entity: 'Recall decision',
      target_entity: 'Release validation',
      relationship: 'VALIDATED_BY',
      defined_project_id: 'current-project',
      scope_distance: 0,
      score: 12
    }],
    entities: [{
      id: 'release-runbook',
      scope: 'personal',
      space_id: 'personal-space',
      name: 'Current project release runbook',
      type: 'Runbook',
      defined_project_id: 'current-project',
      scope_distance: 0,
      score: 1
    }]
  });

  assert.match(marker.leadMarkdown, /\/entity\/release-runbook/);
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
