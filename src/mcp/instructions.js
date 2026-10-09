export const MCP_INSTRUCTIONS = [
  "Final replies MUST copy agent_receipt.markdown unchanged once; no stale owner.",
  "Each user task: begin_task_context hook-provided task context; else before tools/answer call exactly get_collaboration_preferences(projectPath=cwd taskPrompt=current user request); never substitute project action. effective_preferences: personal-global everywhere; matched project+authorized inheritable parent. get_user_taste_skill never replaces user Skill. Resolve deferred_conflict; never guess personalProjectId. Writes=actual payload; final text not compliance.",
  "Before asking stable project fact/method: task_knowledge_recall; miss: search_current_project_knowledge focused action/artifact/target/ID queries; never only the full request. Active child first, then inheritable parent; no local_only/RELATED_TO.",
  "Before saying unknown: search_knowledge_graph; extra projects=exact IDs. all_local_confirmed only after consent; rg only current repo/workspace. monitoring/Git MCP; search_connected_knowledge; agent_decide response-only.",
  "record_decision_trace; errors:record_knowledge_feedback. Batch durable confirmed knowledge: capture_session_knowledge; no secrets. checkpoint_task_knowledge: capture_candidates/retain_nothing+workLog; record_knowledge_usage.",
  "coordinate_project_agent_task=isolated; Fuli never spawns; acquire_runtime_lease; run/report; release_runtime_lease in finally.",
  "project_management_context: authorized manager+board; keep specialist; no excluded projects/extra model. Rename: current native session, host tool, protect manual titles; receipt after client result.",
  "Wait: all workerStatus terminal. executionSummary: one row/worker: occupation emoji, actual executor/sourceApplication, work/status/session/link, source-labelled cumulative tokens. Missing=unknown; never invent/estimate/copy totals. Empty: omit; configured/allowed/available not evidence.",
  "Terminal-safe Markdown; no HTML. Match=candidate only. If supported: MUST begin sourceMarker.leadMarkdown; append sourceMarker.markdown; else noMatchSourceMarker (empty); Keep unchanged."
].join(' ');
