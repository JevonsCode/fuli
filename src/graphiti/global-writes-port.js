// Where a task checkpoint's writes to `global` go (docs/runner-roles-design.md §12):
// the person's preferences learned without a project, an FLA's global memory,
// and the use of global items this graph holds only as a read-only copy.
//
// A port is { elsewhere(), send({ key, ops }) }:
// - elsewhere(): whether another computer owns global. False here, and every
//   such write is made on this computer as it always was; send is never called.
// - send({ key, ops }): when elsewhere, the checkpoint hands it that
//   checkpoint's global writes at once, under a key the same for every retry of
//   the checkpoint, and gets back { delivered, queued, refused: [{ kind, code }] }:
//   how many reached the owner and were applied, how many wait to be sent, and
//   which the owner refused, with its code. A follower's runner injects one.
//
// Each op is { kind, v: 1, input }; kind is one of GLOBAL_WRITE_KINDS. The
// owner applies each on its own and answers for each (runner/host-global-writes.js).
export const GLOBAL_WRITE_KINDS = Object.freeze({
  // input: a personal knowledge capture without a project, as captureSessionKnowledge takes it.
  capture: 'capture',
  // input: { agentId, expectedRevision, idempotencyKey, memory, sourceApplication, sourceSessionId }.
  agentMemory: 'agent_memory',
  // input: { taskId, sessionId, items: [{ itemId, itemKind, useKind }] }.
  knowledgeUsage: 'knowledge_usage',
  // input: { recruitmentId, proposedAgentId, profile, occupation, reason, projectName }.
  recruit: 'recruit'
});

export const localGlobalWrites = Object.freeze({ elsewhere: () => false });
