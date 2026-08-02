import assert from 'node:assert/strict';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { CapturePolicyStore } from '../src/graphiti/capture-policy.js';

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

test('federated app can extend Provider request timeouts for isolated ingestion', () => {
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: providerFetch([], {}),
    providerRequestTimeoutMs: 120_000
  });

  assert.equal(app.personal.requestTimeoutMs, 120_000);
  assert.equal(
    [...app.workspaces.values()][0].client.requestTimeoutMs,
    120_000
  );
});

test('silent capture commits personal knowledge directly', async () => {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: providerFetch(calls, {
      '/v1/knowledge/commits': { status: 'committed', episode_id: 'episode-1' }
    })
  });
  const result = await app.captureSessionKnowledge(episodeInput('personal'));
  assert.equal(result.route, 'personal');
  const request = calls.find(({ path }) => path === '/v1/knowledge/commits');
  assert.equal(request.body.space_id, 'personal-space');
  assert.equal(request.body.episode.entities[0].type, 'Preference');
});

test('disabled capture policy skips every Provider write without rejecting the Agent call', async () => {
  const calls = [];
  const capturePolicyStore = new CapturePolicyStore();
  capturePolicyStore.update({ enabled: false });
  const app = new FederatedGraphApplication(CONFIG, {
    capturePolicyStore,
    fetchImpl: providerFetch(calls, {})
  });

  const result = await app.captureSessionKnowledge(episodeInput('personal'));

  assert.equal(result.route, 'disabled');
  assert.equal(result.status, 'capture_disabled');
  assert.equal(result.capturePolicy.enabled, false);
  assert.deepEqual(calls, []);
});

test('personal project capture and graph reads keep an exact local project boundary', async () => {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: providerFetch(calls, {
      '/v1/knowledge/commits': { status: 'committed', episode_id: 'episode-1' },
      '/v1/spaces/personal-space/graph': { space_id: 'personal-space', nodes: [], edges: [] }
    })
  });

  await app.captureSessionKnowledge({
    ...episodeInput('personal'),
    personalProjectId: 'fuli'
  });
  await app.getKnowledgeGraph({
    spaceId: 'personal-space',
    personalProjectId: 'fuli'
  });

  const commit = calls.find(({ path }) => path === '/v1/knowledge/commits');
  const graph = calls.find(({ path }) => path === '/v1/spaces/personal-space/graph');
  assert.equal(commit.body.personal_project_id, 'fuli');
  assert.equal(graph.query.personal_project_id, 'fuli');
});

test('silent project capture creates a local pre-review draft before any public submission', async () => {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: providerFetch(calls, {
      '/v1/publication-drafts': {
        id: 'draft-1', status: 'pending'
      }
    })
  });
  const input = { ...episodeInput('project'), spaceId: 'project-1' };
  const result = await app.captureSessionKnowledge(input);
  assert.deepEqual(result, {
    route: 'personal_review',
    status: 'pending',
    draftId: 'draft-1',
    projectId: 'project-1',
    providerUrl: 'https://workspace.example'
  });
  assert.equal(calls.some(({ path }) => path === '/v1/knowledge/commits'), false);
  assert.equal(calls.some(({ origin }) => origin === 'https://workspace.example'), false);
});

test('restricted knowledge cannot be submitted to a team-shared queue', async () => {
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: providerFetch([], {})
  });
  await assert.rejects(
    app.captureSessionKnowledge({
      ...episodeInput('project'),
      spaceId: 'project-1',
      sensitivity: 'restricted'
    }),
    /cannot enter a team-shared project queue/
  );
});

test('confirmation preserves the discovery-time quadrant and its audit basis', async () => {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: providerFetch(calls, {
      '/v1/knowledge/commits': { status: 'committed', episode_id: 'episode-profile' }
    })
  });
  const input = episodeInput('personal');
  input.entities[0] = {
    ...input.entities[0],
    originQuadrant: 'unknown_known',
    confirmationBasis: {
      ...input.entities[0].confirmationBasis,
      quadrantReason: 'The preference was inferred from prototype comparisons.'
    },
    reasoningSummary: 'The user recognized the preference after comparing prototypes.',
    profileAspect: 'taste'
  };

  await app.captureSessionKnowledge(input);

  const stored = calls[0].body.episode.entities[0];
  assert.equal(stored.origin_quadrant, 'unknown_known');
  assert.equal(stored.confirmation_status, 'confirmed');
  assert.equal(stored.confirmation_basis.quadrant_reason,
    'The preference was inferred from prototype comparisons.');
  assert.equal(stored.profile_aspect, 'taste');
});

