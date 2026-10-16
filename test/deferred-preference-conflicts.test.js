import assert from 'node:assert/strict';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { getCollaborationPreferences } from '../src/graphiti/collaboration-preference-workflow.js';
import { deferredPreferenceConflicts } from '../src/graphiti/collaboration-preference-projection.js';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';

const CONFIG = {
  version: 1,
  personal: {
    providerUrl: 'http://127.0.0.1:8787',
    accessToken: 'personal-token',
    principalId: 'person-local',
    spaceId: 'personal-space'
  },
  workspaces: []
};

test('collaboration context always layers global preferences with one exact local project',
  async () => {
    const calls = [];
    const globalPreference = {
      id: 'global-1',
      item_kind: 'entity',
      preference_key: 'writing-style',
      instruction: 'Use direct writing.',
      preference_scope: 'global'
    };
    const projectPreference = {
      id: 'project-1',
      item_kind: 'relationship',
      preference_key: 'ui-density',
      instruction: 'Use compact UI density.',
      preference_scope: 'project',
      preference_project_id: 'fuli'
    };
    const toneA = {
      id: 'tone-a',
      item_kind: 'entity',
      preference_key: 'tone',
      title: '表达语气 A',
      instruction: '使用正式语气。',
      preference_scope: 'global',
      confirmed_at: '2026-07-28T08:00:00Z',
      attributes: {}
    };
    const toneB = {
      ...toneA,
      id: 'tone-b',
      title: '表达语气 B',
      instruction: '使用轻松语气。'
    };
    const app = new FederatedGraphApplication({
      ...CONFIG,
      workspaces: [{
        providerUrl: 'https://workspace.example',
        accessToken: 'workspace-token',
        principalId: 'person-remote'
      }]
    }, {
      fetchImpl: providerFetch(calls, {
        '/v1/personal-projects': [{ project_id: 'fuli' }],
        '/v1/collaboration-preferences': {
          personal_space_id: 'personal-space',
          personal_project_id: 'fuli',
          global_preferences: [globalPreference, toneA, toneB],
          project_preferences: [projectPreference],
          effective_preferences: [globalPreference, projectPreference],
          conflicts: [{
            preference_key: 'tone',
            preference_scope: 'global',
            preference_project_id: null,
            item_ids: ['tone-a', 'tone-b']
          }],
          queued_conflicts: [{
            id: 'tone-conflict',
            personal_space_id: 'personal-space',
            preference_key: 'tone',
            preference_scope: 'global',
            preference_project_id: null,
            left_item_id: 'tone-a',
            left_item_kind: 'entity',
            right_item_id: 'tone-b',
            right_item_kind: 'entity',
            status: 'ai_pending',
            requested_by: 'human',
            reason: '相关任务使用时交给 AI 判断。',
            deferred_at: '2026-07-29T01:00:00Z',
            updated_at: '2026-07-29T01:00:00Z'
          }],
          overridden_global_ids: [],
          source_windows: {
            candidates_truncated: false,
            project_ancestors_truncated: false,
            queued_conflicts_truncated: false
          },
          truncated: false
        },
        '/v1/knowledge/agent-views': {
          recorded_count: 4,
          item_keys: [
            'entity:global-1',
            'entity:tone-a',
            'entity:tone-b',
            'relationship:project-1'
          ]
        }
      }),
      projectPathResolver: (projectPath, projects) => {
        assert.equal(projectPath, '/workspace/fuli');
        assert.deepEqual(projects, [{ project_id: 'fuli' }]);
        return {
          status: 'matched',
          basis: 'repository_root',
          personalProjectId: 'fuli'
        };
      }
    });

    const result = await app.getCollaborationPreferences({
      projectPath: '/workspace/fuli',
      agentInvocation: true
    });

    assert.ok(calls.some(({ path }) => path === '/v1/personal-projects'));
    const contextRead = calls.find(
      ({ path }) => path === '/v1/collaboration-preferences'
    );
    assert.equal(contextRead.query.personal_space_id, 'personal-space');
    assert.equal(contextRead.query.personal_project_id, 'fuli');
    assert.equal(calls.some(({ path }) => path === '/v1/preference-conflicts'), false);
    assert.equal(result.context.source_truncated, false);
    assert.deepEqual(
      result.effective_preferences.map(({ preference_key: preferenceKey }) => preferenceKey),
      ['writing-style', 'ui-density']
    );
    assert.deepEqual(
      result.effective_preferences.map(({ instruction }) => instruction),
      ['Use direct writing.', 'Use compact UI density.']
    );
    assert.equal('global_preferences' in result, false);
    assert.equal('project_preferences' in result, false);
    assert.equal(result.application_guidance.apply, 'effective_preferences');
    assert.equal(result.context.ai_deferred_conflict_count, 1);
    assert.equal(result.deferred_conflicts[0].id, 'tone-conflict');
    assert.equal(result.deferred_conflicts[0].left.instruction, '使用正式语气。');
    assert.match(
      result.deferred_conflicts[0].required_action,
      /before using either side/i
    );
    assert.deepEqual(result.context.project_resolution, {
      status: 'matched',
      basis: 'repository_root',
      personal_project_id: 'fuli'
    });
    assert.equal(JSON.stringify(result).includes('/workspace/fuli'), false);
    const audit = calls.find(({ path }) => path === '/v1/knowledge/agent-views');
    assert.equal(audit.body.tool_name, 'get_collaboration_preferences');
    assert.deepEqual(audit.body.items, [
      { item_id: 'global-1', item_kind: 'entity' },
      { item_id: 'tone-a', item_kind: 'entity' },
      { item_id: 'tone-b', item_kind: 'entity' },
      { item_id: 'project-1', item_kind: 'relationship' }
    ]);
  });

