import { ApplicationError } from '../app/application-error.js';

const HANDLERS = Object.freeze({
  get_collaboration_preferences: (app, input) => app.getCollaborationPreferences({
    ...input,
    agentInvocation: true,
    agentToolName: 'get_collaboration_preferences'
  }),
  resolve_deferred_preference_conflict: (app, input) =>
    app.resolveDeferredPreferenceConflict({
      ...input,
      operationActor: 'agent'
    }),
  capture_session_knowledge: (app, input) => app.captureSessionKnowledge(input),
  search_knowledge_graph: (app, input) => app.searchKnowledge({
    ...input,
    agentInvocation: true,
    agentToolName: 'search_knowledge_graph'
  }),
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
  revise_personal_knowledge: (app, input) => app.reviseKnowledgeItem({
    ...input,
    operationActor: 'agent'
  }),
  reassign_personal_knowledge: (app, input) => app.reassignKnowledgeItem({
    ...input,
    operationActor: 'agent'
  }),
  set_personal_preference_scope: (app, input) => app.setPersonalPreferenceScope({
    ...input,
    operationActor: 'agent'
  }),
  preview_personal_project_action: (app, input) =>
    app.previewKnowledgeProjectAction(input),
  apply_personal_project_action: (app, input) => app.applyKnowledgeProjectAction({
    ...input,
    operationActor: 'agent'
  }),
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