test('personal profile knowledge can be project-scoped locally but never proposed publicly', async () => {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: providerFetch(calls, {
      '/v1/knowledge/commits': { status: 'committed', episode_id: 'episode-profile' }
    })
  });
  const profileInput = episodeInput('personal');
  profileInput.personalProjectId = 'fuli';
  profileInput.entities[0] = {
    ...profileInput.entities[0],
    originQuadrant: 'known_known',
    profileAspect: 'judgment_preference'
  };
  await app.captureSessionKnowledge(profileInput);
  assert.equal(calls[0].body.personal_project_id, 'fuli');

  const publicInput = { ...profileInput, targetKind: 'project', spaceId: 'project-1' };
  delete publicInput.personalProjectId;
  await assert.rejects(
    app.captureSessionKnowledge(publicInput),
    /auditable confirmation/
  );
  assert.equal(calls.some(({ origin }) => origin === 'https://workspace.example'), false);
});

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
    const app = new FederatedGraphApplication(CONFIG, {
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
          overridden_global_ids: [],
          truncated: false
        },
        '/v1/preference-conflicts': [{
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

test(
  'capture preserves source URI, application, turn, and the bounded relevant excerpt',
  async () => {
    const calls = [];
    const app = new FederatedGraphApplication(CONFIG, {
      fetchImpl: providerFetch(calls, {
        '/v1/knowledge/commits': { status: 'committed', episode_id: 'episode-source' }
      })
    });

    await app.captureSessionKnowledge({
      ...episodeInput('personal'),
      sourceUri: 'https://docs.example.invalid/product/requirements?view=latest#scope',
      sourceApplication: 'codex',
      sourceTurnId: 'turn-7',
      sourceExcerpt: '用户明确要求默认全局生效，也可以限制到一个项目。'
    });

    assert.equal(
      calls[0].body.episode.source_uri,
      'https://docs.example.invalid/product/requirements?view=latest#scope'
    );
    assert.equal(calls[0].body.episode.source_application, 'codex');
    assert.equal(calls[0].body.episode.source_turn_id, 'turn-7');
    assert.match(calls[0].body.episode.source_excerpt, /默认全局/);
  }
);

test('source URI must be an absolute HTTP(S) link without embedded credentials', async () => {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: providerFetch(calls, {})
  });

  await assert.rejects(
    app.captureSessionKnowledge({
      ...episodeInput('personal'),
      sourceUri: 'ftp://docs.example.invalid/requirements'
    }),
    /absolute HTTP\(S\) URI/
  );
  await assert.rejects(
    app.captureSessionKnowledge({
      ...episodeInput('personal'),
      sourceUri: 'https://sample-user@docs.example.invalid/requirements'
    }),
    /absolute HTTP\(S\) URI/
  );
  assert.deepEqual(calls, []);
});

test('pending knowledge stays outside public review regardless of its quadrant', async () => {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, { fetchImpl: providerFetch(calls, {}) });
  const input = { ...episodeInput('project'), spaceId: 'project-1' };
  input.entities[0] = {
    ...input.entities[0],
    originQuadrant: 'known_unknown',
    confirmationStatus: 'pending',
    confirmationBasis: {
      existenceReason: 'The architecture tradeoff was raised for review.',
      quadrantReason: 'The question is explicit but remains unresolved.',
      proposedBy: { kind: 'agent', label: 'Codex' },
      confirmedBy: null,
      confirmedAt: null
    },
    reasoningSummary: 'The architecture tradeoff is not resolved.'
  };
  await assert.rejects(
    app.captureSessionKnowledge(input),
    /auditable confirmation/
  );
  assert.deepEqual(calls, []);
});

test('credentials are rejected before either provider receives them', async () => {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: providerFetch(calls, {})
  });
  await assert.rejects(
    app.captureSessionKnowledge({
      ...episodeInput('personal'),
      summary: 'api_key=sk-live-12345678901234567890'
    }),
    /contains credentials/
  );
  await assert.rejects(
    app.captureSessionKnowledge({
      ...episodeInput('personal'),
      sourceUri: `https://docs.example.invalid/prd?access_token=${'x'.repeat(20)}`
    }),
    /contains credentials/
  );
  assert.deepEqual(calls, []);
});

test('federated search reads only explicitly selected subscriptions', async () => {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: providerFetch(calls, {
      '/v1/subscriptions': [
        { project_id: 'project-1', provider_url: 'https://workspace.example' },
        { project_id: 'project-2', provider_url: 'https://workspace.example' }
      ],
      '/v1/search': { facts: [] }
    })
  });

  const result = await app.searchKnowledge({
    personalSpaceId: 'personal-space',
    query: '结算页为什么这样写',
    projectIds: ['project-1']
  });
  const searches = calls.filter(({ path }) => path === '/v1/search');
  assert.deepEqual(searches.map(({ body }) => body.space_ids), [
    ['personal-space'], ['project-1']
  ]);
  assert.deepEqual(searches[0].body.personal_project_ids, []);
  assert.equal(searches[0].body.include_personal_global, true);
  assert.deepEqual(result.searchedProjectIds, ['project-1']);
  assert.equal(JSON.stringify(searches).includes('project-2'), false);
});

