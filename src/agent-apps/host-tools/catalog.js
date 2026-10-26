// What an app may be granted of the FULI Agent tools (rec#7 D-28.4, D-28.9,
// D-28.14, D-28.17). Every Agent tool has an entry here, so a new tool is not
// offered to apps until someone decides what it is.
// - marks: egress (data leaves this computer: providers, connectors, peers),
//   model (spends model budget), launch (starts an external client, executor
//   or process). A marked tool, or one that does any of these indirectly, is
//   never granted; a manifest that asks for one is rejected when submitted
//   (manifest_rejected), and the host refuses it again on every call.
// - notForApps: a tool that manages apps, or whose input names a local path,
//   a session, a provider or another scope the host cannot confine to the
//   app's own space and Agent.
// - appTool: grantable. effect read or write decides whether a call runs
//   inside the app's write gate; scopeFields are the input fields that carry
//   the caller's scope (personalSpaceId, agentId, appId): a request that sets
//   one to anything but the app's own value is refused, then the host sets
//   them; dataPathFields must be relative paths inside data/<appId>.
// Granting a tool never widens what the owning Agent may do: the app acts in
// that Agent's space and as that Agent.
//
// A host tool's contract with its data port (dataFs, app-data-fs.js): every
// operation that fails fails the whole call and nothing is committed, even
// when the tool catches it. A tool that expects a failure names it on that
// one operation, e.g. dataFs.readFile('state.json', { tolerate: ['ENOENT'] })
// for a file that may not exist yet. The FULI Agent tools granted today
// (fuli-tools.js) never use the port.
const appTool = (effect, scopeFields, dataPathFields = []) => Object.freeze({
  grantable: true, effect, scopeFields: Object.freeze(scopeFields), dataPathFields: Object.freeze(dataPathFields),
  marks: Object.freeze([])
});
const marked = (...marks) => Object.freeze({ grantable: false, marks: Object.freeze(marks) });
const notForApps = (reason) => Object.freeze({ grantable: false, marks: Object.freeze([]), reason });

const MANAGES_APPS = notForApps('manages_apps');
const UNSCOPED = notForApps('unscoped');
const EGRESS = marked('egress');
const MODEL = marked('model');
const LAUNCH = marked('launch');
const PEERS = marked('egress', 'launch');

