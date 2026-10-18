import assert from 'node:assert/strict';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { searchFederatedKnowledge } from '../src/graphiti/federated-search.js';

test('agent collaboration preferences preserve inherited scope and rationale metadata', async () => {
  const calls = [];
  const inherited = {
    id: 'parent-a-preference',
    item_kind: 'entity',
    key: 'alignment.network.parent-a.explain-boundary',
    preference_key: 'alignment.network.parent-a.explain-boundary',
    title: '先解释功能边界',
    instruction: '提出实现建议前先解释功能边界。',
    profile_aspect: 'judgment_preference',
    preference_scope: 'project',
    preference_project_id: 'platform-a',
    confirmation_status: 'confirmed',
    weight_percent: 100,
    confirmed_by_person: false,
    confirmation_basis: {
      existence_reason: 'A 的项目约定明确陈述了这条偏好。',
      quadrant_reason: '这条偏好由权威项目资料确认。'
    },
    attributes: {
      preferenceKey: 'alignment.network.parent-a.explain-boundary',
      weight: 0.85,
      reason: 'A 的项目约定明确陈述了这条偏好。'
    },
    weight: 0.85,
    reason: 'A 的项目约定明确陈述了这条偏好。',
    reasoning_summary: null,
    inherited_from_project_id: 'platform-a',
    scope_distance: 1,
    scope_path: ['travel-d', 'platform-a']
  };
  const app = new FederatedGraphApplication({
    personal: {
      providerUrl: 'http://personal.invalid',
      accessToken: 'test-access',
      principalId: 'principal-1',
      spaceId: 'personal-1'
    },
    workspaces: []
  }, {
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url);
      const body = options.body ? JSON.parse(options.body) : null;
      calls.push({ path: parsed.pathname, body });
      if (parsed.pathname === '/v1/collaboration-preferences') {
        return response({
          personal_space_id: 'personal-1',
          personal_project_id: 'travel-d',
          global_preferences: [],
          project_preferences: [inherited],
          effective_preferences: [inherited],
          conflicts: [],
          overridden_global_ids: [],
          overridden_inherited_ids: [],
          truncated: false
        });
      }
      if (parsed.pathname === '/v1/preference-conflicts') return response([]);
      if (parsed.pathname === '/v1/knowledge/agent-views') {
        return response({ recorded_count: 1, item_keys: ['entity:parent-a-preference'] });
      }
      throw new Error(`Unexpected request: ${parsed.pathname}`);
    }
  });

  const result = await app.getCollaborationPreferences({
    personalProjectId: 'travel-d',
    agentInvocation: true
  });

  assert.deepEqual(result.effective_preferences, [{
    instruction: '提出实现建议前先解释功能边界。',
    preference_key: 'alignment.network.parent-a.explain-boundary',
    title: '先解释功能边界',
    profile_aspect: 'judgment_preference',
    preference_scope: 'project',
    preference_project_id: 'platform-a',
    confirmation_status: 'confirmed',
    confirmation_basis: inherited.confirmation_basis,
    attributes: inherited.attributes,
    weight: 0.85,
    reason: 'A 的项目约定明确陈述了这条偏好。',
    reasoning_summary: null,
    inherited_from_project_id: 'platform-a',
    scope_distance: 1,
    scope_path: ['travel-d', 'platform-a']
  }]);
  assert.equal(result.context.inherited_project_preference_count, 1);
  assert.equal(
    calls.find(({ path }) => path === '/v1/knowledge/agent-views')
      .body.items[0].item_id,
    'parent-a-preference'
  );
});