test('entry uses the Provider active-pair queue and preserves every matching pending ID', async () => {
  const items = ['left', 'right'].map(id => ({ id, item_kind: 'entity', preference_key: 'tone',
    preference_scope: 'global', instruction: id }));
  const queue = ['pending-a', 'pending-b'].map(id => ({ id, status: 'ai_pending',
    left_item_id: 'left', left_item_kind: 'entity', right_item_id: 'right', right_item_kind: 'entity' }));
  const data = { personal_space_id: 'personal-space', global_preferences: items, effective_preferences: [],
    conflicts: [{ preference_key: 'tone', preference_scope: 'global', item_ids: ['left', 'right'] }],
    queued_conflicts: queue, source_windows: { candidates_truncated: false,
      project_ancestors_truncated: false, queued_conflicts_truncated: false }, truncated: false };
  const app = { config: CONFIG, personal: {
    collaborationPreferences: async () => data,
    listPreferenceConflicts: () => { throw new Error('Task entry must not scan the space-wide queue'); }
  } };
  const read = () => getCollaborationPreferences(app, { personalProjectId: null }, { agentInvocation: true }, async () => {});
  const result = await read();
  assert.deepEqual(result.deferred_conflicts.map(item => item.id), ['pending-a', 'pending-b']);
  assert.equal(result.context.source_truncated, false);
  assert.deepEqual(result.context.source_windows, data.source_windows);
  app.getCollaborationPreferences = read;
  const server = createMcpServer(app, { env: {}, toolNames: ['get_collaboration_preferences'], registerResources: false });
  try {
    data.source_windows.queued_conflicts_truncated = true;
    data.truncated = true;
    const response = await server.server._requestHandlers.get('tools/call')({ method: 'tools/call',
      params: { name: 'get_collaboration_preferences', arguments: { projectPath: '/synthetic' } } },
    { signal: new AbortController().signal, requestId: 1 });
    assert.equal(response.structuredContent.preference_delivery.reason, 'source_window');
    assert.equal(Object.hasOwn(response.structuredContent, 'effective_preferences'), false);
  } finally { await server.close(); }
  const wrongKind = { ...queue[0], left_item_kind: 'relationship' };
  assert.deepEqual(deferredPreferenceConflicts(data, [wrongKind]), []);
});

test('legacy Provider reports only relevant source windows as unknown without a space queue fallback', async () => {
  const data = { personal_space_id: 'personal-space', effective_preferences: [], conflicts: [], truncated: false };
  const app = { config: CONFIG, personal: { collaborationPreferences: async () => data,
    listPreferenceConflicts: () => { throw new Error('Legacy entry must not scan the space queue'); } } };
  const read = personalProjectId => getCollaborationPreferences(app, { personalProjectId }, { agentInvocation: true }, async () => {});
  const global = await read(null);
  assert.equal(global.context.source_truncated, false);
  assert.equal(global.context.source_windows.project_ancestors_truncated, false);
  assert.equal(global.context.source_windows.queued_conflicts_truncated, false);
  const project = await read('project-a');
  assert.equal(project.context.source_truncated, true);
  assert.equal(project.context.source_windows.project_ancestors_truncated, null);
  data.conflicts = [{ item_ids: ['left', 'right'], preference_key: 'tone', preference_scope: 'global' }];
  const conflict = await read(null);
  assert.equal(conflict.context.source_truncated, true);
  assert.equal(conflict.context.source_windows.queued_conflicts_truncated, null);
});

test('Agent deferred-conflict resolution maps one audited decision to the personal Provider',
  async () => {
    const calls = [];
    const app = new FederatedGraphApplication(CONFIG, {
      fetchImpl: providerFetch(calls, {
        '/v1/preference-conflicts/conflict-1/resolve': {
          id: 'conflict-1',
          status: 'resolved',
          resolved_by: 'agent',
          resolution: 'merge'
        }
      })
    });

    const result = await app.resolveDeferredPreferenceConflict({
      personalSpaceId: 'personal-space',
      conflictId: 'conflict-1',
      resolution: 'merge',
      canonicalItemId: 'preference-b',
      mergedInstruction: '保留双方已经确认且互补的内容。',
      reason: '当前任务需要该偏好，两条内容互补。',
      operationActor: 'agent'
    });

    assert.equal(result.resolved_by, 'agent');
    assert.equal(calls[0].path, '/v1/preference-conflicts/conflict-1/resolve');
    assert.deepEqual(calls[0].body, {
      personal_space_id: 'personal-space',
      resolution: 'merge',
      reason: '当前任务需要该偏好，两条内容互补。',
      canonical_item_id: 'preference-b',
      merged_instruction: '保留双方已经确认且互补的内容。',
      split_item_id: null,
      split_project_id: null,
      operation_actor: 'agent'
    });
  });

function providerFetch(calls, routes) {
  return async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    calls.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      method: options.method ?? 'GET',
      body: options.body ? JSON.parse(options.body) : null
    });
    return new Response(JSON.stringify(routes[url.pathname] ?? []), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
}