test('Agent search records returned human-edited personal items as viewed', async () => {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: providerFetch(calls, {
      '/v1/subscriptions': [],
      '/v1/search': {
        facts: [{
          id: 'relationship-1',
          source_entity: 'A',
          target_entity: 'B',
          relationship: 'USES',
          fact: 'A uses B',
          source_uris: ['https://docs.example.invalid/project/decision']
        }],
        entities: [{
          id: 'entity-1',
          name: 'A',
          type: 'Decision',
          summary: 'A reviewed decision',
          source_uris: ['https://docs.example.invalid/project/decision']
        }]
      },
      '/v1/knowledge/agent-views': {
        recorded_count: 2,
        item_keys: ['relationship:relationship-1', 'entity:entity-1']
      }
    })
  });

  const result = await app.searchKnowledge({
    personalSpaceId: 'personal-space',
    query: 'A',
    agentInvocation: true,
    agentToolName: 'search_knowledge_graph'
  });

  assert.deepEqual(result.facts[0].source_uris, [
    'https://docs.example.invalid/project/decision'
  ]);
  assert.deepEqual(result.entities[0].source_uris, [
    'https://docs.example.invalid/project/decision'
  ]);
  const audit = calls.find(({ path }) => path === '/v1/knowledge/agent-views');
  assert.equal(audit.body.tool_name, 'search_knowledge_graph');
  assert.deepEqual(audit.body.items, [
    { item_id: 'relationship-1', item_kind: 'relationship' },
    { item_id: 'entity-1', item_kind: 'entity' }
  ]);
});

test('human-change search records a view and maps explicit Agent review checks', async () => {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: providerFetch(calls, {
      '/v1/knowledge/human-changes/search': {
        items: [{
          item_id: 'entity-1',
          item_kind: 'entity',
          human_change_version: 3,
          human_change_status: 'unseen'
        }]
      },
      '/v1/knowledge/agent-views': {
        recorded_count: 1,
        item_keys: ['entity:entity-1']
      },
      '/v1/knowledge/items/entity-1/agent-review': {
        id: 'audit-1',
        action: 'agent_review',
        outcome: 'reviewed'
      }
    })
  });

  await app.searchHumanChanges({
    personalSpaceId: 'personal-space',
    query: '',
    status: 'unseen',
    agentInvocation: true
  });
  await app.reviewHumanChange({
    personalSpaceId: 'personal-space',
    itemKind: 'entity',
    itemId: 'entity-1',
    humanChangeVersion: 3,
    conflictCheck: 'no_conflict',
    classificationCheck: 'reasonable',
    note: 'No conflict and the classification is supported by the current evidence.'
  });

  const search = calls.find(
    ({ path }) => path === '/v1/knowledge/human-changes/search'
  );
  assert.equal(search.body.status, 'unseen');
  const review = calls.find(
    ({ path }) => path === '/v1/knowledge/items/entity-1/agent-review'
  );
  assert.deepEqual(review.body, {
    personal_space_id: 'personal-space',
    item_kind: 'entity',
    human_change_version: 3,
    conflict_check: 'no_conflict',
    classification_check: 'reasonable',
    note: 'No conflict and the classification is supported by the current evidence.'
  });
});

test('unsubscribing removes only the selected local subscription', async () => {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: providerFetch(calls, {
      '/v1/subscriptions/project-1': { project_id: 'project-1', deleted: true }
    })
  });

  const result = await app.unsubscribePublicProject({
    personalSpaceId: 'personal-space',
    projectId: 'project-1',
    providerUrl: 'https://workspace.example'
  });

  assert.equal(result.deleted, true);
  assert.deepEqual(calls.map(({ origin, path, method }) => ({ origin, path, method })), [{
    origin: 'http://127.0.0.1:8787',
    path: '/v1/subscriptions/project-1',
    method: 'DELETE'
  }]);
});

