import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';

// 11-11: FULI no longer applies personal-global decisions, but a decision
// stored by an earlier version still suppresses its exact candidate.
test('a stored exact-version rejection suppresses discovery through structured Provider status',
  async () => {
    const sourceItems = fixtureSourceRefs();
    const candidateId = personalGlobalCandidateId(sourceItems.map(({ itemId }) => itemId));
    const candidateVersion = fixtureCandidateVersion(sourceItems);
    const requests = [];
    const state = { decision: decisionRecord(candidateId, {
      candidate_version: candidateVersion,
      decision_revision: 0,
      decision: 'reject',
      target_scope: 'personal_global',
      target_project_id: null,
      confirmed_at: '2026-08-03T12:30:00.000Z',
      human_confirmation_reason: '用户判断这只是两个项目的局部巧合，不应成为全局偏好。'
    }) };
    const app = decisionAndDiscoveryApplication(requests, state);

    const result = await app.discoverPersonalGlobalPreferenceCandidates({
      personalSpaceId: 'personal-1',
      personalProjectIds: ['travel-d', 'preference-e'],
      query: '注释 写清楚 功能',
      minProjects: 2,
      similarityThreshold: 0.2,
      limitPerProject: 8
    });

    assert.equal(result.status, 'candidates_suppressed');
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.suppressed_candidates, [{
      candidate_id: candidateId,
      candidate_version: candidateVersion,
      decision: 'rejected',
      decision_event_id: `decision-${candidateId}`,
      decision_revision: 1,
      target_scope: 'personal_global',
      target_project_id: null,
      global_assertion_id: null,
      global_assertion_active: false
    }]);
    assert.equal(
      requests.some(({ path }) => path === '/v1/search' &&
        !requests.find(({ body }) => body?.active_personal_project_id)),
      false
    );
  });

function decisionAndDiscoveryApplication(requests, state) {
  const summaries = {
    'travel-d': '这个项目由 AI 开发时，注释要写清楚功能。',
    'preference-e': '这个项目由 AI 开发时，注释要用中文写清楚功能。'
  };
  return applicationWithFetch(async (parsed, body) => {
    requests.push({ path: parsed.pathname, body });
    if (parsed.pathname === '/v1/personal-projects') {
      return response(Object.keys(summaries).map((projectId) => ({ project_id: projectId })));
    }
    if (parsed.pathname === '/v1/search') {
      const projectId = body.active_personal_project_id;
      return response({
        facts: [],
        entities: [preferenceSearchItem(projectId, summaries[projectId])]
      });
    }
    if (parsed.pathname.endsWith('/scope-options')) {
      return response({
        personal_space_id: 'personal-1',
        candidate_id: parsed.pathname.split('/').at(-2),
        candidate_version: fixtureCandidateVersion(fixtureSourceRefs()),
        preference_key: body.preference_key,
        source_snapshots: fixtureSnapshots(),
        eligible_target_scopes: globalTargetScopes()
      });
    }
    if (parsed.pathname ===
      '/v1/personal-global-preference-candidates/decision-status') {
      const requested = body.candidates[0];
      const exact = state.decision?.candidate_version === requested.candidate_version;
      return response({
        personal_space_id: 'personal-1',
        decisions: exact ? [state.decision] : [],
        revisions: [{
          candidate_id: requested.candidate_id,
          decision_revision: state.decision?.decision_revision ?? 0,
          current_candidate_version: state.decision?.candidate_version ?? null
        }]
      });
    }
    throw new Error(`Unexpected request: ${parsed.pathname}`);
  });
}

function applicationWithFetch(route) {
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
      const parsed = new URL(url);
      const body = options.body ? JSON.parse(options.body) : null;
      return route(parsed, body);
    }
  });
}

function decisionRecord(candidateId, body) {
  return {
    decision_event_id: `decision-${candidateId}`,
    candidate_id: candidateId,
    candidate_version: body.candidate_version,
    decision_revision: body.decision_revision + 1,
    decision: body.decision === 'approve' ? 'approved' : 'rejected',
    target_scope: body.target_scope,
    target_project_id: body.target_project_id ?? null,
    global_assertion_id: body.decision === 'approve' ? `global-${candidateId}` : null,
    global_assertion_active: body.decision === 'approve',
    decision_sequence: body.decision_revision + 1,
    decided_at: body.confirmed_at,
    human_confirmation_reason: body.human_confirmation_reason
  };
}

