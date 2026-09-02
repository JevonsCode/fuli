const READ_TOOLS = new Set([
  'list_employee_templates',
  'list_employee_tools',
  'verify_task_checkpoint',
  'search_current_project_knowledge',
  'discover_common_knowledge_candidates',
  'discover_personal_global_preference_candidates',
  'preview_personal_global_preference_decision',
  'preview_common_knowledge_promotion',
  'list_knowledge_spaces',
  'list_personal_projects',
  'list_project_agents',
  'get_project_agent',
  'list_project_agent_assignments',
  'get_project_agent_context',
  'get_project_agent_memory',
  'view_project_agent_task',
  'view_project_agent_activity',
  'get_project_agent_coordination_policy',
  'get_project_agent_recruitment_policy',
  'list_project_agent_recruitments',
  'list_executors',
  'get_executor',
  'list_executor_routing_rules',
  'get_executor_routing_rule',
  'list_project_agent_routing_learning',
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
  'recruit_employee',
  'call_employee_tool',
  'begin_task_context',
  'checkpoint_task_knowledge',
  'checkpoint_project_agent_memory',
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
  'upsert_project_agent',
  'delete_project_agent',
  'cleanup_test_project_agents',
  'create_project_agent_assignment',
  'end_project_agent_assignment',
  'replace_project_agent_assignment',
  'coordinate_project_agent_task',
  'acquire_runtime_lease',
  'refresh_runtime_lease',
  'release_runtime_lease',
  'submit_project_agent_task',
  'record_project_agent_task_activity',
  'update_project_agent_coordination_policy',
  'update_project_agent_recruitment_policy',
  'decide_project_agent_recruitment',
  'upsert_executor',
  'delete_executor',
  'preflight_executor',
  'authorize_executor',
  'report_executor_health',
  'upsert_executor_routing_rule',
  'update_executor_routing_rule',
  'delete_executor_routing_rule',
  'record_project_agent_task_outcome',
  'record_project_agent_executor_actual',
  'ignore_project_agent_routing_learning',
  'reset_project_agent_routing_learning',
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
  'recruit_employee',
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
    idempotentHint: readOnly || name === 'recruit_employee' || name === 'upsert_personal_project' ||
      name === 'upsert_project_agent' ||
      name === 'delete_project_agent' ||
      name === 'cleanup_test_project_agents' ||
      name === 'create_project_agent_assignment' ||
      name === 'coordinate_project_agent_task' ||
      name === 'refresh_runtime_lease' ||
      name === 'release_runtime_lease' ||
      name === 'submit_project_agent_task' ||
      name === 'record_project_agent_task_activity' ||
      name === 'record_project_agent_task_outcome' ||
      name === 'record_project_agent_executor_actual' ||
      name === 'upsert_executor' ||
      name === 'preflight_executor' ||
      name === 'authorize_executor' ||
      name === 'report_executor_health' ||
      name === 'upsert_executor_routing_rule' ||
      name === 'update_executor_routing_rule' ||
      name === 'publish_personal_project' || name === 'unsubscribe_public_project' ||
      name === 'record_knowledge_usage' || name === 'record_decision_trace' ||
      name === 'record_knowledge_feedback' ||
      name === 'record_workflow_transition_observation' ||
      name === 'checkpoint_task_knowledge' ||
      name === 'checkpoint_project_agent_memory',
    openWorldHint: name === 'capture_session_knowledge' ||
      name === 'coordinate_project_agent_task' ||
      name === 'submit_project_agent_task' ||
      name === 'record_project_agent_task_activity' ||
      name === 'preflight_executor' ||
      name === 'record_project_agent_task_outcome' ||
      name === 'record_project_agent_executor_actual' ||
      name === 'upsert_executor' ||
      name === 'delete_executor' ||
      name === 'authorize_executor' ||
      name === 'report_executor_health' ||
      name === 'upsert_executor_routing_rule' ||
      name === 'update_executor_routing_rule' ||
      name === 'delete_executor_routing_rule' ||
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