test('personal search combines global profile, active project, and only named context projects',
  async () => {
    const calls = [];
    const app = new FederatedGraphApplication(CONFIG, {
      fetchImpl: providerFetch(calls, {
        '/v1/subscriptions': [],
        '/v1/search': {
          facts: [],
          entities: [{
            id: 'taste-1', name: '统一交互控件', type: 'DesignTaste',
            summary: '不同性质的操作不要混放。', profile_aspect: 'taste'
          }]
        }
      })
    });

    const result = await app.searchKnowledge({
      personalSpaceId: 'personal-space',
      personalProjectId: 'project-a',
      contextPersonalProjectIds: ['project-b', 'project-a'],
      query: '按钮应该怎么设计'
    });

    const search = calls.find(({ path }) => path === '/v1/search');
    assert.deepEqual(search.body.personal_project_ids, ['project-a', 'project-b']);
    assert.equal(search.body.active_personal_project_id, 'project-a');
    assert.equal(search.body.inherit_project_knowledge, true);
    assert.equal(search.body.include_exploratory, true);
    assert.equal(search.body.include_personal_global, true);
    assert.deepEqual(result.searchedPersonalProjectIds, ['project-a', 'project-b']);
    assert.equal(result.personalGlobalIncluded, true);
    assert.equal(result.entities[0].profile_aspect, 'taste');
    assert.equal(result.entities[0].scope, 'personal');
    assert.equal(result.sourceMarker.status, 'matched');
    assert.equal(result.noMatchSourceMarker.status, 'no_match');
    assert.doesNotMatch(result.noMatchSourceMarker.markdown, /<\/?(?:details|summary)>/i);
    assert.deepEqual(result.retrievalGuidance, {
      currentPersonalProjectScope: 'bounded',
      markerToUseIfNoSupportingEvidence: 'noMatchSourceMarker',
      requiredNextActionIfNoSupportingEvidence:
        'ask_user_to_confirm_all_local_and_workspace_search',
      instruction: 'Ask whether to widen this one read-only lookup to all registered local ' +
        'personal projects and, if still unresolved, current repository or workspace files. ' +
        'Exclude public projects and paths outside the current workspace; then stop and wait.',
      expansion: {
        available: true,
        requiresExplicitUserConfirmation: true,
        input: { personalProjectScope: 'all_local_confirmed' },
        readOnly: true,
        oneQueryOnly: true,
        includesPublicProjects: false,
        includesCurrentWorkspaceFiles: true
      }
    });
    assert.match(
      result.sourceMarker.markdown,
      /#\/knowledge\/personal\/personal-space\/entity\/taste-1/
    );
  });

test('confirmed all-local search expands only registered personal projects', async () => {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: providerFetch(calls, {
      '/v1/subscriptions': [
        { project_id: 'team-project', provider_url: 'https://workspace.example' }
      ],
      '/v1/personal-projects': [
        { project_id: 'project-c' },
        { project_id: 'project-a' },
        { project_id: 'project-b' },
        { project_id: 'project-a' }
      ],
      '/v1/search': { facts: [], entities: [] }
    })
  });

  const result = await app.searchKnowledge({
    personalSpaceId: 'personal-space',
    personalProjectId: 'project-a',
    contextPersonalProjectIds: ['project-b'],
    personalProjectScope: 'all_local_confirmed',
    query: '“千人来华”页面的线上地址'
  });

  const searches = calls.filter(({ path }) => path === '/v1/search');
  assert.equal(searches.length, 1);
  assert.deepEqual(searches[0].body.personal_project_ids, [
    'project-c', 'project-a', 'project-b'
  ]);
  assert.equal(searches[0].body.include_personal_global, true);
  assert.equal(searches[0].body.active_personal_project_id, null);
  assert.equal(searches[0].body.inherit_project_knowledge, false);
  assert.deepEqual(result.searchedPersonalProjectIds, [
    'project-c', 'project-a', 'project-b'
  ]);
  assert.equal(result.personalProjectScope, 'all_local_confirmed');
  assert.deepEqual(result.searchedProjectIds, []);
  assert.deepEqual(result.retrievalGuidance, {
      currentPersonalProjectScope: 'all_local_confirmed',
      markerToUseIfNoSupportingEvidence: 'noMatchSourceMarker',
      requiredNextActionIfNoSupportingEvidence:
        'search_current_workspace_files_or_ask_for_safe_root',
      instruction: 'Use read-only local file search in the current repository or explicit ' +
        'workspace root, preserving exact names first. If the working directory is the user ' +
        'home, filesystem root, or otherwise too broad, ask for a safe root. Never search ' +
        'outside that root or inspect credential stores; if no evidence supports the answer, ' +
        'ask for a source clue.',
      workspaceFileSearch: {
        available: true,
        consentSource: 'bounded_expansion_confirmation',
        rootBoundary: 'current_working_directory',
        requiresSafeProjectOrWorkspaceRoot: true,
        forbiddenBroadRoots: ['user_home', 'filesystem_root'],
        readOnly: true,
        includesPublicProjects: false
      }
    });
  assert.equal(calls.some(({ origin }) => origin === 'https://workspace.example'), false);
});

