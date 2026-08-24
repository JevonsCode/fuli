import { ApplicationError } from '../app/application-error.js';

const HANDLERS = Object.freeze({
  begin_task_context: (app, input) => app.beginTaskContext(input),
  checkpoint_task_knowledge: (app, input) =>
    app.checkpointTaskKnowledge(input),
  verify_task_checkpoint: (app, input) => app.verifyTaskCheckpoint(input),
  get_collaboration_preferences: (app, input) => app.getCollaborationPreferences({
    ...input,
    agentInvocation: true,
    agentToolName: 'get_collaboration_preferences'
  }),
  get_user_taste_skill: (app, input) => app.getUserTasteSkill(input),
  resolve_deferred_preference_conflict: (app, input) =>
    app.resolveDeferredPreferenceConflict({
      ...input,
      operationActor: 'agent'
    }),
  capture_session_knowledge: (app, input) => app.captureSessionKnowledge(input),
  record_workflow_transition_observation: (app, input) =>
    app.recordWorkflowTransitionObservation(input),
  record_decision_trace: (app, input) => app.recordDecisionTrace(input),
  search_knowledge_graph: (app, input) => app.searchKnowledge({
    ...input,
    agentInvocation: true,
    agentToolName: 'search_knowledge_graph'
  }),
  search_connected_knowledge: (app, input) => {
    if (!app.connectedKnowledge) {
      throw new Error('Connected knowledge runtime is unavailable');
    }
    return app.connectedKnowledge.query(input);
  },
  record_knowledge_usage: (app, input) => app.recordKnowledgeUsage(input),
  record_knowledge_feedback: (app, input) => app.recordKnowledgeFeedback(input),
  search_current_project_knowledge: (app, input) =>
    app.searchCurrentProjectKnowledge(input),
  discover_common_knowledge_candidates: (app, input) =>
    app.discoverCommonKnowledgeCandidates(input),
  discover_personal_global_preference_candidates: (app, input) =>
    app.discoverPersonalGlobalPreferenceCandidates(input),
  preview_personal_global_preference_decision: (app, input) =>
    app.previewPersonalGlobalPreferenceDecision(input),
  preview_common_knowledge_promotion: (app, input) =>
    app.previewCommonKnowledgePromotion(input),
  apply_common_knowledge_promotion: (app, input) => {
    const { previewToken: _previewToken, ...promotion } = input;
    return app.applyCommonKnowledgePromotion({
      ...promotion,
      operationActor: 'agent'
    });
  },
  get_knowledge_graph: (app, input) => app.getKnowledgeGraph({
    ...input,
    agentInvocation: true,
    agentToolName: 'get_knowledge_graph'
  }),
  search_human_knowledge_changes: (app, input) => app.searchHumanChanges({
    ...input,
    agentInvocation: true,
    agentToolName: 'search_human_knowledge_changes'
  }),
  review_human_knowledge_change: (app, input) => app.reviewHumanChange(input),
  list_knowledge_spaces: (app) => app.listKnowledgeSpaces(),
  upsert_personal_project: (app, input) => captureGuard(app, () =>
    app.upsertPersonalProject(input)
  ),
  list_personal_projects: (app, input) => app.listPersonalProjects(input),
  upsert_project_agent: (app, input) => captureGuard(app, () =>
    app.upsertProjectAgent(input)
  ),
  list_project_agents: (app, input) => app.listCurrentProjectAgents(input),
  get_project_agent: (app, input) => app.getProjectAgent(input),
  delete_project_agent: (app, input) => app.deleteProjectAgent(input),
  cleanup_test_project_agents: (app, input) => app.cleanupProjectAgentTestRoles(input),
  create_project_agent_assignment: (app, input) =>
    app.createProjectAgentAssignment(input),
  list_project_agent_assignments: (app, input) =>
    app.listProjectAgentAssignments(input),
  end_project_agent_assignment: (app, input) =>
    app.endProjectAgentAssignment(input),
  replace_project_agent_assignment: (app, input) =>
    app.replaceProjectAgentAssignment(input),
  get_project_agent_context: (app, input) => app.getProjectAgentContext(input),
  coordinate_project_agent_task: (app, input) =>
    app.coordinateProjectAgentTask(input),
  acquire_runtime_lease: (app, input) => app.acquireRuntimeLease(input),
  refresh_runtime_lease: (app, input) => app.refreshRuntimeLease(input),
  release_runtime_lease: (app, input) => app.releaseRuntimeLease(input),
  submit_project_agent_task: (app, input) => app.submitProjectAgentTask(input),
  view_project_agent_task: (app, input) => app.viewProjectAgentTask(input),
  record_project_agent_task_activity: (app, input) =>
    app.recordProjectAgentTaskActivity(input),
  view_project_agent_activity: (app, input) => app.viewProjectAgentActivity(input),
  get_project_agent_coordination_policy: (app, input) =>
    app.getProjectAgentCoordinationPolicy(input),
  update_project_agent_coordination_policy: (app, input) =>
    app.updateProjectAgentCoordinationPolicy(input),
  get_project_agent_recruitment_policy: (app, input) =>
    app.getProjectAgentRecruitmentPolicy(input),
  update_project_agent_recruitment_policy: (app, input) =>
    app.updateProjectAgentRecruitmentPolicy(input),
  list_project_agent_recruitments: (app, input) =>
    app.listProjectAgentRecruitments(input),
  decide_project_agent_recruitment: (app, input) =>
    app.decideProjectAgentRecruitment(input),
  upsert_executor: (app, input) => app.upsertExecutor(input),
  list_executors: (app, input) => app.listExecutors(input),
  get_executor: (app, input) => app.getExecutor(input),
  delete_executor: (app, input) => app.deleteExecutor(input),
  preflight_executor: (app, input) => app.preflightExecutor(input),
  authorize_executor: (app, input) => app.authorizeExecutor(input),
  report_executor_health: (app, input) => app.reportExecutorHealth(input),
  record_project_agent_executor_actual: (app, input) =>
    app.recordProjectAgentExecutorActual(input),
  upsert_executor_routing_rule: (app, input) =>
    app.upsertExecutorRoutingRule(input),
  update_executor_routing_rule: (app, input) =>
    app.updateExecutorRoutingRule(input),
  list_executor_routing_rules: (app, input) =>
    app.listExecutorRoutingRules(input),
  get_executor_routing_rule: (app, input) =>
    app.getExecutorRoutingRule(input),
  delete_executor_routing_rule: (app, input) =>
    app.deleteExecutorRoutingRule(input),
  record_project_agent_task_outcome: (app, input) =>
    app.recordProjectAgentTaskOutcome(input),
  list_project_agent_routing_learning: (app, input) =>
    app.listProjectAgentRoutingLearning(input),
  ignore_project_agent_routing_learning: (app, input) =>
    app.ignoreProjectAgentRoutingLearning(input),
  reset_project_agent_routing_learning: (app, input) =>
    app.resetProjectAgentRoutingLearning(input),
  start_knowledge_review: (app, input) => app.startKnowledgeReview(input),
  list_knowledge_review_candidates: (app, input) =>
    app.listKnowledgeReviewCandidates(input),
  record_knowledge_review_progress: (app, input) =>
    app.recordKnowledgeReviewProgress(input),
  finish_knowledge_review: (app, input) => app.finishKnowledgeReview(input),
  list_workflow_candidates: (app, input) => app.listWorkflowCandidates(input),
  recommend_next_workflow_steps: (app, input) =>
    app.recommendNextWorkflowSteps(input),
  revise_personal_knowledge: (app, input) => app.reviseKnowledgeItem({
    ...input,
    operationActor: 'agent'
  }),
  reassign_personal_knowledge: (app, input) => app.reassignKnowledgeItem({
    ...input,
    operationActor: 'agent'
  }),
  preview_personal_project_action: (app, input) =>
    app.previewKnowledgeProjectAction(input),
  apply_personal_project_action: (app, input) => {
    const { previewToken: _previewToken, ...action } = input;
    return app.applyKnowledgeProjectAction({
      ...action,
      operationActor: 'agent'
    });
  },
  publish_personal_project: (app, input) => app.publishPersonalProject(input),
  list_project_releases: (app, input) => app.listProjectReleases(input),
  create_project_relation: (app, input) => app.createProjectRelation(input),
  list_project_relations: (app, input) => app.listProjectRelations(input),
  review_project_relation: (app, input) => app.reviewProjectRelation(input),
  list_personal_review_queue: (app, input) => app.listPersonalReviewQueue(input),
  review_personal_draft: (app, input) => app.reviewPersonalDraft(input),
  subscribe_public_project: (app, input) => app.subscribePublicProject(input),
  unsubscribe_public_project: (app, input) => app.unsubscribePublicProject(input),
  list_project_review_queue: (app, input) => app.listReviewQueue(input),
  review_project_proposal: (app, input) => app.reviewProposal(input),
  get_graphiti_status: (app) => app.getGraphitiStatus()
});

export function dispatchGraphTool(app, name, input) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Unknown agent tool: ${name}`);
  const agentAccessPolicy = app.getAgentAccessPolicy?.() ?? {
    enabled: true,
    updatedAt: null
  };
  if (!agentAccessPolicy.enabled) {
    throw new ApplicationError(
      'agent_access_disabled',
      'FULI Agent access is disabled in the local console'
    );
  }
  return handler(app, input);
}

function captureGuard(app, operation) {
  const capturePolicy = app.getCapturePolicy?.() ?? { enabled: true, updatedAt: null };
  if (capturePolicy.enabled) return operation();
  return {
    route: 'disabled',
    status: 'capture_disabled',
    capturePolicy
  };
}