function fixtureSourceRefs() {
  return [
    { itemId: 'preference-travel-d', itemKind: 'entity', projectId: 'travel-d' },
    { itemId: 'preference-preference-e', itemKind: 'entity', projectId: 'preference-e' }
  ];
}

function fixtureSnapshots() {
  return fixtureSourceRefs().map(({ itemId, itemKind, projectId }) => ({
    item_id: itemId,
    item_kind: itemKind,
    project_id: projectId,
    key: `alignment:network:preference:${projectId}`,
    preference_key: 'alignment.comments.explain-function',
    preference_qualifiers: { audience: 'project contributors' },
    title: `${projectId} 注释偏好`,
    instruction: projectId === 'preference-e'
      ? '这个项目由 AI 开发时，注释要用中文写清楚功能。'
      : '这个项目由 AI 开发时，注释要写清楚功能。',
    profile_aspect: 'judgment_preference',
    confirmation_status: 'confirmed',
    confirmation_basis: {
      existence_reason: '用户明确表达。',
      quadrant_reason: '偏好直接确认。',
      proposed_by: { kind: 'user', label: '用户' },
      confirmed_by: { kind: 'user', label: '用户' },
      confirmed_at: '2026-08-03T00:00:00.000Z'
    },
    human_change_version: 0,
    usage_generation: 1,
    last_human_changed_at: null,
    negative_evidence_count: 0,
    requires_attention: false,
    last_feedback_at: null,
    source_uris: [`https://fixtures.invalid/${projectId}/preference`]
  }));
}

function preferenceSearchItem(projectId, summary) {
  return {
    id: `preference-${projectId}`,
    space_id: 'personal-1',
    group_id: 'personal-group',
    name: `${projectId} 注释偏好`,
    type: 'PersonalPreference',
    summary,
    confirmation_status: 'confirmed',
    profile_aspect: 'judgment_preference',
    preference_scope: 'project',
    preference_project_id: projectId,
    defined_project_id: projectId,
    key: `alignment:network:preference:${projectId}`,
    preference_key: 'alignment.comments.explain-function',
    preference_qualifiers: { audience: 'project contributors' },
    source_uris: [`https://fixtures.invalid/${projectId}/preference`]
  };
}

function personalGlobalCandidateId(itemIds) {
  return `personal-global-${createHash('sha256')
    .update([...itemIds].sort().join('\n'))
    .digest('hex')
    .slice(0, 20)}`;
}

function fixtureCandidateVersion(sourceItems) {
  const sourceState = sourceItems.map(({ itemId, itemKind, projectId }) => ({
    item_id: itemId,
    item_kind: itemKind,
    project_id: projectId,
    preference_key: 'alignment.comments.explain-function',
    preference_qualifiers: { audience: 'project contributors' },
    instruction: projectId === 'preference-e'
      ? '这个项目由 AI 开发时，注释要用中文写清楚功能。'
      : '这个项目由 AI 开发时，注释要写清楚功能。',
    profile_aspect: 'judgment_preference',
    confirmation_status: 'confirmed',
    human_change_version: 0,
    usage_generation: 1,
    last_human_changed_at: null,
    negative_evidence_count: 0,
    requires_attention: false,
    last_feedback_at: null,
    source_uris: [`https://fixtures.invalid/${projectId}/preference`]
  })).sort((left, right) => left.item_id.localeCompare(right.item_id));
  const state = {
    eligible_target_scopes: globalTargetScopes(),
    sources: sourceState
  };
  return `v1:${createHash('sha256')
    .update(stableJsonStringify(state))
    .digest('hex')
    .slice(0, 24)}`;
}

function globalTargetScopes() {
  return [{
    target_scope: 'personal_global',
    target_project_id: null,
    max_distance: null
  }];
}

function stableJsonStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
