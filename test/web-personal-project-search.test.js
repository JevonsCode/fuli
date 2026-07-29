import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import {
  clearGraphSearchStatus,
  discoverPersonalProjectResults,
  personalProjectSearchHref,
  renderGraphSearchStatus
} from '../web/js/personal-project-search.js';

const projects = [
  { project_id: 'activity', profile: { name: '活动承接' } },
  { project_id: 'hotel', profile: { name: '酒店主题' } }
];

test('aggregate personal search discovers only project-added candidates', async () => {
  const calls = [];
  const baseline = {
    entities: [{ id: 'global-1', score: 8 }],
    facts: []
  };
  const result = await discoverPersonalProjectResults({
    personalSpaceId: 'personal-space',
    projects,
    query: '千人来华',
    baseline,
    getJson: async (url) => {
      calls.push(new URL(url, 'http://localhost'));
      const projectId = calls.at(-1).searchParams.get('personalProjectId');
      if (projectId === 'activity') {
        return {
          entities: [{ id: 'global-1', score: 8 }],
          facts: [
            { id: 'activity-1', score: 4.5 },
            { id: 'activity-2', score: 3.2 }
          ]
        };
      }
      return baseline;
    }
  });

  assert.deepEqual(result.matches.map(({ project, count }) => ({
    projectId: project.project_id,
    count
  })), [{ projectId: 'activity', count: 2 }]);
  assert.equal(result.checked, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(calls.map((url) => url.searchParams.get('personalProjectId')), [
    'activity', 'hotel'
  ]);
  assert.equal(calls.every((url) => url.searchParams.get('q') === '千人来华'), true);
});

test('project continuation link carries exact scope and search query in the route', () => {
  const href = personalProjectSearchHref({
    personalSpaceId: 'personal-space',
    projectId: 'activity',
    query: '千人来华',
    location: {
      href: 'http://localhost:2727/?unrelated=kept&view=personal-projects'
    }
  });

  assert.equal(
    href,
    '/?unrelated=kept&view=personal-projects&mode=graph&scope=personal' +
      '&space=personal-space&project=activity&q=%E5%8D%83%E4%BA%BA%E6%9D%A5%E5%8D%8E'
  );
});

test('zero-result status is explicit and exposes a real project link', () => {
  const { document } = parseHTML('<section id="status" hidden></section>');
  globalThis.document = document;
  const container = document.querySelector('#status');

  renderGraphSearchStatus(container, {
    query: '千人来华',
    discoveryAttempted: true,
    matches: [{
      project: projects[0],
      count: 5,
      href: '/?project=activity&q=query'
    }],
    checked: 2,
    total: 2
  });

  assert.equal(container.hidden, false);
  assert.match(container.textContent, /没有检索到“千人来华”/);
  assert.match(container.textContent, /活动承接/);
  assert.equal(container.querySelector('a').getAttribute('href'), '/?project=activity&q=query');
  clearGraphSearchStatus(container);
  assert.equal(container.hidden, true);
  assert.equal(container.children.length, 0);
});

test('a scoped zero result does not imply that other projects were searched', () => {
  const { document } = parseHTML('<section id="status" hidden></section>');
  globalThis.document = document;
  const container = document.querySelector('#status');

  renderGraphSearchStatus(container, { query: '未命中内容' });

  assert.match(container.textContent, /当前范围没有找到可定位的内容/);
  assert.doesNotMatch(container.textContent, /其他个人项目/);
});