test('confirmed all-local search batches every registered personal project', async () => {
  const calls = [];
  const projectIds = Array.from({ length: 17 }, (_, index) => `project-${index + 1}`);
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: providerFetch(calls, {
      '/v1/subscriptions': [],
      '/v1/personal-projects': projectIds.map((projectId) => ({ project_id: projectId })),
      '/v1/search': { facts: [], entities: [] }
    })
  });

  const result = await app.searchKnowledge({
    personalSpaceId: 'personal-space',
    personalProjectScope: 'all_local_confirmed',
    query: '页面地址'
  });

  const searches = calls.filter(({ path }) => path === '/v1/search');
  assert.deepEqual(
    searches.map(({ body }) => body.personal_project_ids.length),
    [16, 1]
  );
  assert.deepEqual(
    searches.flatMap(({ body }) => body.personal_project_ids),
    projectIds
  );
  assert.deepEqual(
    searches.map(({ body }) => body.include_personal_global),
    [true, false]
  );
  assert.deepEqual(
    searches.map(({ body }) => body.inherit_project_knowledge),
    [false, false]
  );
  assert.deepEqual(result.searchedPersonalProjectIds, projectIds);
});

test('state stays fully usable in personal-only mode without a public Provider', async () => {
  const config = { ...CONFIG, workspaces: [] };
  const app = new FederatedGraphApplication(config, {
    fetchImpl: providerFetch([], {
      '/health': {
        status: 'ready', providerId: 'local-personal', mode: 'personal', storage: 'graphiti-neo4j'
      },
      '/v1/spaces': [
        { id: 'personal-space', name: '我', kind: 'personal' },
        { id: 'acceptance-space', name: '验收隔离空间', kind: 'personal' }
      ],
      '/v1/subscriptions': []
    })
  });

  const state = await app.state();

  assert.equal(state.mode, 'personal_only');
  assert.deepEqual(state.publicProvider, { configured: false, status: 'not_connected' });
  assert.deepEqual(state.capabilities, {
    browsePublicProjects: false,
    publishProject: false,
    submitKnowledge: false,
    subscribeProject: false,
    reviewProposals: false
  });
  assert.deepEqual(state.personalSpaces, [{ id: 'personal-space', name: '我', kind: 'personal' }]);
  assert.deepEqual(state.agentAccessPolicy, { enabled: true, updatedAt: null });
  assert.deepEqual(state.projects, []);
  assert.deepEqual(state.providers.workspaces, []);
});

test('state degrades only public capabilities when a configured Provider is unavailable', async () => {
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: async (rawUrl, options = {}) => {
      const url = new URL(rawUrl);
      if (url.origin === 'https://workspace.example') throw new Error('offline');
      return providerFetch([], {
        '/health': {
          status: 'ready', providerId: 'local-personal', mode: 'personal', storage: 'graphiti-neo4j'
        },
        '/v1/spaces': [{ id: 'personal-space', name: '我', kind: 'personal' }],
        '/v1/subscriptions': [{
          project_id: 'project-1', provider_url: 'https://workspace.example', project_name: '项目一'
        }]
      })(rawUrl, options);
    }
  });

  const state = await app.state();

  assert.equal(state.mode, 'degraded');
  assert.deepEqual(state.publicProvider, { configured: true, status: 'unavailable' });
  assert.equal(state.personalSpaces.length, 1);
  assert.equal(state.subscriptions.length, 1);
  assert.deepEqual(state.projects, []);
  assert.equal(state.providers.workspaces[0].status, 'unavailable');
  assert.equal(state.capabilities.publishProject, false);
  assert.equal(state.capabilities.reviewProposals, false);
});

test('publishing a personal project creates a public project owned by the publisher and subscribes it',
  async () => {
    const calls = [];
    const app = new FederatedGraphApplication(CONFIG, {
      fetchImpl: providerFetch(calls, {
        '/v1/personal-projects/hotel-theme': {
          project_id: 'hotel-theme',
          publication_key: 'publication-key-hotel-theme',
          profile: {
            name: 'Hotel Theme',
            purpose: 'Hotel themed event delivery.',
            lifecycle: 'active',
            sources: [],
            boundaries: [],
            assessment: {
              score: 24,
              label: 'needs_clarification',
              confirmed: [],
              inferred: [],
              missing: ['PRD'],
              dimensions: [],
              analyzed_at: '2026-07-21T10:00:00Z'
            }
          }
        },
        '/v1/spaces': {
          id: 'project-hotel-theme',
          name: 'Hotel Theme',
          kind: 'project',
          visibility: 'public',
          owner_id: 'person-remote',
          role: 'maintainer'
        },
        '/v1/subscriptions': {
          id: 'subscription-1',
          project_id: 'project-hotel-theme',
          provider_url: 'https://workspace.example'
        }
      })
    });

    const result = await app.publishPersonalProject({
      personalSpaceId: 'personal-space',
      providerUrl: 'https://workspace.example',
      localProjectId: 'hotel-theme',
      releaseVersion: 'v1.0.0',
      updateSummary: 'Initial public release.'
    });

    assert.equal(result.project.owner_id, 'person-remote');
    assert.equal(result.project.role, 'maintainer');
    assert.equal(result.subscription.project_id, 'project-hotel-theme');
    const created = calls.find(({ origin, path, method }) =>
      origin === 'https://workspace.example' && path === '/v1/spaces' && method === 'POST'
    );
    assert.deepEqual(created.body, {
      name: 'Hotel Theme',
      kind: 'project',
      description: 'Hotel themed event delivery.',
      publication_key: 'publication-key-hotel-theme',
      profile: {
        name: 'Hotel Theme',
        purpose: 'Hotel themed event delivery.',
        scope: null,
        technical_summary: null,
        lifecycle: 'active',
        sources: [],
        boundaries: [],
        assessment: {
          score: 24,
          label: 'needs_clarification',
          confirmed: [],
          inferred: [],
          dimensions: [],
          analyzed_at: '2026-07-21T10:00:00Z'
        }
      },
      release: {
        version: 'v1.0.0',
        summary: 'Initial public release.'
      }
    });
    const subscribed = calls.find(({ origin, path, method }) =>
      origin === 'http://127.0.0.1:8787' && path === '/v1/subscriptions' && method === 'POST'
    );
    assert.equal(subscribed.body.project_id, 'project-hotel-theme');
  });

