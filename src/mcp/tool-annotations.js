const READ_TOOLS = new Set([
  'list_knowledge_spaces',
  'list_personal_projects',
  'preview_personal_project_action',
  'list_project_releases',
  'list_project_relations',
  'list_personal_review_queue',
  'list_project_review_queue',
  'get_graphiti_status'
]);

const WRITE_TOOLS = new Set([
  'get_collaboration_preferences',
  'resolve_deferred_preference_conflict',
  'capture_session_knowledge',
  'search_knowledge_graph',
  'get_knowledge_graph',
  'search_human_knowledge_changes',
  'review_human_knowledge_change',
  'upsert_personal_project',
  'revise_personal_knowledge',
  'reassign_personal_knowledge',
  'set_personal_preference_scope',
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
      name === 'publish_personal_project' || name === 'unsubscribe_public_project',
    openWorldHint: name === 'capture_session_knowledge' ||
      name === 'publish_personal_project' ||
      name === 'create_project_relation' ||
      name === 'review_project_relation' ||
      name === 'review_personal_draft' ||
      name === 'subscribe_public_project' ||
      name === 'unsubscribe_public_project' ||
      name === 'review_project_proposal'
  };
}
