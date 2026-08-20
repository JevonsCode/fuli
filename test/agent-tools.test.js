import assert from 'node:assert/strict';
import test from 'node:test';

import { callAgentTool, listAgentTools } from '../src/agent-tools.js';

const NAMES = [
  'begin_task_context',
  'checkpoint_task_knowledge',
  'verify_task_checkpoint',
  'get_collaboration_preferences',
  'get_user_taste_skill',
  'resolve_deferred_preference_conflict',
  'capture_session_knowledge',
  'record_workflow_transition_observation',
  'record_decision_trace',
  'search_knowledge_graph',
  'search_connected_knowledge',
  'record_knowledge_usage',
  'record_knowledge_feedback',
  'search_current_project_knowledge',
  'discover_common_knowledge_candidates',
  'discover_personal_global_preference_candidates',
  'preview_personal_global_preference_decision',
  'preview_common_knowledge_promotion',
  'apply_common_knowledge_promotion',
  'get_knowledge_graph',
  'search_human_knowledge_changes',
  'review_human_knowledge_change',
  'list_knowledge_spaces',
  'upsert_personal_project',
  'list_personal_projects',
  'upsert_project_agent',
  'list_project_agents',
  'get_project_agent_context',
  'get_project_agent',
  'delete_project_agent',
  'cleanup_test_project_agents',
  'create_project_agent_assignment',
  'list_project_agent_assignments',
  'end_project_agent_assignment',
  'replace_project_agent_assignment',
  'coordinate_project_agent_task',
  'acquire_runtime_lease',
  'refresh_runtime_lease',
  'release_runtime_lease',
  'submit_project_agent_task',
  'view_project_agent_task',
  'record_project_agent_task_activity',
  'view_project_agent_activity',
  'get_project_agent_recruitment_policy',
  'update_project_agent_recruitment_policy',
  'list_project_agent_recruitments',
  'decide_project_agent_recruitment',
  'upsert_executor',
  'list_executors',
  'get_executor',
  'delete_executor',
  'preflight_executor',
  'authorize_executor',
  'report_executor_health',
  'record_project_agent_executor_actual',
  'upsert_executor_routing_rule',
  'update_executor_routing_rule',
  'list_executor_routing_rules',
  'get_executor_routing_rule',
  'delete_executor_routing_rule',
  'record_project_agent_task_outcome',
  'list_project_agent_routing_learning',
  'ignore_project_agent_routing_learning',
  'reset_project_agent_routing_learning',
  'start_knowledge_review',
  'list_knowledge_review_candidates',
  'record_knowledge_review_progress',
  'finish_knowledge_review',
  'list_workflow_candidates',
  'recommend_next_workflow_steps',
  'revise_personal_knowledge',
  'reassign_personal_knowledge',
  'preview_personal_project_action',
  'apply_personal_project_action',
  'publish_personal_project',
  'list_project_releases',
  'create_project_relation',
  'list_project_relations',
  'review_project_relation',
  'list_personal_review_queue',
  'review_personal_draft',
  'subscribe_public_project',
  'unsubscribe_public_project',
  'list_project_review_queue',
  'review_project_proposal',
  'get_graphiti_status'
];

