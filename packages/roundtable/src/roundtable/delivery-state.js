// What a sender is told about an ask that has no answer yet (rec#97). FULI can
// only start a session or hand the ask to a desktop inbox conversation; it
// cannot push into a client chat that is already running. So every state says
// plainly whether any client received the message and what happens next.

export const CLIENT_LABELS = { claude_code: 'Claude Code', codex: 'Codex', cursor: 'Cursor', claude: 'Claude', other: 'Agent' };
const INBOX = 'sees it in its inbox when its next task starts (task-entry agent_messages or read_agent_messages) and answers with reply_agent_message. '
  + 'FULI cannot push a message into a client chat that is already running; ask the person to prompt that chat if it is urgent. '
  + 'Check later with get_agent_message_status.';

// Why no session was started, by recorded reason. Reasons not listed are wake failures.
const NOT_STARTED = {
  execution_claimed: ({ name, blockedBy }) => `FULI started no session: an earlier message to ${name}`
    + (blockedBy?.messageId ? ` (${blockedBy.messageId}${blockedBy.since ? `, since ${blockedBy.since}` : ''})` : '')
    + ' still owns its one wake, and FULI never runs two at once. A wake that nothing ends stops holding an hour after it began; send again then.',
  cleanup_unconfirmed: ({ name }) => `FULI started no session: ${name}'s previously woken process has not been confirmed to end.`,
  chat_waiting: ({ name }) => `FULI started no session: ${name} is already waiting in this chat.`,
  no_client: ({ name, clients }) => clients.length
    ? `FULI started no session: none of ${name}'s clients (${clients.map(clientName).join(', ')}) can be started on this computer.`
    : `FULI started no session: ${name} allows no client this computer can wake.`,
  no_working_directory: () => 'FULI started no session: no verified folder of the target project is known on this computer.',
  not_waiting: () => 'Sent without waiting, so FULI started no session.',
  nested_limit: () => 'FULI started no session: this thread already has asks waiting on each other.',
  task_context_required: ({ name }) => `FULI started no session: without the current taskContextToken it cannot wake ${name}.`
};

export function deliveryState({ reason = null, name, clients = [], blockedBy = null, toClient = null, toSession = null }) {
  if (reason === 'waiting_in_desktop_app') {
    return { delivery: 'desktop_conversation', ...(toClient ? { deliveredTo: { client: toClient, conversation: toSession } } : {}),
      guidance: `Handed to ${name}'s inbox conversation in the ${clientName(toClient)} app; its reply arrives in this thread. Check later with get_agent_message_status.` };
  }
  // The woken process may have read it before it stopped answering.
  if (reason === 'wake_timeout') {
    return { delivery: 'unconfirmed', guidance: `A woken ${clientName(toClient)} session of ${name} did not answer in time and may still be working. ${name} also ${INBOX}` };
  }
  const why = reason === null ? 'FULI has not started a session for it.'
    : NOT_STARTED[reason]?.({ name, clients, blockedBy }) ?? `Waking ${name} failed${reason ? ` (${reason})` : ''}, so no session holds this message.`;
  return { delivery: 'not_delivered', guidance: `No client has received this message. ${why} ${name} ${INBOX}` };
}

function clientName(client) {
  return CLIENT_LABELS[client] ?? client ?? 'desktop';
}
