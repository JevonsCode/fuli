import assert from 'node:assert/strict';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';

const CONFIG = {
  version: 1,
  personal: {
    providerUrl: 'http://127.0.0.1:8787',
    accessToken: 'personal-token',
    principalId: 'person-local',
    spaceId: 'personal-space'
  },
  workspaces: [{
    providerUrl: 'https://workspace.example',
    accessToken: 'workspace-token',
    principalId: 'person-remote'
  }]
};

test('node project actions preview conflicts and keep the default source relation locally',
  async () => {
    const calls = [];
    const app = new FederatedGraphApplication(CONFIG, {
      fetchImpl: providerFetch(calls, {
        '/v1/knowledge/items/entity-1/project-action/preview': {
          match: { kind: 'conflict' }
        },
        '/v1/knowledge/items/entity-1/project-action': {
          status: 'conflict_pending'
        }
      })
    });

    const preview = await app.previewKnowledgeProjectAction({
      personalSpaceId: 'personal-space',
      itemKind: 'entity',
      itemId: 'entity-1',
      targetProjectId: 'project-a'
    });
    assert.equal(preview.match.kind, 'conflict');

    await app.applyKnowledgeProjectAction({
      personalSpaceId: 'personal-space',
      itemKind: 'entity',
      itemId: 'entity-1',
      mode: 'existing',
      targetProjectId: 'project-a',
      keepSourceRelation: true,
      relationType: 'RELATED_TO',
      conflictResolution: 'defer',
      reason: '让 A 项目使用这条知识'
    });

    const request = calls.at(-1);
    assert.equal(request.origin, 'http://127.0.0.1:8787');
    assert.deepEqual(request.body, {
      personal_space_id: 'personal-space',
      item_kind: 'entity',
      mode: 'existing',
      target_project_id: 'project-a',
      new_project_id: null,
      new_project_name: null,
      new_project_purpose: null,
      keep_source_relation: true,
      relation_type: 'RELATED_TO',
      conflict_resolution: 'defer',
      reason: '让 A 项目使用这条知识',
      operation_actor: 'agent'
    });
    assert.equal(calls.some(({ origin }) => origin === 'https://workspace.example'), false);
  });

test('node project creation preview forwards the complete intent without applying it',
  async () => {
    const calls = [];
    const app = new FederatedGraphApplication(CONFIG, {
      fetchImpl: providerFetch(calls, {
        '/v1/knowledge/items/entity-1/project-action/preview': {
          item_id: 'entity-1',
          item_name: '酒店项目',
          item_summary: '酒店活动承接知识。',
          source_project_id: 'activity-platform',
          target_project_id: 'hotel',
          match: {
            kind: 'none',
            reason: '新项目标识可用，尚未执行创建。'
          }
        }
      })
    });

    await app.previewKnowledgeProjectAction({
      personalSpaceId: 'personal-space',
      itemKind: 'entity',
      itemId: 'entity-1',
      mode: 'create',
      targetProjectId: null,
      newProjectId: 'hotel',
      newProjectName: '酒店项目',
      newProjectPurpose: '承接酒店活动。',
      keepSourceRelation: true,
      relationType: 'PART_OF',
      conflictResolution: 'defer',
      reason: '先预览创建酒店子项目'
    });

    assert.deepEqual(calls.at(-1).body, {
      personal_space_id: 'personal-space',
      item_kind: 'entity',
      mode: 'create',
      target_project_id: null,
      new_project_id: 'hotel',
      new_project_name: '酒店项目',
      new_project_purpose: '承接酒店活动。',
      keep_source_relation: true,
      relation_type: 'PART_OF',
      conflict_resolution: 'defer',
      reason: '先预览创建酒店子项目'
    });
    assert.equal(
      calls.some(({ path }) => path.endsWith('/project-action')),
      false
    );
  });

function providerFetch(calls, routes) {
  return async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    calls.push({
      origin: url.origin,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      method: options.method ?? 'GET',
      body: options.body ? JSON.parse(options.body) : null,
      authorization: options.headers?.authorization
    });
    const payload = routes[url.pathname] ?? [];
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
}