test('Agent surface exposes only the Graphiti final-version tools', () => {
  const tools = listAgentTools();
  assert.deepEqual(tools.map(({ name }) => name), NAMES);
  assert.equal(tools.every(({ inputSchema }) =>
    inputSchema.type === 'object' && inputSchema.additionalProperties === false
  ), true);

  const begin = tools.find(({ name }) => name === 'begin_task_context');
  const preferenceEntry = tools.find(({ name }) =>
    name === 'get_collaboration_preferences'
  );
  assert.deepEqual(begin.inputSchema.properties.taskPrompt, {
    type: 'string', minLength: 1, maxLength: 8192
  });
  assert.deepEqual(preferenceEntry.inputSchema.properties.taskPrompt, {
    type: 'string', minLength: 1, maxLength: 8192
  });
  assert.match(begin.description, /bounded automatic recall/i);
  assert.match(preferenceEntry.description, /task_knowledge_recall/);
  assert.match(preferenceEntry.description, /never use the full conversational request/i);

  const reviewProgress = tools.find(({ name }) =>
    name === 'record_knowledge_review_progress'
  );
  assert.deepEqual(reviewProgress.inputSchema.properties.outcome.enum, [
    'confirmed', 'updated', 'invalidated', 'deferred', 'delegated_to_ai'
  ]);
  assert.match(reviewProgress.description, /delegated_to_ai.*unknown_unknown/i);
  assert.doesNotMatch(reviewProgress.description, /skipped/i);
  const reviseKnowledge = tools.find(({ name }) =>
    name === 'revise_personal_knowledge'
  );
  assert.deepEqual(reviseKnowledge.inputSchema.properties.action.enum, [
    'confirm', 'update', 'invalidate', 'restore'
  ]);

  const search = tools.find(({ name }) => name === 'search_knowledge_graph');
  assert.deepEqual(search.inputSchema.properties.projectIds, {
    type: 'array',
    items: { type: 'string', minLength: 1, maxLength: 256 },
    maxItems: 32
  });
  assert.match(search.description, /explicitly selected/i);
  assert.match(search.description, /URLs?.*routes?.*requirements?.*prior decisions?.*runbooks?/i);
  assert.match(search.description, /before (?:saying|answering).*(?:do not know|don't know)/i);
  assert.deepEqual(search.inputSchema.properties.personalProjectId, {
    type: ['string', 'null']
  });
  assert.deepEqual(search.inputSchema.properties.contextPersonalProjectIds, {
    type: 'array',
    items: { type: 'string', minLength: 1, maxLength: 256 },
    maxItems: 15
  });
  assert.deepEqual(search.inputSchema.properties.personalProjectScope, {
    type: 'string',
    enum: ['bounded', 'all_local_confirmed']
  });
  assert.match(search.description, /explicit user confirmation/i);
  assert.match(search.description, /never expands public projects/i);
  assert.match(search.description, /retrievalGuidance/);
  assert.match(search.description, /required next action/i);
  assert.match(search.description, /current (?:repository|workspace).*files/i);
  assert.match(search.description, /read-only local file search/i);
  assert.match(search.description, /PART_OF.*USES_KNOWLEDGE_FROM/i);
  assert.match(search.description, /RELATED_TO.*never expand|never.*RELATED_TO/i);
  assert.deepEqual(search.inputSchema.properties.includePending, { type: 'boolean' });
  assert.equal(search.inputSchema.properties.includeExploratory, undefined);
  const capture = tools.find(({ name }) => name === 'capture_session_knowledge');
  assert.deepEqual(capture.inputSchema.properties.personalProjectId.type, ['string', 'null']);
  assert.deepEqual(capture.inputSchema.properties.projectAgentId.type, ['string', 'null']);
  assert.match(capture.inputSchema.properties.targetKind.description, /team-shared project/i);
  assert.match(capture.inputSchema.properties.spaceId.description, /active personal space/i);
  assert.match(
    capture.inputSchema.properties.personalProjectId.description,
    /targetKind "personal"/
  );
  assert.match(
    capture.inputSchema.properties.projectAgentId.description,
    /excluded from every other Agent/i
  );
  assert.deepEqual(search.inputSchema.properties.projectAgentId, {
    type: ['string', 'null']
  });
  const projectAgentContext = tools.find(
    ({ name }) => name === 'get_project_agent_context'
  );
  assert.match(projectAgentContext.description, /excludes every other project Agent/i);
  assert.match(projectAgentContext.description, /control layer/i);
  assert.match(
    capture.inputSchema.properties.providerUrl.description,
    /required with targetKind "project"/i
  );
  assert.deepEqual(capture.inputSchema.properties.sourceUri, {
    type: ['string', 'null'],
    minLength: 1,
    maxLength: 2048,
    pattern: '^[Hh][Tt][Tt][Pp][Ss]?://\\S+$'
  });
  assert.match(capture.description, /sourceUri.*re-read.*refresh Fuli knowledge/i);
  assert.match(
    capture.description,
    /reasoningSummary.*required.*originQuadrant.*not known_known/i
  );
  assert.match(
    capture.inputSchema.properties.entities.items.properties.reasoningSummary.description,
    /nonempty.*originQuadrant.*not known_known/i
  );
  assert.match(search.description, /source_uris.*re-read.*refreshing Fuli knowledge/i);
  assert.deepEqual(
    capture.inputSchema.properties.entities.items.properties.confirmationStatus.enum,
    ['confirmed', 'pending']
  );
  const workflowObservation = tools.find(({ name }) =>
    name === 'record_workflow_transition_observation'
  );
  assert.match(workflowObservation.description, /one call.*one observation/i);
  assert.match(workflowObservation.description, /pending.*not.*authorization/i);
  assert.equal(
    workflowObservation.inputSchema.properties.occurrenceCount,
    undefined
  );
  assert.equal(workflowObservation.inputSchema.properties.sessionId, undefined);
  assert.equal(workflowObservation.inputSchema.properties.idempotencyKey, undefined);
  assert.equal(workflowObservation.inputSchema.properties.observedAt, undefined);
  assert.equal(workflowObservation.inputSchema.properties.authority, undefined);
  assert.deepEqual(
    capture.inputSchema.properties.entities.items.properties.attributes
      .properties.searchTerms,
    {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 256 },
      minItems: 1,
      maxItems: 32
    }
  );
  const connected = tools.find(({ name }) => name === 'search_connected_knowledge');
  assert.deepEqual(connected.inputSchema.required, [
    'personalSpaceId', 'personalProjectId', 'query'
  ]);
  assert.match(connected.description, /personal.*public.*third-party/is);
  assert.match(connected.description, /conflict policy/i);
  assert.match(connected.description, /never.*rewrite|does not.*rewrite/i);
  const usage = tools.find(({ name }) => name === 'record_knowledge_usage');
  assert.match(usage.description, /materially affected/i);
  assert.match(usage.description, /idempotent/i);
  assert.deepEqual(
    usage.inputSchema.properties.items.items.properties.useKind.enum,
    ['cited', 'applied']
  );
  const preferences = tools.find(({ name }) => name === 'get_collaboration_preferences');
  assert.match(preferences.description, /start of every user task/i);
  assert.match(preferences.description, /before any other tool or answer/i);
  assert.match(preferences.description, /projectPath.*current working directory/i);
  assert.match(preferences.description, /never stores or returns/i);
  assert.match(preferences.description, /effective_preferences/);
  assert.match(preferences.description, /write tools?.*actual payload/i);
  assert.match(preferences.description, /final answer.*not compliance/i);
  const tasteSkill = tools.find(({ name }) => name === 'get_user_taste_skill');
  assert.match(tasteSkill.description, /read-only.*user-taste.*Skill projection/i);
  assert.match(tasteSkill.description, /never overwrites.*user-authored/i);
  assert.deepEqual(tasteSkill.inputSchema.required, ['projectPath']);
  assert.deepEqual(preferences.inputSchema.properties.projectPath, {
    type: 'string',
    minLength: 1,
    maxLength: 4096
  });
  assert.deepEqual(preferences.inputSchema.required, ['projectPath']);
  assert.deepEqual(preferences.inputSchema.properties.personalProjectId, {
    type: ['string', 'null']
  });
  assert.match(preferences.description, /deferred_conflicts/);
  const conflictResolver = tools.find(
    ({ name }) => name === 'resolve_deferred_preference_conflict'
  );
  assert.match(conflictResolver.description, /current task needs/i);
  assert.match(conflictResolver.description, /resolved by AI/i);
  assert.deepEqual(conflictResolver.inputSchema.properties.resolution.enum, [
    'merge', 'keep_left', 'keep_right', 'split_scope'
  ]);
});

test('Agent surface dispatches every tool through the Graphiti facade', async () => {
  const calls = [];
  const app = {
    beginTaskContext: async (input) => calls.push(['begin-task', input]),
    checkpointTaskKnowledge: async (input) => calls.push(['checkpoint-task', input]),
    verifyTaskCheckpoint: async (input) => calls.push(['verify-task', input]),
    getCollaborationPreferences: async (input) => calls.push(['preferences', input]),
    getUserTasteSkill: async (input) => calls.push(['taste-skill', input]),
    resolveDeferredPreferenceConflict: async (input) =>
      calls.push(['resolve-preference-conflict', input]),
    captureSessionKnowledge: async (input) => calls.push(['capture', input]),
    recordWorkflowTransitionObservation: async (input) =>
      calls.push(['workflow-observation', input]),
    recordDecisionTrace: async (input) => calls.push(['decision-trace', input]),
    searchKnowledge: async (input) => calls.push(['search', input]),
    connectedKnowledge: {
      query: async (input) => calls.push(['connected-search', input])
    },
    recordKnowledgeUsage: async (input) => calls.push(['knowledge-usage', input]),
    recordKnowledgeFeedback: async (input) =>
      calls.push(['knowledge-feedback', input]),
    searchCurrentProjectKnowledge: async (input) =>
      calls.push(['current-project-search', input]),
    discoverCommonKnowledgeCandidates: async (input) =>
      calls.push(['common-candidates', input]),
    discoverPersonalGlobalPreferenceCandidates: async (input) =>
      calls.push(['personal-global-candidates', input]),
    previewPersonalGlobalPreferenceDecision: async (input) =>
      calls.push(['preview-personal-global-decision', input]),
    previewCommonKnowledgePromotion: async (input) =>
      calls.push(['preview-common-promotion', input]),
    applyCommonKnowledgePromotion: async (input) =>
      calls.push(['apply-common-promotion', input]),
    getKnowledgeGraph: async (input) => calls.push(['graph', input]),
    searchHumanChanges: async (input) => calls.push(['human-changes', input]),
    reviewHumanChange: async (input) => calls.push(['review-human-change', input]),
    listKnowledgeSpaces: async () => calls.push(['spaces']),
    upsertPersonalProject: async (input) => calls.push(['upsert-project', input]),
    listPersonalProjects: async (input) => calls.push(['personal-projects', input]),
    upsertProjectAgent: async (input) => calls.push(['upsert-project-agent', input]),
    listCurrentProjectAgents: async (input) => calls.push(['project-agents', input]),
    getProjectAgentContext: async (input) => calls.push(['project-agent-context', input]),
    getProjectAgent: async (input) => calls.push(['get-project-agent', input]),
    deleteProjectAgent: async (input) => calls.push(['delete-project-agent', input]),
    cleanupProjectAgentTestRoles: async (input) =>
      calls.push(['cleanup-test-project-agents', input]),
    createProjectAgentAssignment: async (input) =>
      calls.push(['create-project-agent-assignment', input]),
    listProjectAgentAssignments: async (input) =>
      calls.push(['list-project-agent-assignments', input]),
    endProjectAgentAssignment: async (input) =>
      calls.push(['end-project-agent-assignment', input]),
    replaceProjectAgentAssignment: async (input) =>
      calls.push(['replace-project-agent-assignment', input]),
    coordinateProjectAgentTask: async (input) =>
      calls.push(['coordinate-project-agent-task', input]),
    acquireRuntimeLease: async (input) => calls.push(['acquire-runtime-lease', input]),
    refreshRuntimeLease: async (input) => calls.push(['refresh-runtime-lease', input]),
    releaseRuntimeLease: async (input) => calls.push(['release-runtime-lease', input]),
    submitProjectAgentTask: async (input) => calls.push(['submit-project-agent-task', input]),
    viewProjectAgentTask: async (input) => calls.push(['view-project-agent-task', input]),
    recordProjectAgentTaskActivity: async (input) =>
      calls.push(['record-project-agent-task-activity', input]),
    viewProjectAgentActivity: async (input) =>
      calls.push(['view-project-agent-activity', input]),
    getProjectAgentRecruitmentPolicy: async (input) =>
      calls.push(['get-project-agent-recruitment-policy', input]),
    updateProjectAgentRecruitmentPolicy: async (input) =>
      calls.push(['update-project-agent-recruitment-policy', input]),
    listProjectAgentRecruitments: async (input) =>
      calls.push(['list-project-agent-recruitments', input]),
    decideProjectAgentRecruitment: async (input) =>
      calls.push(['decide-project-agent-recruitment', input]),
    upsertExecutor: async (input) => calls.push(['upsert-executor', input]),
    listExecutors: async (input) => calls.push(['list-executors', input]),
    getExecutor: async (input) => calls.push(['get-executor', input]),
    deleteExecutor: async (input) => calls.push(['delete-executor', input]),
    preflightExecutor: async (input) => calls.push(['preflight-executor', input]),
    authorizeExecutor: async (input) => calls.push(['authorize-executor', input]),
    reportExecutorHealth: async (input) => calls.push(['report-executor-health', input]),
    recordProjectAgentExecutorActual: async (input) =>
      calls.push(['record-project-agent-executor-actual', input]),
    upsertExecutorRoutingRule: async (input) => calls.push(['upsert-executor-routing-rule', input]),
    updateExecutorRoutingRule: async (input) => calls.push(['update-executor-routing-rule', input]),
    listExecutorRoutingRules: async (input) => calls.push(['list-executor-routing-rules', input]),
    getExecutorRoutingRule: async (input) => calls.push(['get-executor-routing-rule', input]),
    deleteExecutorRoutingRule: async (input) => calls.push(['delete-executor-routing-rule', input]),
    recordProjectAgentTaskOutcome: async (input) =>
      calls.push(['record-project-agent-task-outcome', input]),
    listProjectAgentRoutingLearning: async (input) =>
      calls.push(['list-project-agent-routing-learning', input]),
    ignoreProjectAgentRoutingLearning: async (input) =>
      calls.push(['ignore-project-agent-routing-learning', input]),
    resetProjectAgentRoutingLearning: async (input) =>
      calls.push(['reset-project-agent-routing-learning', input]),
    startKnowledgeReview: async (input) => calls.push(['start-knowledge-review', input]),
    listKnowledgeReviewCandidates: async (input) =>
      calls.push(['knowledge-review-candidates', input]),
    recordKnowledgeReviewProgress: async (input) =>
      calls.push(['knowledge-review-progress', input]),
    finishKnowledgeReview: async (input) => calls.push(['finish-knowledge-review', input]),
    listWorkflowCandidates: async (input) => calls.push(['workflow-candidates', input]),
    recommendNextWorkflowSteps: async (input) =>
      calls.push(['workflow-recommendations', input]),
    reviseKnowledgeItem: async (input) => calls.push(['revise-knowledge', input]),
    reassignKnowledgeItem: async (input) => calls.push(['reassign-knowledge', input]),
    previewKnowledgeProjectAction: async (input) => calls.push(['preview-project-action', input]),
    applyKnowledgeProjectAction: async (input) => calls.push(['apply-project-action', input]),
    publishPersonalProject: async (input) => calls.push(['publish-project', input]),
    listProjectReleases: async (input) => calls.push(['project-releases', input]),
    createProjectRelation: async (input) => calls.push(['create-relation', input]),
    listProjectRelations: async (input) => calls.push(['relations', input]),
    reviewProjectRelation: async (input) => calls.push(['review-relation', input]),
    listPersonalReviewQueue: async (input) => calls.push(['personal-review', input]),
    reviewPersonalDraft: async (input) => calls.push(['review-draft', input]),
    subscribePublicProject: async (input) => calls.push(['subscribe', input]),
    unsubscribePublicProject: async (input) => calls.push(['unsubscribe', input]),
    listReviewQueue: async (input) => calls.push(['queue', input]),
    reviewProposal: async (input) => calls.push(['review', input]),
    getGraphitiStatus: async () => calls.push(['status'])
  };

  for (const name of NAMES) await callAgentTool(app, name, { probe: name });
  assert.deepEqual(calls.map(([name]) => name), [
    'begin-task', 'checkpoint-task', 'verify-task',
    'preferences', 'taste-skill', 'resolve-preference-conflict',
    'capture', 'workflow-observation', 'decision-trace', 'search', 'connected-search',
    'knowledge-usage', 'knowledge-feedback',
    'current-project-search', 'common-candidates', 'personal-global-candidates',
    'preview-personal-global-decision',
    'preview-common-promotion', 'apply-common-promotion',
    'graph', 'human-changes', 'review-human-change',
    'spaces', 'upsert-project', 'personal-projects',
    'upsert-project-agent', 'project-agents', 'project-agent-context',
    'get-project-agent', 'delete-project-agent', 'cleanup-test-project-agents',
    'create-project-agent-assignment', 'list-project-agent-assignments',
    'end-project-agent-assignment', 'replace-project-agent-assignment',
    'coordinate-project-agent-task',
    'acquire-runtime-lease', 'refresh-runtime-lease', 'release-runtime-lease',
    'submit-project-agent-task', 'view-project-agent-task',
    'record-project-agent-task-activity', 'view-project-agent-activity',
    'get-project-agent-recruitment-policy', 'update-project-agent-recruitment-policy',
    'list-project-agent-recruitments', 'decide-project-agent-recruitment',
    'upsert-executor', 'list-executors', 'get-executor', 'delete-executor',
    'preflight-executor', 'authorize-executor', 'report-executor-health',
    'record-project-agent-executor-actual',
    'upsert-executor-routing-rule', 'update-executor-routing-rule',
    'list-executor-routing-rules', 'get-executor-routing-rule',
    'delete-executor-routing-rule', 'record-project-agent-task-outcome',
    'list-project-agent-routing-learning', 'ignore-project-agent-routing-learning',
    'reset-project-agent-routing-learning',
    'start-knowledge-review', 'knowledge-review-candidates',
    'knowledge-review-progress', 'finish-knowledge-review',
    'workflow-candidates', 'workflow-recommendations',
    'revise-knowledge', 'reassign-knowledge', 'preview-project-action',
    'apply-project-action',
    'publish-project', 'project-releases', 'create-relation', 'relations', 'review-relation',
    'personal-review', 'review-draft',
    'subscribe', 'unsubscribe', 'queue', 'review', 'status'
  ]);
});

test('Agent surface rejects removed SQLite and unknown tools', () => {
  assert.throws(() => callAgentTool({}, 'remember_episode', {}), /Unknown agent tool/);
  assert.throws(
    () => callAgentTool({}, 'set_personal_preference_scope', {}),
    /Unknown agent tool/
  );
  assert.throws(() => callAgentTool({}, 'unknown', {}), /Unknown agent tool/);
});

test('global Agent access switch blocks every tool before its handler runs', () => {
  const app = {
    getAgentAccessPolicy: () => ({ enabled: false, updatedAt: null })
  };

  for (const name of NAMES) {
    assert.throws(
      () => callAgentTool(app, name, {}),
      (error) => error?.code === 'agent_access_disabled',
      name
    );
  }
});

test('disabled capture policy also prevents automatic personal-project creation', async () => {
  let writes = 0;
  const result = await callAgentTool({
    getCapturePolicy: () => ({ enabled: false, updatedAt: null }),
    upsertPersonalProject: async () => { writes += 1; }
  }, 'upsert_personal_project', { personalProjectId: 'new-project' });

  assert.equal(result.status, 'capture_disabled');
  assert.equal(result.capturePolicy.enabled, false);
  assert.equal(writes, 0);
});
