import { continuationTarget } from '../agents/identity-receipt.js';
import { continuationDecision, sharedBranch, statedContinuation } from '../conversations/continuation-decision.js';
import { withinTimeLimit } from '../conversations/working-branch.js';
import { queryConversations } from './agent-conversations.js';

// The reads behind a continuation line (continuation-decision.js decides).
// They run only where a line can follow — the first turn of a new native
// session that names a conversation to continue or sits on a non-trunk
// branch, or an explicit resume — and never hold up a task entry: past the
// time limit, or on any error, there is simply no line.
const ROWS = 20;
const TIME_LIMIT_MS = 500;

export async function entryContinuation(application, task, conversation, { taskPrompt = null, repository = null } = {}) {
  const target = continuationTarget(taskPrompt);
  // A prompt written for another FLA continues nothing of this one.
  const stated = target && target.agentId === task.projectAgentId ? target.conversationId : null;
  const fresh = conversation?.status === 'saved' && !conversation.recovered_from;
  const readsBranch = Boolean(repository?.branch && repository.root && !sharedBranch(repository.branch));
  const rows = fresh && task.projectAgentId && (stated || readsBranch)
    ? await recentRows(application, task, stated) : [];
  return continuationDecision(conversation, { session: { client: task.sourceApplication, sessionId: task.sessionId },
    stated, repository, rows, personalProjectId: task.personalProjectId ?? null });
}

// resume_agent_conversation is the person's explicit word that this work
// continues here, so it always names where that conversation was last worked
// on — unless it is this session's own.
export async function resumedContinuation(application, task, conversationId) {
  const row = (await recentRows(application, task, conversationId)).find(item => item.id === conversationId);
  return row ? statedContinuation(row, { session: { client: task.sourceApplication, sessionId: task.sessionId },
    personalProjectId: task.personalProjectId ?? null }) : { show: false, reason: 'stated_source_unavailable' };
}

// This FLA's latest conversations in this scope, each with its sessions; a
// named conversation older than that page is read on its own, without them.
async function recentRows(application, task, conversationId) {
  const scope = { personalProjectId: task.personalProjectId ?? null, agentId: task.projectAgentId,
    sourceApplication: task.sourceApplication };
  const read = async () => {
    try {
      const listed = await queryConversations(application, { ...scope, mode: 'list', after: 0, limit: ROWS });
      const rows = Array.isArray(listed?.conversations) ? listed.conversations : [];
      if (!conversationId || rows.some(row => row.id === conversationId)) return rows;
      const { context: _window, ...record } = await queryConversations(application, { ...scope, mode: 'context', conversationId });
      return record?.id ? [...rows, record] : rows;
    } catch {
      return [];
    }
  };
  return (await withinTimeLimit(read(), TIME_LIMIT_MS)) ?? [];
}
