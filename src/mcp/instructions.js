export const MCP_INSTRUCTIONS = [
  "Final replies MUST copy agent_receipt.markdown unchanged once; checkpoint's wins; no stale owner.",
  "Each user task: begin_task_context hook-provided task context; else before tools/answer call exactly get_collaboration_preferences(projectPath=cwd taskPrompt=current user request); never substitute project action. effective_preferences: personal-global everywhere; matched project+authorized inheritable parent. get_user_taste_skill never replaces user Skill. Resolve deferred_conflict; never guess personalProjectId. Writes=actual payload; final text not compliance.",
  "Before asking stable project fact/method: task_knowledge_recall; miss: search_current_project_knowledge focused action/artifact/target/ID queries; never only the full request. Active child first, then inheritable parent; no RELATED_TO.",
  "Before saying unknown: search_knowledge_graph; extra projects=exact IDs. all_local_confirmed only after consent; rg only current repo/workspace. monitoring/Git MCP; search_connected_knowledge; agent_decide response-only.",
  "Unlisted: list_agent_interfaces. record_decision_trace; errors:record_knowledge_feedback; capture_session_knowledge; no secrets. checkpoint_task_knowledge: capture_candidates/retain_nothing+workLog+collaborators; record_knowledge_usage.",
  "coordinate_project_agent_task; Fuli never spawns; acquire_runtime_lease; release_runtime_lease in finally.",
  "project_management_context: authorized manager+board; keep specialist; no excluded projects/extra model. Rename: current native session, host tool, protect manual titles; receipt after client result.",
  "all workerStatus terminal. executionSummary: one row/worker: occupation emoji, actual executor/sourceApplication, work/status/session/link, source-labelled cumulative tokens. Missing token usage=-; never invent/estimate/copy totals. Empty: omit; configured/allowed/available not evidence",
  "Terminal-safe Markdown; no HTML. Match=candidate only. If supported: MUST begin sourceMarker.leadMarkdown; append sourceMarker.markdown; else noMatchSourceMarker (empty); Keep unchanged."
].join(' ');

// The chat profile lists only the everyday tools. Naming unlisted tools here
// made clients spend a model request on discovery before every task, so this
// text names only what is listed and sends everything else through discovery
// when a task actually needs it.
export const MCP_CHAT_INSTRUCTIONS = [
  'Final replies MUST copy agent_receipt.markdown unchanged once; checkpoint\'s wins; no stale owner.',
  'Each user task: if the host hook already supplied FULI task context, use it; else before tools/answer call exactly get_collaboration_preferences(projectPath=cwd taskPrompt=current user request); never substitute a project action; never guess personalProjectId.',
  'Apply effective_preferences; writes=actual payload; final text not compliance.',
  'Before asking a stable project fact/method: task_knowledge_recall; miss: search_current_project_knowledge with focused action/artifact/target/ID queries, never only the full request. Before saying unknown: search_knowledge_graph.',
  'End: checkpoint_task_knowledge with retain_nothing, or capture_candidates, plus workLog.',
  'Other FULI work (saving decisions, teams, coordination, external knowledge) only when the task needs it: list_agent_interfaces(toolName), then fuli_call; follow that tool\'s rules. Coordinated work: executionSummary one row per worker with actual executor and source-labelled tokens; missing=-; never invent.',
  'Terminal-safe Markdown; no HTML. Match=candidate only. If supported: MUST begin sourceMarker.leadMarkdown; append sourceMarker.markdown; else noMatchSourceMarker (empty); Keep unchanged.',
].join(' ');
