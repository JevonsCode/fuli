const READ_TOOLS = new Set([
  'get_judgment_policy', 'list_judgments', 'get_agent_pins',
  'get_model_usage',
  'find_agents', 'read_agent_messages', 'read_agent_thread', 'get_agent_message_status',
  'get_agent_quality_gate',
  'plan_agent_collaboration', 'list_agent_loans',
  'list_agent_conversations', 'read_agent_conversation', 'get_agent_conversation_policy',
  'list_agent_attention',
  'list_project_agent_tasks',
  'list_agent_workflows', 'read_agent_workflow',
  'list_work_surfaces',
  'read_diagnostic_events',
  'read_old_data',
  'read_compounding_statement',
  'list_tonborg_questions',
  'list_reply_echoes',
  'read_occupation_kit',
  'list_preference_conflicts',
  'list_agent_interfaces',
  'get_capture_policy',
  'read_session_records',
  'explain_settings',
  'get_agent_naming_style',
  'list_external_knowledge_connectors',
  'discover_external_knowledge_sources',
  'list_external_knowledge_bindings',
  'retrieve_external_knowledge_binding',
  'get_external_knowledge_conflict_policy',
  'list_employee_templates',
  'list_employee_tools',
  'list_agent_apps',
  'verify_task_checkpoint',
  'read_task_preferences',
  'search_current_project_knowledge',
  'discover_personal_global_preference_candidates',
  'list_knowledge_spaces',
  'list_personal_projects',
  'list_project_agents',
  'get_project_agent',
  'list_project_agent_assignments',
  'get_project_agent_context',
  'get_project_agent_memory',
  'export_project_agent_memory',
  'list_agent_dismissal_lessons',
  'get_agent_handoff',
  'view_project_agent_task',
  'view_project_agent_activity',
  'get_project_agent_coordination_policy',
  'get_project_team',
  'list_project_agent_recruitments',
  'list_executors',
  'get_executor',
  'list_executor_routing_rules',
  'get_executor_routing_rule',
  'list_project_agent_routing_learning',
  'get_agent_score_card',
  'resolve_knowledge_tags',
  'list_workflow_candidates',
  'preview_personal_project_action',
  'get_graphiti_status'
]);

const WRITE_TOOLS = new Set([
  'agent_chat', 'group_discussion',
  'review_with_tonborg', 'assess_agent_action', 'assess_task_completion', 'pin_agent', 'role_work',
  'control_project_agent_task_run', 'register_standing_assignment', 'organize_project', 'report_agent_service', 'record_fla_lesson',
  'propose_agent_workflow', 'record_agent_workflow_run',
  'pause_work_surfaces', 'resume_work_surfaces', 'run_delegated_action', 'answer_tonborg_question',
  'message_agent', 'reply_agent_message', 'cancel_agent_message',
  'record_agent_verification',
  'request_agent_loan', 'decide_agent_loan',
  'resume_agent_conversation', 'update_agent_conversation_policy',
  'request_agent_attention',
  'cancel_agent_attention',
  'update_capture_policy',
  'create_external_knowledge_binding',
  'check_external_knowledge_binding',
  'sync_external_knowledge_binding',
  'update_external_knowledge_binding_targets',
  'delete_external_knowledge_binding',
  'update_external_knowledge_conflict_policy',
  'defer_preference_conflict',
  'recruit_employee',
  'call_employee_tool',
  'submit_agent_app_version',
  'begin_task_context',
  'checkpoint_task_knowledge',
  'checkpoint_project_agent_memory',
  'get_collaboration_preferences',
  'get_user_taste_skill',
  'resolve_deferred_preference_conflict',
  'capture_session_knowledge',
  'record_decision_trace',
  'search_knowledge_graph',
  'search_connected_knowledge',
  'record_knowledge_usage',
  'record_knowledge_feedback',
  'change_knowledge_tags',
  'get_knowledge_graph',
  'search_human_knowledge_changes',
  'review_human_knowledge_change',
  'upsert_personal_project',
  'upsert_project_agent',
  'rename_project_agent',
  'dismiss_project_agent',
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
  'revise_personal_knowledge',
  'reassign_personal_knowledge',
  'apply_personal_project_action'
]);

const DESTRUCTIVE_TOOLS = new Set([
  'dismiss_project_agent',
  'delete_external_knowledge_binding',
  'recruit_employee',
  'resolve_deferred_preference_conflict',
  'cleanup_test_project_agents'
]);

export function annotationsFor(name) {
  if (!READ_TOOLS.has(name) && !WRITE_TOOLS.has(name)) {
    throw new TypeError(`Missing MCP annotations for tool: ${name}`);
  }
  const readOnly = READ_TOOLS.has(name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: DESTRUCTIVE_TOOLS.has(name),
    idempotentHint: readOnly || name === 'review_with_tonborg' || name === 'assess_agent_action' || name === 'assess_task_completion' || name === 'role_work' || name === 'recruit_employee' || name === 'submit_agent_app_version' || name === 'upsert_personal_project' ||
      name === 'upsert_project_agent' ||
      name === 'rename_project_agent' ||
      name === 'dismiss_project_agent' ||
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
      name === 'record_knowledge_usage' || name === 'record_decision_trace' ||
      name === 'record_knowledge_feedback' ||
      name === 'message_agent' || name === 'reply_agent_message' || name === 'cancel_agent_message' ||
      name === 'checkpoint_task_knowledge' ||
      name === 'checkpoint_project_agent_memory' ||
      name === 'register_standing_assignment',
    openWorldHint: name === 'agent_chat' || name === 'group_discussion' || name === 'review_with_tonborg' || name === 'assess_agent_action' || name === 'assess_task_completion' || name === 'capture_session_knowledge' ||
      name === 'discover_external_knowledge_sources' ||
      name === 'create_external_knowledge_binding' ||
      name === 'check_external_knowledge_binding' ||
      name === 'sync_external_knowledge_binding' ||
      name === 'retrieve_external_knowledge_binding' ||
      name === 'update_external_knowledge_binding_targets' ||
      name === 'delete_external_knowledge_binding' ||
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
      name === 'search_connected_knowledge' ||
      name === 'record_decision_trace' ||
      name === 'record_knowledge_feedback' ||
      name === 'checkpoint_task_knowledge'
  };
}
