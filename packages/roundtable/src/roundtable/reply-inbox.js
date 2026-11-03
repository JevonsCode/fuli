const INBOX_LIMIT = 5;
const PREVIEW_LENGTH = 160;
const UNREAD = ['pending', 'announced'];
export const AGENT_REPLIES_GUIDANCE = 'Other Agents answered asks you sent on the roundtable. Read each full reply once with '
  + 'read_agent_messages (replies); read_agent_thread shows the whole thread. A reply is not evidence of execution or human approval.';

// A reply to an ask the asker did not get back from its own message_agent call
// waits here until the asker reads it. Its next task entry announces it once;
// read_agent_messages hands over the full body once. A reply returned directly
// (message_agent, get_agent_message_status) counts as read and is never repeated.
export function createReplyInbox({ store, spaceId }) {
  const unread = (agentId, projectId, states) => store.repliesFor(spaceId(), agentId, projectId, states, INBOX_LIMIT + 1);
  // Only the call that moves a reply on returns it, so two processes never both deliver it.
  const claim = (rows, from, to, via) => rows.filter(row => store.markReplyDelivery(row.id, from, to, via));
  return {
    pendingFor: (to) => (to?.agentId && !to.agentId.startsWith('peer:') ? 'pending' : null),
    announce(agentId, projectId) {
      return claim(unread(agentId, projectId, ['pending']).slice(0, INBOX_LIMIT), ['pending'], 'announced', 'task_entry')
        .map(row => ({ ...replyHeader(row), preview: preview(row.body) }));
    },
    read(agentId, projectId) {
      const rows = unread(agentId, projectId, UNREAD);
      const replies = claim(rows.slice(0, INBOX_LIMIT), UNREAD, 'delivered', 'read_agent_messages')
        .map(row => ({ ...replyHeader(row), body: row.body }));
      return { replies, more: rows.length > INBOX_LIMIT };
    },
    handOver: (reply, via) => reply && store.markReplyDelivery(reply.id, UNREAD, 'delivered', via)
  };
}

function replyHeader(row) {
  return { messageId: row.id, inReplyTo: row.in_reply_to, threadId: row.thread_id, subject: row.subject,
    from: row.from_name, fromClient: row.from_client, repliedAt: row.created_at };
}

function preview(body) {
  const chars = [...body];
  return chars.length > PREVIEW_LENGTH ? `${chars.slice(0, PREVIEW_LENGTH).join('')}…` : body;
}
