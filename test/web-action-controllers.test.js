import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import { createKnowledgeActions } from '../web/js/knowledge-actions.js';
import { createProjectActions } from '../web/js/project-actions.js';
import { createReviewController } from '../web/js/review-controller.js';

test('knowledge actions share one request and completion boundary', async () => {
  const requests = [];
  const feedback = [];
  const reloads = [];
  const actions = createKnowledgeActions({
    patchJson: async (url, body) => {
      requests.push(['patch', url, body]);
      return { status: 'updated' };
    },
    postJson: async (url, body) => {
      requests.push(['post', url, body]);
      return { status: 'linked' };
    },
    reloadState: async () => reloads.push('state'),
    reloadKnowledge: async () => reloads.push('knowledge'),
    onFeedback: (message) => feedback.push(message)
  });

  await actions.revise({
    itemId: 'entity/1',
    itemKind: 'entity',
    action: 'invalidate',
    reason: 'outdated'
  });
  await actions.reassign({
    itemId: 'entity/1',
    itemKind: 'entity',
    targetProjectId: 'fuli'
  });
  await actions.completeProjectAction({ status: 'linked' }, 'Fuli');

  assert.deepEqual(requests[0], [
    'patch',
    '/api/knowledge/entity/entity%2F1',
    { action: 'invalidate', reason: 'outdated' }
  ]);
  assert.deepEqual(requests[1], [
    'post',
    '/api/knowledge/entity/entity%2F1/assignment',
    { targetProjectId: 'fuli' }
  ]);
  assert.deepEqual(reloads, ['state', 'knowledge']);
  assert.match(feedback[0], /标记为失效/);
  assert.match(feedback.at(-1), /加入“Fuli”/);
});

test('project actions share publication, relation, and deletion rules', async () => {
  const requests = [];
  const views = [];
  const feedback = [];
  const state = {
    activePersonalSpaceId: 'personal-1',
    providers: {
      workspaces: [
        { status: 'error', providerUrl: 'https://offline.example' },
        { status: 'ready', providerUrl: 'https://provider.example/' }
      ]
    }
  };
  const actions = createProjectActions({
    deleteJson: async (url) => {
      requests.push(['delete', url]);
      return { project_name: 'Fuli' };
    },
    postJson: async (url, body) => {
      requests.push(['post', url, body]);
      return { project: { name: 'Fuli' } };
    },
    getState: () => state,
    reloadState: async () => requests.push(['reload']),
    selectView: (view) => views.push(view),
    onFeedback: (message) => feedback.push(message)
  });

  await actions.publishPersonalProject({
    localProjectId: 'fuli',
    releaseVersion: 'v1.0.1',
    updateSummary: 'Split controllers.'
  });
  await actions.createProjectRelation({
    source: { id: 'fuli', providerUrl: 'https://provider.example/' },
    target: { id: 'platform', providerUrl: 'https://provider.example/' },
    relationType: 'PART_OF'
  });
  await actions.deletePublicProject({
    id: 'public/1',
    name: 'Fuli',
    providerUrl: 'https://provider.example/'
  });
  await actions.completePublication(
    { project: { name: 'Fuli' } },
    { projectName: 'Fuli', releaseVersion: 'v1.0.1' }
  );

  assert.deepEqual(requests[0], [
    'post',
    '/api/projects/publish',
    {
      personalSpaceId: 'personal-1',
      localProjectId: 'fuli',
      providerUrl: 'https://provider.example/',
      releaseVersion: 'v1.0.1',
      updateSummary: 'Split controllers.'
    }
  ]);
  assert.equal(actions.suggestedNextVersion('v1.2.3'), 'v1.2.4');
  assert.equal(actions.suggestedNextVersion('legacy'), 'v1.0.0');
  assert.match(requests[2][1], /public%2F1\?providerUrl=https%3A%2F%2Fprovider\.example%2F/);
  assert.deepEqual(views, ['public-projects']);
  assert.match(feedback.join(' '), /等待父项目确认/);
  assert.match(feedback.join(' '), /已删除/);
  assert.match(feedback.join(' '), /v1\.0\.1 已发布/);
});

test('review controller renders and decides both review queues', async () => {
  const { document } = parseHTML(`
    <span id="metric"></span><span id="count" hidden></span>
    <div id="personal"></div><div id="shared"></div>
  `);
  globalThis.document = document;
  const posts = [];
  const ui = {
    metricReview: document.querySelector('#metric'),
    reviewCount: document.querySelector('#count'),
    personalReviewList: document.querySelector('#personal'),
    reviewList: document.querySelector('#shared')
  };
  const episode = {
    name: 'Shared validation',
    summary: 'Validation is centralized.',
    source_description: 'Confirmed refactor',
    source_kind: 'conversation',
    sensitivity: 'normal',
    reference_time: '2026-07-23T08:00:00Z',
    entities: [{
      type: 'CodeSymbol',
      name: 'model_validation',
      summary: 'Shared model validation',
      origin_quadrant: 'known_known',
      epistemic_status: 'confirmed'
    }],
    relationships: []
  };
  const controller = createReviewController({
    ui,
    getState: () => ({
      activePersonalSpaceId: 'personal-1',
      capabilities: { submitKnowledge: true }
    }),
    getReviewProject: () => ({
      id: 'project-1',
      providerUrl: 'https://provider.example'
    }),
    getJson: async (url) => url.startsWith('/api/personal-review?')
      ? {
          drafts: [{
            id: 'draft/1',
            created_at: '2026-07-23T08:00:00Z',
            episode
          }]
        }
      : {
          proposals: [{
            id: 'proposal/1',
            created_at: '2026-07-23T08:00:00Z',
            episode
          }]
        },
    postJson: async (url, body) => posts.push([url, body]),
    reloadState: async () => {},
    reloadKnowledge: async () => {},
    onError(error) { throw error; }
  });

  await controller.loadPersonal();
  await controller.loadShared();
  assert.equal(ui.metricReview.textContent, '2');
  assert.equal(ui.reviewCount.hidden, false);
  assert.match(ui.personalReviewList.textContent, /提交公共/);
  assert.match(ui.sharedReviewList?.textContent ?? ui.reviewList.textContent, /通过/);

  await controller.handlePersonalDecision({
    target: ui.personalReviewList.querySelector('[data-personal-decision="submit_public"]')
  });
  await controller.handleSharedDecision({
    target: ui.reviewList.querySelector('[data-decision="approve"]')
  });

  assert.deepEqual(posts[0], [
    '/api/personal-review/draft%2F1/decision',
    { decision: 'submit_public' }
  ]);
  assert.deepEqual(posts[1], [
    '/api/review/proposal%2F1/decision',
    {
      projectId: 'project-1',
      providerUrl: 'https://provider.example',
      decision: 'approve',
      note: null
    }
  ]);
});
