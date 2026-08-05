import assert from 'node:assert/strict';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';

test('MOCK personal-global candidates preserve qualifiers and expose global-only choice',
  async () => {
    const requests = [];
    const summaries = {
      'travel-d': '这个项目由 AI 开发时，注释要写清楚功能。',
      'preference-e': '这个项目由 AI 开发时，注释要用中文写清楚功能。',
      'unrelated-f': 'AI 开发这个项目时，注释必须写清楚功能。'
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
        requests.push({
          path: parsed.pathname,
          method: options.method ?? 'GET',
          body
        });
        if (parsed.pathname === '/v1/personal-projects') {
          return response(Object.keys(summaries).map((projectId) => ({
            project_id: projectId
          })));
        }
        if (parsed.pathname === '/v1/search') {
          const projectId = body.active_personal_project_id;
          return response({
            facts: [],
            entities: [{
              id: `preference-${projectId}`,
              space_id: 'personal-1',
              group_id: 'personal-group',
              name: `${projectId} 注释偏好`,
              type: 'PersonalPreference',
              summary: summaries[projectId],
              confirmation_status: 'confirmed',
              profile_aspect: 'judgment_preference',
              preference_scope: 'project',
              preference_project_id: projectId,
              defined_project_id: projectId,
              key: `alignment:network:preference:${projectId}`,
              preference_key: 'alignment.comments.explain-function',
              source_uris: [`https://fixtures.invalid/${projectId}/preference`]
            }]
          });
        }
        if (parsed.pathname ===
          '/v1/personal-global-preference-candidates/decision-status') {
          return response({
            personal_space_id: 'personal-1',
            decisions: [],
            revisions: body.candidates.map((candidate) => ({
              candidate_id: candidate.candidate_id,
              decision_revision: 2,
              current_candidate_version: 'v1:000000000000000000000000'
            }))
          });
        }
        if (parsed.pathname.endsWith('/scope-options')) {
          return response({
            personal_space_id: 'personal-1',
            candidate_id: parsed.pathname.split('/').at(-2),
            candidate_version: `v1:${'1'.repeat(24)}`,
            preference_key: body.preference_key,
            source_snapshots: [],
            eligible_target_scopes: [{
              target_scope: 'personal_global',
              target_project_id: null,
              max_distance: null
            }]
          });
        }
        throw new Error(`Unexpected request: ${parsed.pathname}`);
      }
    });

    const result = await app.discoverPersonalGlobalPreferenceCandidates({
      personalSpaceId: 'personal-1',
      personalProjectIds: ['travel-d', 'preference-e', 'unrelated-f'],
      query: '注释 写清楚 功能',
      minProjects: 3,
      similarityThreshold: 0.2,
      limitPerProject: 8
    });

    assert.equal(result.status, 'candidates_found');
    assert.equal(result.target_scope, 'human_selected');
    assert.equal(result.candidates.length, 1);
    const candidate = result.candidates[0];
    assert.match(candidate.candidate_version, /^v1:[a-f0-9]{24}$/);
    assert.deepEqual(candidate.source_project_ids, [
      'preference-e',
      'travel-d',
      'unrelated-f'
    ]);
    assert.equal(candidate.source_items.length, 3);
    const eSource = candidate.source_items.find(
      ({ defined_project_id: projectId }) => projectId === 'preference-e'
    );
    assert.match(eSource.summary, /中文/);
    assert.deepEqual(eSource.source_uris, [
      'https://fixtures.invalid/preference-e/preference'
    ]);
    assert.equal(candidate.derived_common_core.authoritative, false);
    assert.equal(
      candidate.derived_common_core.terms.some((term) => term.includes('中文')),
      false
    );
    assert.equal(candidate.requires_human_scope_judgment, true);
    assert.equal(candidate.scope_apply_performed, false);
    assert.deepEqual(candidate.eligible_target_scopes, [{
      target_scope: 'personal_global',
      target_project_id: null,
      max_distance: null
    }]);
    assert.equal(candidate.decision_revision, 2);
    assert.equal(candidate.prior_decision_source_drift, true);
    assert.equal(
      candidate.prior_decision_candidate_version,
      'v1:000000000000000000000000'
    );
    assert.equal(candidate.candidate_score, candidate.ranking.score);
    assert.deepEqual(Object.keys(candidate.ranking.signals), [
      'distinct_projects',
      'lexical_similarity',
      'confirmation_authority',
      'recency',
      'negative_evidence'
    ]);
    assert.equal(
      candidate.ranking.policy,
      'ranking_only_never_changes_scope_or_confirmation_authority'
    );
    assert.deepEqual(result.policy, {
      read_only: true,
      exact_projects_only: true,
      inherited_knowledge_excluded: true,
      personal_global_excluded: true,
      original_text_and_sources_preserved: true,
      derived_core_is_non_authoritative: true,
      human_scope_judgment_required: true,
      automatic_scope_apply: false,
      ranking_scores_are_non_authoritative: true,
      stale_decisions_do_not_suppress_changed_candidates: true
    });
    assert.equal(
      requests.filter(({ path, body }) =>
        path === '/v1/search' && body.active_personal_project_id
      ).every(({ body }) =>
        body.inherit_project_knowledge === false
        && body.include_personal_global === false
      ),
      true
    );
    const decisionRead = requests.find(({ path }) =>
      path === '/v1/personal-global-preference-candidates/decision-status'
    );
    assert.equal(decisionRead.body.candidates.length, 1);
    assert.equal(
      requests.every(({ method }) => method === 'GET' || method === 'POST'),
      true
    );
    assert.equal(
      requests.some(({ path }) =>
        /preference-scope|promotion|commit/.test(path)
      ),
      false
    );
    assert.equal(requests.filter(({ path }) =>
      path.endsWith('/scope-options')
    ).length, 1);
  });

