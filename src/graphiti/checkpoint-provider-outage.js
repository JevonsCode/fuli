// rec#39: the first checkpoint call binds its input, so a call the Graph
// Provider never answered finishes only when resent unchanged. Say so instead
// of a bare timeout, which led Agents to retry with new wording and be refused.
const GUIDANCE = 'This checkpoint did not finish because FULI\'s graph service did not answer. ' +
  'FULI may already keep its input, so retry checkpoint_task_knowledge with exactly the same arguments; changed wording is refused. ' +
  'Until a retry returns checkpointed, do not claim the task was saved; end with the entry agent_receipt. ' +
  'If the retry fails again, say in one line that FULI could not save this task yet.';

export function checkpointIncomplete(error) {
  return {
    status: 'checkpoint_incomplete',
    reason: error.code,
    checkpoint_required: true,
    retry: { tool: 'checkpoint_task_knowledge', same_input: true, attempts: 1 },
    guidance: GUIDANCE
  };
}