test('Agent search omits console weight fields while console search and confirmation evidence remain complete', async () => {
  const metadata = { weight_percent: 95, confirmed_by_person: false, confirmation_status: 'agent_confirmed',
    confirmation_basis: { confirmed_by: { kind: 'agent', agent_id: 'synthetic-reviewer' } } };
  const app = { config: { personal: { spaceId: 'space' } }, consoleUrl: 'http://console.invalid',
    personal: { search: async () => ({ facts: [{ id: 'fact', fact: 'Synthetic fact', score: 1, ...metadata }],
      entities: [{ id: 'entity', name: 'Synthetic entity', score: 1, ...metadata }] }) } };
  const input = { personalSpaceId: 'space', query: 'Synthetic', agentInvocation: true };
  const ports = { workspaceFor: () => { throw new Error('Unexpected workspace'); }, recordAgentViews: async () => {} };
  const agent = await searchFederatedKnowledge(app, input, ports);
  const consoleView = await searchFederatedKnowledge(app, { ...input, agentInvocation: false }, ports);
  for (const key of ['facts', 'entities']) {
    assert.equal(Object.hasOwn(agent[key][0], 'weight_percent'), false);
    assert.equal(Object.hasOwn(agent[key][0], 'confirmed_by_person'), false);
    assert.deepEqual(agent[key][0].confirmation_basis, metadata.confirmation_basis);
    assert.equal(agent[key][0].confirmation_status, 'agent_confirmed');
    assert.equal(consoleView[key][0].weight_percent, 95);
    assert.equal(consoleView[key][0].confirmed_by_person, false);
  }
});

test('conflicting preferences from equally near parents stay deferred regardless of weight',
  async () => {
    const preferences = [
      inheritedPreference({
        id: 'parent-a-tone',
        projectId: 'platform-a',
        instruction: '使用正式语气。',
        weight: 0.95,
        path: ['travel-d', 'platform-a']
      }),
      inheritedPreference({
        id: 'parent-b-tone',
        projectId: 'platform-b',
        instruction: '使用轻松语气。',
        weight: 0.2,
        path: ['travel-d', 'platform-b']
      })
    ];
    const app = testApplication(async (pathname) => {
      if (pathname === '/v1/collaboration-preferences') {
        return {
          personal_space_id: 'personal-1',
          personal_project_id: 'travel-d',
          global_preferences: [],
          project_preferences: preferences,
          effective_preferences: [],
          conflicts: [{
            preference_key: 'shared-tone',
            preference_scope: 'project',
            preference_project_id: 'platform-a',
            item_ids: ['parent-a-tone', 'parent-b-tone']
          }],
          overridden_global_ids: [],
          overridden_inherited_ids: [],
          truncated: false
        };
      }
      if (pathname === '/v1/preference-conflicts') return [];
      if (pathname === '/v1/knowledge/agent-views') {
        return { recorded_count: 2, item_keys: [] };
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });

    const result = await app.getCollaborationPreferences({
      personalProjectId: 'travel-d',
      agentInvocation: true
    });

    assert.deepEqual(result.effective_preferences, []);
    assert.equal(result.deferred_conflicts.length, 1);
    assert.equal(
      result.deferred_conflicts[0].status,
      'human_scope_judgment_required'
    );
    assert.deepEqual(
      result.deferred_conflicts[0].preference_project_ids,
      ['platform-a', 'platform-b']
    );
    assert.deepEqual(
      result.deferred_conflicts[0].alternatives.map(({ weight }) => weight),
      [0.95, 0.2]
    );
    assert.equal(result.deferred_conflicts[0].automatic_resolution, false);
    assert.match(result.deferred_conflicts[0].required_action, /human/i);
  });

function inheritedPreference({ id, projectId, instruction, weight, path }) {
  return {
    id,
    item_kind: 'entity',
    key: 'shared-tone',
    preference_key: 'shared-tone',
    title: `${projectId} tone`,
    instruction,
    profile_aspect: 'judgment_preference',
    preference_scope: 'project',
    preference_project_id: projectId,
    confirmation_status: 'confirmed',
    attributes: { weight },
    weight,
    reason: `${projectId} confirmed this preference.`,
    inherited_from_project_id: projectId,
    scope_distance: 1,
    scope_path: path
  };
}

function testApplication(resolveBody) {
  return new FederatedGraphApplication({
    personal: {
      providerUrl: 'http://personal.invalid',
      accessToken: 'test-access',
      principalId: 'principal-1',
      spaceId: 'personal-1'
    },
    workspaces: []
  }, {
    fetchImpl: async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      const body = await resolveBody(
        pathname,
        options.body ? JSON.parse(options.body) : null
      );
      return response(body);
    }
  });
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
