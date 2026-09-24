const UI_MUTATION_PARITY = Object.freeze([
  agent('POST /api/agent-conversations/query', 'list_agent_conversations', 'read_agent_conversation', 'get_agent_conversation_policy'),
  agent('PUT /api/agent-conversations/policy', 'update_agent_conversation_policy'),
  agent('POST /api/agent-attention', 'request_agent_attention'),
  agent('POST /api/agent-attention/cancel', 'cancel_agent_attention'),
  local('POST /api/agent-attention/respond', 'Only a local person may respond to an Agent request. A response records a decision, but never executes permissions or task acceptance.'),
  agent('POST /api/system/runtime/leases', 'acquire_runtime_lease'),
  agent('PATCH /api/system/runtime/leases/:leaseId', 'refresh_runtime_lease'),
  agent('DELETE /api/system/runtime/leases/:leaseId', 'release_runtime_lease'),
  agent('PATCH /api/capture-policy', 'update_capture_policy'),
  local('PATCH /api/agent-access-policy', 'The Agent access kill switch requires local user presence and cannot be changed by an Agent.'),
  local('PUT /api/system/settings', 'Device-level runtime settings remain a local user operation.'),
  agent('POST /api/capture', 'capture_session_knowledge'),
  agent('POST /api/subscriptions', 'subscribe_public_project'),
  agent('DELETE /api/subscriptions/:projectId', 'unsubscribe_public_project'),
  agent('POST /api/external-knowledge/bindings', 'create_external_knowledge_binding'),
  agent('POST /api/external-knowledge/bindings/:bindingId/check', 'check_external_knowledge_binding'),
  agent('POST /api/external-knowledge/bindings/:bindingId/sync', 'sync_external_knowledge_binding'),
  agent('PATCH /api/external-knowledge/bindings/:bindingId/targets', 'update_external_knowledge_binding_targets'),
  agent('DELETE /api/external-knowledge/bindings/:bindingId', 'delete_external_knowledge_binding'),
  agent('PATCH /api/external-knowledge/conflict-policy', 'update_external_knowledge_conflict_policy'),
  agent('PUT /api/personal-projects', 'upsert_personal_project'),
  agent('PUT /api/project-agents', 'upsert_project_agent'),
  agent('DELETE /api/project-agents/:agentId', 'delete_project_agent'),
  agent('POST /api/project-agent-assignments', 'create_project_agent_assignment'),
  agent('POST /api/project-agent-assignments/:assignmentId/end', 'end_project_agent_assignment'),
  agent('POST /api/project-agent-assignments/:assignmentId/replace', 'replace_project_agent_assignment'),
  agent('POST /api/project-agent-tasks', 'submit_project_agent_task'),
  agent('POST /api/project-agent-activity', 'record_project_agent_task_activity'),
  agent('PUT /api/project-agent-coordination-policy', 'update_project_agent_coordination_policy'),
  agent('PATCH /api/project-agent-coordination-policy', 'update_project_agent_coordination_policy'),
  agent('PUT /api/project-agent-recruitment-policy', 'update_project_agent_recruitment_policy'),
  agent('PATCH /api/project-agent-recruitment-policy', 'update_project_agent_recruitment_policy'),
  agent('POST /api/project-agent-recruitments/decision', 'decide_project_agent_recruitment'),
  agent('PUT /api/executors', 'upsert_executor'),
  agent('DELETE /api/executors/:executorId', 'delete_executor'),
  agent('POST /api/executors/preflight', 'preflight_executor'),
  agent('POST /api/executors/authorization', 'authorize_executor'),
  agent('POST /api/executors/health', 'report_executor_health'),
  agent('PUT /api/executor-routing-rules', 'upsert_executor_routing_rule'),
  agent('PATCH /api/executor-routing-rules/:ruleId', 'update_executor_routing_rule'),
  agent('DELETE /api/executor-routing-rules/:ruleId', 'delete_executor_routing_rule'),
  agent('PATCH /api/project-agent-learning/:evidenceId', 'ignore_project_agent_routing_learning', 'reset_project_agent_routing_learning'),
  agent('POST /api/projects/publish', 'publish_personal_project'),
  agent('DELETE /api/projects/:projectId', 'delete_public_project'),
  agent('POST /api/project-relations', 'create_project_relation'),
  agent('POST /api/project-relations/:relationId/decision', 'review_project_relation'),
  agent('POST /api/personal-review/:draftId/decision', 'review_personal_draft'),
  agent('POST /api/review/:proposalId/decision', 'review_project_proposal'),
  agent('POST /api/preference-conflicts/defer', 'defer_preference_conflict'),
  local('POST /api/preference-conflicts/:conflictId/complete', 'Completing a preference conflict records a human decision and requires local user presence.'),
  agent('PATCH /api/knowledge/:itemKind/:itemId', 'revise_personal_knowledge'),
  agent('POST /api/knowledge/:itemKind/:itemId/assignment', 'reassign_personal_knowledge'),
  local('POST /api/knowledge/:itemKind/:itemId/preference-scope', 'Changing personal preference visibility requires local human review.'),
  agent('POST /api/knowledge/entity/:itemId/project-action/preview', 'preview_personal_project_action'),
  agent('POST /api/knowledge/entity/:itemId/project-action', 'apply_personal_project_action'),
  local('POST /api/knowledge/batch-confirmation', 'Batch confirmation asserts human confirmation and requires local user presence.'),
  agent('POST /api/employee-templates/:templateId/recruit', 'recruit_employee'),
  agent('POST /api/employee-templates/:templateId/call', 'call_employee_tool'),
  local('PATCH /employee-workspaces/:templateId/:projectId/api/work-items/:itemId/status', 'Completing a Jefa work item records explicit human acceptance in the native workbench.'),
  local('PATCH /employee-workspaces/:templateId/:projectId/api/projects/:projectId/sharing', 'Changing public project visibility requires explicit local human approval; the read-only report never grants access to private tasks.'),
]);

