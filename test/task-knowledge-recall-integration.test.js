import assert from 'node:assert/strict';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { successToolResult } from '../src/mcp/tool-result.js';

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

test('preference entry performs bounded project recall from the current task prompt', async () => {
  const calls = [];
  const prompt = '检查一下代码，有问题暂停和我讨论，没问题发布一个新版本 0.7.0';
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: providerFetch(calls, {
      '/v1/personal-projects': [{ project_id: 'fuli' }],
      '/v1/collaboration-preferences': {
        personal_space_id: 'personal-space',
        personal_project_id: 'fuli',
        global_preferences: [],
        project_preferences: [],
        effective_preferences: [],
        conflicts: [],
        overridden_global_ids: [],
        truncated: false
      },
      '/v1/preference-conflicts': [],
      '/v1/search': {
        facts: [],
        entities: [{
          id: 'submit-runbook',
          space_id: 'personal-space',
          name: 'FULI GitHub Connector 提交 Runbook',
          type: 'Runbook',
          summary: 'Use the connected GitHub Connector for submission.',
          key: 'fuli-github-connector-submit-runbook',
          defined_project_id: 'fuli',
          scope_distance: 0,
          confirmation_status: 'confirmed',
          score: 1
        }]
      },
      '/v1/knowledge/agent-views': { recorded_count: 1, item_keys: [] }
    }),
    projectPathResolver: () => ({
      status: 'matched',
      basis: 'repository_root',
      personalProjectId: 'fuli'
    })
  });

  const result = await app.getCollaborationPreferences({
    projectPath: '/workspace/fuli',
    taskPrompt: prompt,
    agentInvocation: true
  });

  const searches = calls.filter(({ path }) => path === '/v1/search');
  assert.ok(searches.length >= 2);
  assert.equal(calls.some(({ path }) => path === '/v1/subscriptions'), false);
  assert.ok(searches.every(({ body }) => body.active_personal_project_id === 'fuli'));
  assert.ok(searches.every(({ body }) => body.query !== prompt));
  assert.equal(result.task_knowledge_recall.status, 'matched');
  assert.equal(
    result.task_knowledge_recall.entities[0].key,
    'fuli-github-connector-submit-runbook'
  );
  assert.match(
    result.task_knowledge_recall.sourceMarker.leadMarkdown,
    /\/entity\/submit-runbook/
  );
  const toolResult = successToolResult(result, { limitBytes: 16 * 1024 });
  assert.equal(
    typeof toolResult.structuredContent.task_knowledge_recall.guidance,
    'object'
  );
  assert.match(
    toolResult.structuredContent.task_knowledge_recall.guidance.candidate_selection,
    /candidates.*materially support.*noMatchSourceMarker/i
  );
  assert.equal(JSON.stringify(result).includes(prompt), false);
  assert.equal(JSON.stringify(result).includes('/workspace/fuli'), false);
});

function providerFetch(calls, routes) {
  return async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    calls.push({
      path: url.pathname,
      body: options.body ? JSON.parse(options.body) : null
    });
    return new Response(JSON.stringify(routes[url.pathname] ?? []), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
}
