const READ_TOOLS = new Set([
  'search_context',
  'get_current_facts',
  'get_timeline',
  'get_project_rules',
  'get_fact_history',
  'get_context_pack',
  'list_candidates',
  'get_user_lens',
  'search_user_context'
]);

const WRITE_TOOLS = new Set([
  'remember_episode',
  'observe_git_diff',
  'decide_candidate',
  'remember_user_fact',
  'submit_user_observation',
  'correct_user_fact',
  'confirm_observation'
]);

const DESTRUCTIVE_TOOLS = new Set(['decide_candidate', 'correct_user_fact']);

export function annotationsFor(name) {
  if (!READ_TOOLS.has(name) && !WRITE_TOOLS.has(name)) {
    throw new TypeError(`Missing MCP annotations for tool: ${name}`);
  }
  const readOnly = READ_TOOLS.has(name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: DESTRUCTIVE_TOOLS.has(name),
    idempotentHint: readOnly,
    openWorldHint: name === 'observe_git_diff'
  };
}