test('MOCK D and E candidate exposes human-authorized parent A plus global', async () => {
  const app = candidateApp({
    'project-d': preferenceItem('project-d', 'shared.key', 'alpha beta'),
    'project-e': preferenceItem('project-e', 'shared.key', 'alpha beta')
  }, {
    eligibleTargetScopes: [
      {
        target_scope: 'parent_project',
        target_project_id: 'project-a',
        max_distance: 1
      },
      {
        target_scope: 'personal_global',
        target_project_id: null,
        max_distance: null
      }
    ]
  });

  const result = await app.discoverPersonalGlobalPreferenceCandidates({
    personalSpaceId: 'personal-1',
    personalProjectIds: ['project-d', 'project-e'],
    query: 'alpha beta',
    minProjects: 2,
    similarityThreshold: 0.9,
    limitPerProject: 8
  });

  assert.equal(result.status, 'candidates_found');
  assert.deepEqual(result.candidates[0].eligible_target_scopes, [
    {
      target_scope: 'parent_project',
      target_project_id: 'project-a',
      max_distance: 1
    },
    {
      target_scope: 'personal_global',
      target_project_id: null,
      max_distance: null
    }
  ]);
});

test('similar text with different stable preference keys never converges', async () => {
  const app = candidateApp({
    'project-a': preferenceItem('project-a', 'comments.language', '注释要写清楚功能。'),
    'project-b': preferenceItem('project-b', 'comments.detail', '注释要写清楚功能。')
  });

  const result = await app.discoverPersonalGlobalPreferenceCandidates({
    personalSpaceId: 'personal-1',
    personalProjectIds: ['project-a', 'project-b'],
    query: '注释 写清楚 功能',
    minProjects: 2,
    similarityThreshold: 0.2,
    limitPerProject: 8
  });

  assert.equal(result.status, 'no_candidates');
  assert.deepEqual(result.candidates, []);
});

test('a lexical bridge cannot bypass the all-pairs similarity threshold', async () => {
  const app = candidateApp({
    'project-a': preferenceItem('project-a', 'shared.key', 'alpha beta'),
    'project-b': preferenceItem('project-b', 'shared.key', 'alpha beta gamma delta'),
    'project-c': preferenceItem('project-c', 'shared.key', 'gamma delta')
  });

  const result = await app.discoverPersonalGlobalPreferenceCandidates({
    personalSpaceId: 'personal-1',
    personalProjectIds: ['project-a', 'project-b', 'project-c'],
    query: 'preference',
    minProjects: 3,
    similarityThreshold: 0.6,
    limitPerProject: 8
  });

  assert.equal(result.status, 'no_candidates');
  assert.deepEqual(result.candidates, []);
});

function candidateApp(itemsByProject, {
  eligibleTargetScopes = []
} = {}) {
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
      if (parsed.pathname === '/v1/personal-projects') {
        return response(Object.keys(itemsByProject).map((projectId) => ({
          project_id: projectId
        })));
      }
      if (parsed.pathname === '/v1/search') {
        return response({
          facts: [],
          entities: [itemsByProject[body.active_personal_project_id]]
        });
      }
      if (parsed.pathname.endsWith('/scope-options')) {
        return response({
          personal_space_id: 'personal-1',
          candidate_id: parsed.pathname.split('/').at(-2),
          candidate_version: `v1:${'2'.repeat(24)}`,
          preference_key: body.preference_key,
          source_snapshots: [],
          eligible_target_scopes: eligibleTargetScopes
        });
      }
      if (parsed.pathname ===
        '/v1/personal-global-preference-candidates/decision-status') {
        return response({
          personal_space_id: 'personal-1',
          decisions: [],
          revisions: body.candidates.map(({ candidate_id: candidateId }) => ({
            candidate_id: candidateId,
            decision_revision: 0,
            current_candidate_version: null
          }))
        });
      }
      throw new Error(`Unexpected request: ${parsed.pathname}`);
    }
  });
}

function preferenceItem(projectId, preferenceKey, summary) {
  return {
    id: `preference-${projectId}`,
    space_id: 'personal-1',
    group_id: 'personal-group',
    name: 'Preference',
    type: 'PersonalPreference',
    summary,
    confirmation_status: 'confirmed',
    profile_aspect: 'judgment_preference',
    preference_scope: 'project',
    preference_project_id: projectId,
    defined_project_id: projectId,
    key: `alignment:network:preference:${projectId}`,
    preference_key: preferenceKey,
    source_uris: [`https://fixtures.invalid/${projectId}/preference`]
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