test('public release history is read from only the selected Provider', async () => {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: providerFetch(calls, {
      '/v1/projects/project-1/releases': [{
        id: 'release-1', project_id: 'project-1', version: 'v1.0.0',
        summary: 'Initial release', publisher_name: 'Alice',
        published_at: '2026-07-22T08:00:00Z'
      }]
    })
  });

  const result = await app.listProjectReleases({
    projectId: 'project-1',
    providerUrl: 'https://workspace.example'
  });

  assert.equal(result.releases[0].version, 'v1.0.0');
  assert.equal(calls[0].origin, 'https://workspace.example');
});

test('deleting a public project also deactivates the current personal subscription', async () => {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: providerFetch(calls, {
      '/v1/projects/project-1': {
        project_id: 'project-1', project_name: 'Hotel Theme', deleted: true
      },
      '/v1/subscriptions/project-1': { project_id: 'project-1', deleted: true }
    })
  });

  const result = await app.deletePublicProject({
    projectId: 'project-1',
    providerUrl: 'https://workspace.example'
  });

  assert.equal(result.deleted, true);
  assert.equal(calls.some(({ origin, path, method }) =>
    origin === 'https://workspace.example' && path === '/v1/projects/project-1' &&
    method === 'DELETE'
  ), true);
  assert.equal(calls.some(({ origin, path, method }) =>
    origin === 'http://127.0.0.1:8787' && path === '/v1/subscriptions/project-1' &&
    method === 'DELETE'
  ), true);
});

test('agents can record and update an incomplete personal project profile without publishing it',
  async () => {
    const calls = [];
    const record = {
      project_id: 'hotel-theme',
      profile: { name: 'Hotel Theme', lifecycle: 'active', sources: [], boundaries: [] }
    };
    const app = new FederatedGraphApplication(CONFIG, {
      fetchImpl: providerFetch(calls, { '/v1/personal-projects': record })
    });

    const result = await app.upsertPersonalProject({
      personalSpaceId: 'personal-space',
      projectId: 'hotel-theme',
      profile: record.profile
    });

    assert.equal(result.project_id, 'hotel-theme');
    const request = calls.find(({ path, method }) =>
      path === '/v1/personal-projects' && method === 'PUT'
    );
    assert.deepEqual(request.body, {
      personal_space_id: 'personal-space',
      project_id: 'hotel-theme',
      profile: {
        name: 'Hotel Theme',
        purpose: null,
        scope: null,
        technical_summary: null,
        lifecycle: 'active',
        sources: [],
        boundaries: [],
        assessment: null
      }
    });
    assert.equal(calls.some(({ origin }) => origin === 'https://workspace.example'), false);
  });

test('related projects stay suggestions and never expand personal subscriptions automatically',
  async () => {
    const calls = [];
    const app = new FederatedGraphApplication(CONFIG, {
      fetchImpl: providerFetch(calls, {
        '/v1/projects/project-1/relations': [{
          id: 'relation-1',
          source_project_id: 'project-1',
          target_project_id: 'project-2',
          relation_type: 'DEPENDS_ON',
          status: 'active'
        }]
      })
    });

    const result = await app.listProjectRelations({
      projectId: 'project-1',
      providerUrl: 'https://workspace.example'
    });

    assert.equal(result.relations[0].target_project_id, 'project-2');
    assert.equal(calls.some(({ path, method }) =>
      path === '/v1/subscriptions' && method === 'POST'
    ), false);
  });

