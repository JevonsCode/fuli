import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';

test('preview is proposal-only and approved apply uses the Provider decision state',
  async () => {
    const sourceItems = fixtureSourceRefs();
    const candidateId = personalGlobalCandidateId(sourceItems.map(({ itemId }) => itemId));
    const candidateVersion = fixtureCandidateVersion(sourceItems);
    const requests = [];
    const app = decisionApplication(requests);
    const input = {
      personalSpaceId: 'personal-1',
      candidateId,
      candidateVersion,
      decisionRevision: 0,
      decision: 'approve',
      sourceItems,
      preferenceKey: 'alignment.comments.explain-function',
      targetScope: 'parent_project',
      targetProjectId: 'parent-a',
      profileAspect: 'judgment_preference',
      globalTitle: '注释写清楚功能',
      globalInstruction: '由 AI 开发时，注释要写清楚功能。',
      humanConfirmationReason: '用户确认共同核心适用于个人全局，但中文仍只属于 E。',
      confirmedAt: '2026-08-03T12:00:00.000Z',
      sessionId: 'scope-review-1',
      idempotencyKey: 'personal-global-approve-scope-review-1'
    };

    const preview = await app.previewPersonalGlobalPreferenceDecision(input);

    assert.equal(preview.status, 'human_review_required');
    assert.equal(preview.scope_apply_performed, false);
    assert.equal(preview.approval_token_issued, false);
    assert.equal(preview.original_sources_will_remain_unchanged, true);
    assert.match(
      preview.source_snapshots.find(({ project_id: id }) => id === 'preference-e')
        .instruction,
      /中文/
    );
    assert.equal(requests.some(({ path }) => path === '/v1/knowledge/commits'), false);

    const applied = await app.applyPersonalGlobalPreferenceDecision({
      ...input,
      previewToken: 'human-issued-one-time-token-value-1234567890'
    });

    assert.equal(applied.decision, 'approved');
    assert.equal(applied.global_assertion_active, true);
    const applyRequest = requests.find(({ path }) =>
      path.endsWith('/decision')
    );
    assert.equal(applyRequest.body.candidate_version, candidateVersion);
    assert.equal(applyRequest.body.decision_revision, 0);
    assert.equal(applyRequest.body.target_scope, 'parent_project');
    assert.equal(applyRequest.body.target_project_id, 'parent-a');
    assert.equal(applyRequest.body.approval_token,
      'human-issued-one-time-token-value-1234567890');
    assert.equal(applyRequest.body.global_instruction,
      '由 AI 开发时，注释要写清楚功能。');
    assert.equal(applyRequest.body.source_items.length, 2);
    assert.equal(
      requests.some(({ path }) => /knowledge\/commits|preference-scope/.test(path)),
      false
    );
  });

test('exact-version rejection suppresses discovery through structured Provider status',
  async () => {
    const sourceItems = fixtureSourceRefs();
    const candidateId = personalGlobalCandidateId(sourceItems.map(({ itemId }) => itemId));
    const candidateVersion = fixtureCandidateVersion(sourceItems);
    const requests = [];
    const state = { decision: null };
    const app = decisionAndDiscoveryApplication(requests, state);

    const applied = await app.applyPersonalGlobalPreferenceDecision({
      personalSpaceId: 'personal-1',
      candidateId,
      candidateVersion,
      decisionRevision: 0,
      decision: 'reject',
      sourceItems,
      preferenceKey: 'alignment.comments.explain-function',
      targetScope: 'personal_global',
      targetProjectId: null,
      humanConfirmationReason: '用户判断这只是两个项目的局部巧合，不应成为全局偏好。',
      confirmedAt: '2026-08-03T12:30:00.000Z',
      sessionId: 'scope-review-2',
      idempotencyKey: 'personal-global-reject-scope-review-2',
      previewToken: 'human-issued-one-time-token-value-abcdefghij'
    });

    assert.equal(applied.decision, 'rejected');
    assert.equal(applied.global_assertion_active, false);

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

function decisionApplication(requests) {
  return applicationWithFetch(async (parsed, body) => {
    requests.push({ path: parsed.pathname, body });
    if (parsed.pathname.endsWith('/decision-inspection')) {
      return response({
        status: 'human_review_required',
        personal_space_id: 'personal-1',
        candidate_id: parsed.pathname.split('/').at(-2),
        candidate_version: body.candidate_version,
        decision_revision: body.decision_revision,
        decision: body.decision,
        preference_key: body.preference_key,
        target_scope: body.target_scope,
        target_project_id: body.target_project_id,
        eligible_target_scopes: [{
          target_scope: body.target_scope,
          target_project_id: body.target_project_id,
          max_distance: body.target_scope === 'parent_project' ? 1 : null
        }],
        payload_fingerprint: 'f'.repeat(64),
        source_snapshots: fixtureSnapshots(),
        candidate_binding_verified: true,
        original_sources_will_remain_unchanged: true,
        scope_apply_performed: false,
        approval_token_issued: false,
        required_action: 'Independent human review required.'
      });
    }
    if (parsed.pathname.endsWith('/decision')) {
      return response(decisionRecord(parsed.pathname.split('/').at(-2), body));
    }
    throw new Error(`Unexpected request: ${parsed.pathname}`);
  });
}

function decisionAndDiscoveryApplication(requests, state) {
  const summaries = {
    'travel-d': '这个项目由 AI 开发时，注释要写清楚功能。',
    'preference-e': '这个项目由 AI 开发时，注释要用中文写清楚功能。'
  };
  return applicationWithFetch(async (parsed, body) => {
    requests.push({ path: parsed.pathname, body });
    if (parsed.pathname.endsWith('/decision')) {
      state.decision = decisionRecord(parsed.pathname.split('/').at(-2), body);
      return response(state.decision);
    }
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