export const HOST_TOOL_CATALOG = Object.freeze({
  // Grantable: local graph reads and writes within the owning Agent's space.
  list_personal_projects: appTool('read', ['personalSpaceId']),
  resolve_knowledge_tags: appTool('read', ['personalSpaceId']),
  get_project_agent_memory: appTool('read', ['personalSpaceId', 'agentId']),
  record_decision_trace: appTool('write', ['personalSpaceId']),
  checkpoint_project_agent_memory: appTool('write', ['personalSpaceId', 'agentId']),

  submit_agent_app_version: MANAGES_APPS,
  list_agent_apps: MANAGES_APPS,

  // Data leaves this computer: knowledge providers, connectors, public projects, LAN peers.
  list_external_knowledge_connectors: EGRESS,
  discover_external_knowledge_sources: EGRESS,
  list_external_knowledge_bindings: EGRESS,
  create_external_knowledge_binding: EGRESS,
  check_external_knowledge_binding: EGRESS,
  sync_external_knowledge_binding: EGRESS,
  retrieve_external_knowledge_binding: EGRESS,
  update_external_knowledge_binding_targets: EGRESS,
  delete_external_knowledge_binding: EGRESS,
  get_external_knowledge_conflict_policy: EGRESS,
  update_external_knowledge_conflict_policy: EGRESS,
  search_connected_knowledge: EGRESS,
  // Federated search may pass the query to remote workspace clients.
  search_knowledge_graph: EGRESS,
  capture_session_knowledge: EGRESS,
  get_knowledge_graph: EGRESS,
  delete_public_project: EGRESS,
  publish_personal_project: EGRESS,
  list_project_releases: EGRESS,
  create_project_relation: EGRESS,
  list_project_relations: EGRESS,
  review_project_relation: EGRESS,
  subscribe_public_project: EGRESS,
  unsubscribe_public_project: EGRESS,
  list_project_review_queue: EGRESS,
  review_project_proposal: EGRESS,
  agent_chat: PEERS,
  group_discussion: PEERS,
  find_agents: EGRESS,
  message_agent: PEERS,
  read_agent_messages: EGRESS,
  reply_agent_message: PEERS,
  read_agent_thread: EGRESS,
  get_agent_message_status: EGRESS,
  cancel_agent_message: EGRESS,

  // Model budget: Tonborg, Bole and the built-in Agents' work.
  review_with_tonborg: MODEL,
  assess_agent_action: MODEL,
  assess_task_completion: MODEL,
  role_work: MODEL,
  plan_agent_collaboration: MODEL,
  get_agent_score_card: MODEL,
  dismiss_project_agent: MODEL,
  checkpoint_task_knowledge: MODEL,

  // Starts an external client, executor, employee tool or runtime.
  resume_agent_conversation: LAUNCH,
  coordinate_project_agent_task: LAUNCH,
  submit_project_agent_task: LAUNCH,
  control_project_agent_task_run: LAUNCH,
  manage_project_agent_schedule: LAUNCH,
  recruit_employee: LAUNCH,
  call_employee_tool: LAUNCH,
  acquire_runtime_lease: LAUNCH,
  refresh_runtime_lease: LAUNCH,
  request_agent_attention: LAUNCH,

  // Local, but a session, a local path, another Agent's records or the
  // person's own settings and reviews: not confined to an app's scope.
  list_agent_attention: UNSCOPED,
  cancel_agent_attention: UNSCOPED,
  list_project_agent_tasks: UNSCOPED,
  list_preference_conflicts: UNSCOPED,
  list_agent_interfaces: UNSCOPED,
  get_capture_policy: UNSCOPED,
  read_session_records: UNSCOPED,
  register_standing_assignment: UNSCOPED,
  explain_settings: UNSCOPED,
  update_capture_policy: UNSCOPED,
  defer_preference_conflict: UNSCOPED,
  list_employee_templates: UNSCOPED,
  list_employee_tools: UNSCOPED,
  get_judgment_policy: UNSCOPED,
  list_judgments: UNSCOPED,
  get_agent_pins: UNSCOPED,
  pin_agent: UNSCOPED,
  get_model_usage: UNSCOPED,
  read_task_preferences: UNSCOPED,
  begin_task_context: UNSCOPED,
  verify_task_checkpoint: UNSCOPED,
  get_collaboration_preferences: UNSCOPED,
  get_user_taste_skill: UNSCOPED,
  resolve_deferred_preference_conflict: UNSCOPED,
  record_workflow_transition_observation: UNSCOPED,
  record_knowledge_usage: UNSCOPED,
  change_knowledge_tags: UNSCOPED,
  record_knowledge_feedback: UNSCOPED,
  search_current_project_knowledge: UNSCOPED,
  discover_common_knowledge_candidates: UNSCOPED,
  discover_personal_global_preference_candidates: UNSCOPED,
  preview_personal_global_preference_decision: UNSCOPED,
  preview_common_knowledge_promotion: UNSCOPED,
  apply_common_knowledge_promotion: UNSCOPED,
  search_human_knowledge_changes: UNSCOPED,
  review_human_knowledge_change: UNSCOPED,
  list_knowledge_spaces: UNSCOPED,
  upsert_personal_project: UNSCOPED,
  upsert_project_agent: UNSCOPED,
  list_project_agents: UNSCOPED,
  get_project_agent_context: UNSCOPED,
  get_project_agent: UNSCOPED,
  export_project_agent_memory: UNSCOPED,
  list_agent_conversations: UNSCOPED,
  read_agent_conversation: UNSCOPED,
  get_agent_conversation_policy: UNSCOPED,
  update_agent_conversation_policy: UNSCOPED,
  get_agent_quality_gate: UNSCOPED,
  record_agent_verification: UNSCOPED,
  request_agent_loan: UNSCOPED,
  decide_agent_loan: UNSCOPED,
  list_agent_loans: UNSCOPED,
  list_agent_dismissal_lessons: UNSCOPED,
  get_agent_handoff: UNSCOPED,
  cleanup_test_project_agents: UNSCOPED,
  create_project_agent_assignment: UNSCOPED,
  list_project_agent_assignments: UNSCOPED,
  end_project_agent_assignment: UNSCOPED,
  replace_project_agent_assignment: UNSCOPED,
  release_runtime_lease: UNSCOPED,
  view_project_agent_task: UNSCOPED,
  record_project_agent_task_activity: UNSCOPED,
  view_project_agent_activity: UNSCOPED,
  get_project_agent_coordination_policy: UNSCOPED,
  get_project_team: UNSCOPED,
  update_project_agent_coordination_policy: UNSCOPED,
  get_project_agent_recruitment_policy: UNSCOPED,
  update_project_agent_recruitment_policy: UNSCOPED,
  list_project_agent_recruitments: UNSCOPED,
  decide_project_agent_recruitment: UNSCOPED,
  upsert_executor: UNSCOPED,
  list_executors: UNSCOPED,
  get_executor: UNSCOPED,
  delete_executor: UNSCOPED,
  preflight_executor: UNSCOPED,
  authorize_executor: UNSCOPED,
  report_executor_health: UNSCOPED,
  record_project_agent_executor_actual: UNSCOPED,
  upsert_executor_routing_rule: UNSCOPED,
  update_executor_routing_rule: UNSCOPED,
  list_executor_routing_rules: UNSCOPED,
  get_executor_routing_rule: UNSCOPED,
  delete_executor_routing_rule: UNSCOPED,
  record_project_agent_task_outcome: UNSCOPED,
  list_project_agent_routing_learning: UNSCOPED,
  ignore_project_agent_routing_learning: UNSCOPED,
  reset_project_agent_routing_learning: UNSCOPED,
  start_knowledge_review: UNSCOPED,
  list_knowledge_review_candidates: UNSCOPED,
  record_knowledge_review_progress: UNSCOPED,
  finish_knowledge_review: UNSCOPED,
  list_workflow_candidates: UNSCOPED,
  recommend_next_workflow_steps: UNSCOPED,
  revise_personal_knowledge: UNSCOPED,
  reassign_personal_knowledge: UNSCOPED,
  preview_personal_project_action: UNSCOPED,
  apply_personal_project_action: UNSCOPED,
  list_personal_review_queue: UNSCOPED,
  review_personal_draft: UNSCOPED,
  get_graphiti_status: UNSCOPED
});

export function hostToolEntry(toolName) {
  return Object.hasOwn(HOST_TOOL_CATALOG, toolName) ? HOST_TOOL_CATALOG[toolName] : null;
}