test('personal approval submits the full draft to shared review and then marks it submitted',
  async () => {
    const calls = [];
    const draft = {
      id: 'draft-1',
      status: 'pending',
      target_project_id: 'project-1',
      provider_url: 'https://workspace.example',
      episode: {
        idempotency_key: 'session-1-batch-1',
        sensitivity: 'normal',
        entities: [{
          key: 'project:one',
          name: 'Project one',
          type: 'Project',
          current_quadrant: 'known_known',
          epistemic_status: 'confirmed',
          confirmation_status: 'confirmed',
          confirmation_basis: {
            existence_reason: 'The project was explicitly reviewed.',
            quadrant_reason: 'The project definition was explicitly stated.',
            proposed_by: { kind: 'agent', label: 'Codex' },
            confirmed_by: { kind: 'user', label: 'Current user' },
            confirmed_at: '2026-07-21T10:00:00.000Z'
          }
        }],
        relationships: []
      }
    };
    const app = new FederatedGraphApplication(CONFIG, {
      fetchImpl: providerFetch(calls, {
        '/v1/publication-drafts/draft-1': draft,
        '/v1/projects/project-1/proposals': { id: 'proposal-1', status: 'pending' },
        '/v1/publication-drafts/draft-1/decision': {
          ...draft,
          status: 'submitted',
          shared_proposal_id: 'proposal-1'
        }
      })
    });

    const result = await app.reviewPersonalDraft({
      draftId: 'draft-1',
      decision: 'submit_public'
    });

    assert.equal(result.status, 'submitted');
    const shared = calls.find(({ path, method }) =>
      path === '/v1/projects/project-1/proposals' && method === 'POST'
    );
    assert.deepEqual(shared.body, { episode: draft.episode });
    const finalized = calls.find(({ path, method }) =>
      path === '/v1/publication-drafts/draft-1/decision' && method === 'POST'
    );
    assert.deepEqual(finalized.body, {
      decision: 'submit_public',
      shared_proposal_id: 'proposal-1'
    });
  });

test('personal knowledge correction stays on the personal Provider and keeps project scope',
  async () => {
    const calls = [];
    const app = new FederatedGraphApplication(CONFIG, {
      fetchImpl: providerFetch(calls, {
        '/v1/knowledge/items/entity-1': {
          id: 'revision-1', item_id: 'entity-1', action: 'update'
        }
      })
    });

    await app.reviseKnowledgeItem({
      personalSpaceId: 'personal-space',
      personalProjectId: 'fuli',
      itemKind: 'entity',
      itemId: 'entity-1',
      action: 'update',
      reason: '摘要沉淀不完整',
      name: 'Fuli 知识目录',
      summary: '默认以目录方式展示结构化知识。',
      inheritanceMode: 'descendants',
      inheritedProjectIds: []
    });

    const request = calls[0];
    assert.equal(request.origin, 'http://127.0.0.1:8787');
    assert.equal(request.method, 'PATCH');
    assert.deepEqual(request.body, {
      personal_space_id: 'personal-space',
      personal_project_id: 'fuli',
      item_kind: 'entity',
      action: 'update',
      reason: '摘要沉淀不完整',
      name: 'Fuli 知识目录',
      summary: '默认以目录方式展示结构化知识。',
      fact: null,
      inheritance_mode: 'descendants',
      inherited_project_ids: [],
      operation_actor: 'agent'
    });
  });

test('knowledge invalidation maps its structured replacement target to the Provider',
  async () => {
    const calls = [];
    const app = new FederatedGraphApplication(CONFIG, {
      fetchImpl: providerFetch(calls, {
        '/v1/knowledge/items/entity-old': {
          id: 'revision-1', item_id: 'entity-old', action: 'invalidate'
        }
      })
    });

    await app.reviseKnowledgeItem({
      personalSpaceId: 'personal-space',
      personalProjectId: 'project-1',
      itemKind: 'entity',
      itemId: 'entity-old',
      action: 'invalidate',
      reason: 'A newer reviewed item replaces this record.',
      replacementItemId: 'entity-current',
      replacementItemKind: 'entity'
    });

    assert.equal(calls[0].body.replacement_item_id, 'entity-current');
    assert.equal(calls[0].body.replacement_item_kind, 'entity');
  });

test('single knowledge confirmation stays personal and preserves its audit basis',
  async () => {
    const calls = [];
    const app = new FederatedGraphApplication(CONFIG, {
      fetchImpl: providerFetch(calls, {
        '/v1/knowledge/items/entity-1': {
          id: 'revision-1', item_id: 'entity-1', action: 'confirm'
        }
      })
    });

    await app.reviseKnowledgeItem({
      personalSpaceId: 'personal-space',
      personalProjectId: null,
      itemKind: 'entity',
      itemId: 'entity-1',
      action: 'confirm',
      reason: '已核对内容与发现时象限，确认无误。',
      confirmationStatus: 'confirmed',
      confirmationBasis: {
        existenceReason: '用户明确表达了这条偏好。',
        quadrantReason: '该内容属于已知的已知。',
        proposedBy: { kind: 'agent', label: 'Codex' },
        confirmedBy: { kind: 'user', label: '当前用户' },
        confirmedAt: '2026-07-28T06:20:00.000Z'
      }
    });

    const request = calls[0];
    assert.equal(request.origin, 'http://127.0.0.1:8787');
    assert.equal(request.method, 'PATCH');
    assert.equal(request.body.action, 'confirm');
    assert.equal(request.body.personal_project_id, null);
    assert.equal(request.body.confirmation_status, 'confirmed');
    assert.equal(request.body.confirmation_basis.proposed_by.kind, 'agent');
    assert.equal(request.body.confirmation_basis.confirmed_by.kind, 'user');
  });