export function agentInterfaceCatalog() {
  const uiMutationParity = structuredClone(UI_MUTATION_PARITY);
  const agentControlled = uiMutationParity.filter(({ access }) => access === 'agent').length;
  return {
    schemaVersion: 1,
    contract: 'agent-interface-parity-v1',
    guidance: [
      'Use the named Agent tool instead of browser automation for FULI data reads and writes.',
      'Read the tool schema and current record before writes; preserve versions, scopes, and idempotency keys.',
      'local_user_only entries are deliberate trust boundaries, not missing interfaces.',
    ],
    coverage: {
      total: uiMutationParity.length,
      agentControlled,
      localUserOnly: uiMutationParity.length - agentControlled,
    },
    uiMutationParity,
    readWorkflows: [
      { domain: 'human-attention', toolNames: ['list_agent_attention', 'request_agent_attention', 'cancel_agent_attention'], guidance: 'Raise a hand only for an explicit human action. Read resolved responses before continuing. Responses do not grant permissions or accept tasks.' },
      { domain: 'projects', toolNames: ['list_knowledge_spaces', 'list_personal_projects', 'list_project_releases', 'list_project_relations'] },
      { domain: 'knowledge', toolNames: ['search_knowledge_graph', 'get_knowledge_graph', 'get_user_taste_skill', 'list_preference_conflicts'] },
      { domain: 'people-and-tasks', toolNames: ['list_project_agents', 'list_project_agent_assignments', 'list_project_agent_tasks', 'view_project_agent_task', 'view_project_agent_activity', 'list_project_agent_recruitments'] },
      { domain: 'employees-and-boards', toolNames: ['list_employee_templates', 'list_employee_tools', 'call_employee_tool'], guidance: 'Discover the employee read_board and other read tools before invoking them with exact project scope.' },
      { domain: 'external-knowledge', toolNames: ['list_external_knowledge_connectors', 'discover_external_knowledge_sources', 'list_external_knowledge_bindings', 'retrieve_external_knowledge_binding', 'get_external_knowledge_conflict_policy'], readRoutes: ['POST /api/external-knowledge/discover', 'POST /api/external-knowledge/bindings/:bindingId/retrieve'] },
      { domain: 'executors', toolNames: ['list_executors', 'get_executor', 'list_executor_routing_rules', 'list_project_agent_routing_learning'] },
      { domain: 'review', toolNames: ['list_personal_review_queue', 'list_project_review_queue', 'list_knowledge_review_candidates'] },
      { domain: 'policy-and-health', toolNames: ['get_capture_policy', 'get_project_agent_coordination_policy', 'get_project_agent_recruitment_policy', 'get_graphiti_status'] },
    ],
  };
}

function agent(route, ...toolNames) {
  return Object.freeze(toolNames.length === 1
    ? { route, access: 'agent', toolName: toolNames[0] }
    : { route, access: 'agent', toolNames: Object.freeze(toolNames) });
}

function local(route, reason) {
  return Object.freeze({ route, access: 'local_user_only', reason });
}
