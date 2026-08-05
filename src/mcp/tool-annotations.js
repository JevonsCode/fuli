const READ_TOOLS = new Set([
  'verify_task_checkpoint',
  'search_current_project_knowledge',
  'discover_common_knowledge_candidates',
  'discover_personal_global_preference_candidates',
  'preview_personal_global_preference_decision',
  'preview_common_knowledge_promotion',
  'list_knowledge_spaces',
  'list_personal_projects',
  'list_knowledge_review_candidates',
  'list_workflow_candidates',
  'recommend_next_workflow_steps',
  'preview_personal_project_action',
  'list_project_releases',
  'list_project_relations',
  'list_personal_review_queue',
  'list_project_review_queue',
  'get_graphiti_status'
]);

const WRITE_TOOLS = new Set([
  'begin_task_context',
  'checkpoint_task_knowledge',
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
  'apply_common_knowledge_promotion',
  'get_knowledge_graph',
  'search_human_knowledge_changes',
  'review_human_knowledge_change',
  'upsert_personal_project',
  'start_knowledge_review',
  'record_knowledge_review_progress',
  'finish_knowledge_review',
  'revise_personal_knowledge',
  'reassign_personal_knowledge',
  'apply_personal_project_action',
  'publish_personal_project',
  'create_project_relation',
  'review_project_relation',
  'review_personal_draft',
  'subscribe_public_project',
  'unsubscribe_public_project',
  'review_project_proposal'
]);

const DESTRUCTIVE_TOOLS = new Set([
  'resolve_deferred_preference_conflict',
  'apply_common_knowledge_promotion',
  'review_project_proposal',
  'review_project_relation',
  'review_personal_draft',
  'unsubscribe_public_project'
]);

export function annotationsFor(name) {
  if (!READ_TOOLS.has(name) && !WRITE_TOOLS.has(name)) {
    throw new TypeError(`Missing MCP annotations for tool: ${name}`);
  }
  const readOnly = READ_TOOLS.has(name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: DESTRUCTIVE_TOOLS.has(name),
    idempotentHint: readOnly || name === 'upsert_personal_project' ||
      name === 'publish_personal_project' || name === 'unsubscribe_public_project' ||
      name === 'record_knowledge_usage' || name === 'record_decision_trace' ||
      name === 'record_knowledge_feedback' ||
      name === 'record_workflow_transition_observation' ||
      name === 'checkpoint_task_knowledge',
    openWorldHint: name === 'capture_session_knowledge' ||
      name === 'record_workflow_transition_observation' ||
      name === 'search_connected_knowledge' ||
      name === 'record_decision_trace' ||
      name === 'record_knowledge_feedback' ||
      name === 'checkpoint_task_knowledge' ||
      name === 'publish_personal_project' ||
      name === 'create_project_relation' ||
      name === 'review_project_relation' ||
      name === 'review_personal_draft' ||
      name === 'subscribe_public_project' ||
      name === 'unsubscribe_public_project' ||
      name === 'review_project_proposal'
  };
}