test('batch confirmation stays personal and maps every auditable item basis', async () => {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: providerFetch(calls, {
      '/v1/knowledge/batch-confirmations': {
        confirmed_count: 2,
        confirmed_at: '2026-07-24T04:30:00Z'
      }
    })
  });

  await app.confirmKnowledgeBatch({
    personalSpaceId: 'personal-space',
    groupKind: 'session',
    groupValue: 'session-1',
    reason: '已逐条核对本次会话中的内容和发现时象限',
    confirmer: { kind: 'user', label: '当前用户' },
    items: [
      {
        itemId: 'entity-1',
        itemKind: 'entity',
        existenceReason: '本次会话明确记录了该结论',
        quadrantReason: '该结论在会话中被明确表达',
        proposedBy: { kind: 'agent', label: 'Codex' }
      },
      {
        itemId: 'relationship-1',
        itemKind: 'relationship',
        existenceReason: '本次会话明确记录了该关系',
        quadrantReason: '该关系在会话中被明确表达',
        proposedBy: { kind: 'agent', label: 'Codex' }
      }
    ]
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].origin, 'http://127.0.0.1:8787');
  assert.equal(calls[0].path, '/v1/knowledge/batch-confirmations');
  assert.equal(calls[0].body.group_kind, 'session');
  assert.equal(calls[0].body.items[0].proposed_by.kind, 'agent');
  assert.equal(calls[0].body.confirmer.kind, 'user');
});

test('one personal knowledge item can be reassigned without publishing or subscribing',
  async () => {
    const calls = [];
    const app = new FederatedGraphApplication(CONFIG, {
      fetchImpl: providerFetch(calls, {
        '/v1/knowledge/items/entity-1/assignment': {
          id: 'assignment-1', item_id: 'entity-1', project_id: 'project-b'
        }
      })
    });

    await app.reassignKnowledgeItem({
      personalSpaceId: 'personal-space',
      itemKind: 'entity',
      itemId: 'entity-1',
      targetProjectId: 'project-b',
      reason: '原项目归属错误'
    });

    assert.equal(calls[0].path, '/v1/knowledge/items/entity-1/assignment');
    assert.equal(calls[0].body.target_project_id, 'project-b');
    assert.equal(calls.some(({ origin }) => origin === 'https://workspace.example'), false);
  });

test('one personal preference scope can change locally with preserved history', async () => {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: providerFetch(calls, {
      '/v1/knowledge/items/entity-1/preference-scope': {
        id: 'revision-1', action: 'scope_change'
      }
    })
  });

  await app.setPersonalPreferenceScope({
    personalSpaceId: 'personal-space',
    itemKind: 'entity',
    itemId: 'entity-1',
    scope: 'project',
    projectId: 'fuli',
    reason: '这条偏好只适用于当前项目'
  });

  assert.equal(calls[0].path, '/v1/knowledge/items/entity-1/preference-scope');
  assert.deepEqual(calls[0].body, {
    personal_space_id: 'personal-space',
    item_kind: 'entity',
    scope: 'project',
    project_id: 'fuli',
    reason: '这条偏好只适用于当前项目',
    operation_actor: 'agent'
  });
  assert.equal(calls[0].origin, 'http://127.0.0.1:8787');
});

function episodeInput(targetKind) {
  return {
    targetKind,
    spaceId: 'personal-space',
    providerUrl: targetKind === 'project' ? 'https://workspace.example' : null,
    idempotencyKey: 'session-1-batch-1',
    sessionId: 'session-1',
    name: 'Session knowledge',
    sourceKind: 'conversation',
    sourceDescription: 'Agent structured session evidence',
    referenceTime: '2026-07-21T10:00:00.000Z',
    sensitivity: 'normal',
    entities: [{
      key: 'preference:language',
      name: '中文',
      type: 'Preference',
      originQuadrant: 'known_known',
      confirmationStatus: 'confirmed',
      confirmationBasis: {
        existenceReason: 'The user explicitly stated the language preference.',
        quadrantReason: 'The preference was explicitly expressed.',
        proposedBy: { kind: 'agent', label: 'Codex' },
        confirmedBy: { kind: 'user', label: 'Current user' },
        confirmedAt: '2026-07-21T10:00:00.000Z'
      }
    }],
    relationships: []
  };
}

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
