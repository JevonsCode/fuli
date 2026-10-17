// How the lead runs delegated workstreams. Separate sessions isolate context
// best, subagents next; phases in one session only separate memory, so they
// come last. The host says what it can run; nothing here starts a worker.
export const EXECUTION_MODE_ORDER = ['new_session', 'sub_agent', 'phased'];

const DELEGATED = new Set(['delegate', 'request_loan', 'recruit']);

const GUIDANCE = {
  new_session: 'Start one host session per delegated workstream with only its dispatch brief. That session enters as the workstream Agent, checkpoints its own task and reports to the lead.',
  sub_agent: 'Run each delegated workstream as one subagent with only its dispatch brief and that Agent\'s get_project_agent_context. The subagent returns result and evidence to the lead; it does not checkpoint the parent task.',
  phased: 'Run workstreams in dependency order in this session. When a phase ends, read get_project_agent_memory for that workstream\'s agentId, then checkpoint_project_agent_memory with expectedRevision and the given idempotencyKey. The lead checkpoints the task once at the end. Phases separate memory, not context.'
};

export function executionPlan(workstreams, hostModes, taskContextToken) {
  const delegated = workstreams.filter(stream => DELEGATED.has(stream.action));
  if (!delegated.length) return { mode: 'current_session' };
  const supported = Array.isArray(hostModes) ? EXECUTION_MODE_ORDER.filter(mode => hostModes.includes(mode)) : null;
  // Unknown host support: return the order and let the host take the first it can run.
  if (!supported) return { mode: null, order: EXECUTION_MODE_ORDER,
    guidance: 'Pass hostExecutionModes with what this host can run; otherwise use the first mode in order that it supports.' };
  if (!supported.length) return { mode: null, order: EXECUTION_MODE_ORDER, blockedReason: 'no_supported_execution_mode' };
  const mode = supported[0];
  return { mode, order: EXECUTION_MODE_ORDER, guidance: GUIDANCE[mode],
    ...(mode === 'phased' ? { phases: delegated.map(stream => ({ workstream: stream.id, agentId: stream.agentId,
      memoryIdempotencyKey: `${taskContextToken}:phase:${stream.id}`,
      ...(stream.agentId ? {} : { memoryWriteback: 'after_staffing' }) })) } : {}) };
}
