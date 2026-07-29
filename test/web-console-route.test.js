import assert from 'node:assert/strict';
import test from 'node:test';

import {
  consoleRouteUrl,
  findRouteSpaceKey,
  graphSpaceRoute,
  readConsoleRoute
} from '../web/js/console-route.js';

test('console route restores a personal project knowledge view and its controls', () => {
  const route = readConsoleRoute({
    search: '?view=personal-projects&mode=graph&scope=personal&space=space-1' +
      '&project=fuli&q=%E5%8D%83%E4%BA%BA%E6%9D%A5%E5%8D%8E' +
      '&quadrant=known_known&context=shared-a&context=shared-b'
  });

  assert.deepEqual(route, {
    view: 'personal-projects',
    knowledge: {
      mode: 'graph',
      space: {
        scope: 'personal',
        spaceId: 'space-1',
        projectId: 'fuli'
      },
      query: '千人来华',
      type: 'all',
      quadrant: 'known_known',
      profile: 'all',
      status: 'current',
      contexts: ['shared-a', 'shared-b']
    }
  });
});

test('console route writes only non-default knowledge filters and clears deep-link hashes', () => {
  const url = consoleRouteUrl({
    view: 'graph',
    knowledge: {
      mode: 'directory',
      space: { scope: 'public', spaceId: 'project-1', projectId: null },
      query: 'release',
      type: 'Decision',
      quadrant: 'all',
      profile: 'all',
      status: 'current',
      contexts: []
    }
  }, {
    href: 'http://localhost:4311/?unrelated=kept#/knowledge/personal/space/entity/item'
  });

  assert.equal(
    url,
    '/?unrelated=kept&view=graph&mode=directory&scope=public&space=project-1' +
      '&q=release&type=Decision'
  );
});

test('route space identity avoids serializing Provider URLs', () => {
  const spaces = new Map([
    ['personal:one', { id: 'space-1', providerUrl: null }],
    ['personal-project:one:fuli', {
      id: 'space-1',
      providerUrl: null,
      personalProjectId: 'fuli'
    }],
    ['public:one', {
      id: 'project-1',
      providerUrl: 'https://provider.example'
    }]
  ]);

  assert.deepEqual(graphSpaceRoute(spaces.get('public:one')), {
    scope: 'public',
    spaceId: 'project-1',
    projectId: null
  });
  assert.equal(findRouteSpaceKey(spaces, {
    scope: 'personal',
    spaceId: 'space-1',
    projectId: 'fuli'
  }), 'personal-project:one:fuli');
});
