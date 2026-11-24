export const MCP_INSTRUCTIONS = [
  "Final replies MUST copy agent_receipt.markdown unchanged once; checkpoint wins; current owner.",
  "Each user task (skip host notices): begin_task_context hook-provided task context; else before tools/answer call exactly get_collaboration_preferences(projectPath=cwd taskPrompt=current user request knownRevision); never substitute project action. Use effective_preferences. Fix deferred_conflict; never guess personalProjectId. Writes=actual payload; final text not compliance.",
  "Need stable project fact/method? task_knowledge_recall; miss: search_current_project_knowledge focused action/artifact/target/ID queries; never only the full request. Active child first, inheritable parent.",
  "Before saying unknown: search_knowledge_graph; extra projects=exact IDs. all_local_confirmed only after consent; rg only current repo/workspace. monitoring/Git MCP; search_connected_knowledge; agent_decide response-only.",
  "Unlisted: list_agent_interfaces. record_decision_trace; errors:record_knowledge_feedback; capture_session_knowledge; no secrets. checkpoint_task_knowledge: capture_candidates/retain_nothing+workLog+collaborators; record_knowledge_usage.",
  "coordinate_project_agent_task; Fuli never spawns; acquire_runtime_lease, release it in finally.",
  "project_management_context: authorized manager+board; keep specialist; no excluded projects/extra model. Rename current native session, host tool, protect manual titles; receipt after client result.",
  "all workerStatus terminal. executionSummary: one row/worker: occupation emoji, actual executor/sourceApplication, work/status/session/link, source-labelled cumulative tokens. Missing tokens=-; never invent/estimate/copy totals. Empty: omit; configured/allowed/available not evidence",
  "Terminal-safe Markdown; no HTML. Match=candidate only. If supported MUST begin sourceMarker.leadMarkdown; append sourceMarker.markdown; else noMatchSourceMarker (empty) if searched; Keep unchanged.",
  "People: after sourceMarker lead, conclusion+asks first, short; diagram/table if clearer; clickable choices not typing; receipt last."
].join(' ');

// The chat profile lists only the everyday tools. Naming unlisted tools here
// made clients spend a model request on discovery before every task, so this
// text names only what is listed and sends everything else through discovery
// when a task actually needs it.
export const MCP_CHAT_INSTRUCTIONS = [
  'Final replies MUST copy agent_receipt.markdown unchanged once; checkpoint wins; current owner.',
  'Each user task (skip host notices): use supplied hook task context; else before tools/answer call exactly get_collaboration_preferences(projectPath=cwd taskPrompt=current user request knownRevision=last); never substitute project action; never guess personalProjectId.',
  'Apply effective_preferences; writes=actual payload; final text not compliance.',
  'Need stable project fact/method? task_knowledge_recall; miss: search_current_project_knowledge with focused action/artifact/target/ID queries, never only the full request. Before saying unknown: search_knowledge_graph.',
  'End: obey checkpoint_required/checkpoint_guidance. Eligible routine finishes use entry receipt, auto retain_nothing; otherwise checkpoint_task_knowledge for capture_candidates or workLog.',
  'Other work only when needed: list_agent_interfaces(toolName), then fuli_call; follow its rules. executionSummary: one row/worker, actual executor, source-labelled tokens; missing=-; never invent.',
  'Close FULI connections and test scripts once unused; never reopen in a loop.',
  'Terminal-safe Markdown; no HTML. Match=candidate only. If supported MUST begin sourceMarker.leadMarkdown; append sourceMarker.markdown; else noMatchSourceMarker (empty) if searched; Keep unchanged.',
  // Jevons 11-23: every reply a person reads; an ordinary task never reads the rules resource.
  'People: after sourceMarker lead, conclusion+asks first, short; diagram/table if clearer; clickable choices not typing; receipt last.',
].join(' ');
