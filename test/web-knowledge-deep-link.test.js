import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findDeepLinkSpaceKey,
  parseKnowledgeDeepLink
} from '../web/js/knowledge-deep-link.js';

test('knowledge deep links decode a bounded Fuli item target', () => {
  assert.deepEqual(
    parseKnowledgeDeepLink(
      '#/knowledge/personal/personal%20space/relationship/relationship%2F1'
    ),
    {
      scope: 'personal',
      spaceId: 'personal space',
      itemKind: 'relationship',
      itemId: 'relationship/1'
    }
  );
  assert.equal(parseKnowledgeDeepLink('#/knowledge/personal/space/unknown/item'), null);
  assert.equal(parseKnowledgeDeepLink('#/other/personal/space/entity/item'), null);
});

test('deep links resolve one exact personal or public knowledge space', () => {
  const spaces = new Map([
    ['personal:one', { id: 'personal-space', providerUrl: null }],
    ['personal-project:one:a', {
      id: 'personal-space', providerUrl: null, personalProjectId: 'a'
    }],
    ['project:one', { id: 'project-space', providerUrl: 'https://provider.example' }]
  ]);

  assert.equal(findDeepLinkSpaceKey(spaces, {
    scope: 'personal', spaceId: 'personal-space'
  }), 'personal:one');
  assert.equal(findDeepLinkSpaceKey(spaces, {
    scope: 'project', spaceId: 'project-space'
  }), 'project:one');
  assert.equal(findDeepLinkSpaceKey(spaces, {
    scope: 'project', spaceId: 'missing'
  }), null);
});
