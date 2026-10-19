import { waitForChatChange } from './chat-wait.js';

const INBOX_LIMIT = 5;
// How long the console waits for a waiting session to pick a reply up before it
// reports the reply as queued for the Agent's next task.
const WAKE_CONFIRM_SECONDS = 3;
const VIA = Object.freeze({ wait: 'agent_chat_wait', entry: 'task_entry', read: 'read_agent_messages' });
export const ATTENTION_REPLIES_GUIDANCE = 'The person answered requests you raised. An answer is intent, not a permission grant or task acceptance: reload the request with list_agent_attention before acting and stay within your existing authority.';

// The answer a person gave on the console reaches the Agent that asked: at its
// next task entry, from read_agent_messages, or at once in an agent_chat wait.
// An answer is intent; it never grants a permission or accepts a task.
export function createAttentionInbox({ store, spaceId }) {
  const pending = (agentId, projectId) => store.attention.pending(spaceId(), agentId, projectId, INBOX_LIMIT).map(inboxReply);
  function take(agentId, projectId, via) {
    const replies = pending(agentId, projectId);
    store.attention.markDelivered(spaceId(), replies, via);
    return replies;
  }
  // "woken" is reported only after a waiting session actually took the reply.
  async function deliver(record, { choice, note }) {
    const key = [spaceId(), record.requestId, record.revision];
    let row = store.attention.record({ spaceId: spaceId(), requestId: record.requestId, revision: record.revision,
      projectId: record.personalProjectId, agentId: record.agentId, kind: record.kind, title: record.title,
      question: record.requestedAction, choice, note, repliedAt: record.updatedAt ?? new Date().toISOString() });
    if (!row.delivered_at && store.chat.waitingAnywhere(spaceId(), `local:${record.agentId}`)) {
      row = await waitForChatChange(() => store.attention.row(...key),
        { store: store.chat, timeoutSeconds: WAKE_CONFIRM_SECONDS, ready: current => Boolean(current?.delivered_at) });
    }
    return { status: !row.delivered_at ? 'inbox' : row.delivered_via === VIA.wait ? 'woken' : 'delivered',
      agentId: record.agentId };
  }
  return {
    deliver,
    taskEntry: (agentId, projectId) => take(agentId, projectId, VIA.entry),
    read: (agentId, projectId) => take(agentId, projectId, VIA.read),
    // A chat wait returns as soon as a reply is pending, then marks what it returned.
    forWait: (agentId, projectId) => ({ pending: () => pending(agentId, projectId),
      delivered: replies => store.attention.markDelivered(spaceId(), replies, VIA.wait) })
  };
}

function inboxReply(row) {
  const answer = row.choice ?? row.note;
  return { requestId: row.request_id, revision: row.revision, kind: row.kind, choice: row.choice, note: row.note,
    repliedAt: row.replied_at,
    summary: `你之前问的「${row.title}」：用户回复了「${answer}」${row.choice && row.note ? '，并附说明（见 note）' : ''}` };
}
