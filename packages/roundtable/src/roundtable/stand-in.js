import { CLIENT_LABELS } from './delivery-state.js';

// The ladder's last tier (wake-ladder.js, rec#109): no session of the recipient
// could be brought in, so the sender's own session takes it on as a labelled
// 「代入」 (stand-in). It grants nothing: the session reads only the recipient's
// shareable index (the same one a `#FLG 一起看` session reads), and writes only
// to the roundtable: the stand-in's answer, recorded as the recipient's reply
// with the real executor, and a handback the recipient itself reads at its next
// task. Each FLA's own checkpoint keeps only its own work.

const STAND_IN_VIA = 'stand_in';
// The executor's model is what the client runs; FULI does not see it, and never guesses.
const UNKNOWN_MODEL = '-';

const STAND_IN_GUIDANCE = 'No session of this FLA could be brought in (see ladder), so this session stands in for it as 「代入」. '
  + 'Show the present line once. Prefix everything the stand-in says with speaker. Read only standIn.scope and the stand-in\'s own items on demand; '
  + 'never put your own private memory into its answer or its context into yours. Your checkpoint records only your own work. '
  + 'When it is done, call reply_agent_message(messageId, body = its increment: what it did, conclusions, blockers): FULI records that as its stand-in reply '
  + 'and hands it to the FLA for its next task. End the reply with standIn.receipt.markdown.';

export async function enterStandIn({ host, store, thread, ask, target, from, projectId, reason }) {
  store.updateMessage(ask.id, { status: 'stand_in', error: reason, toClient: from.client, toSession: from.session });
  let scope = null, scopeUnavailable = null;
  try {
    scope = await host.standInScope?.({ agentId: target.agentId, name: target.name, occupation: target.occupation,
      projectId, text: ask.body, client: from.client, sessionId: from.session }) ?? null;
  } catch (error) { scopeUnavailable = error.code ?? 'scope_unavailable'; }
  const executor = { client: from.client, session: from.session, model: UNKNOWN_MODEL };
  return { status: 'stand_in', threadId: thread.id, messageId: ask.id, reason,
    recipient: { agentId: target.agentId, name: target.name },
    standIn: {
      present: `在场：${from.name} & ${target.name}（代入）`,
      speaker: `【${target.name} · 代入】`,
      ...(scope ? { scope } : {}), ...(scopeUnavailable ? { scopeUnavailable } : {}),
      receipt: { identity: { agentId: target.agentId, name: target.name }, mode: STAND_IN_VIA, executor,
        markdown: `代入：${target.name}（实际执行：${clientName(from.client)} 本会话，模型 ${UNKNOWN_MODEL}；不是 ${target.name} 自己的客户端）` },
      guidance: STAND_IN_GUIDANCE } };
}

// The stand-in's answer, given by the session that stood in: the recipient's
// reply (the asker wrote it, so nothing waits in the asker's inbox) and the
// recipient's handback. Both name the real client and session.
export function recordStandInReply({ store, ask, executor, body, idFactory }) {
  const via = `${executor.client}:${STAND_IN_VIA}`;
  store.updateMessage(ask.id, { status: 'answered', via });
  const recipient = { agentId: ask.to_agent, name: ask.to_name };
  store.appendMessage(ask.thread_id, { id: idFactory(), kind: 'reply', body, status: 'sent', inReplyTo: ask.id, via,
    from: { ...recipient, client: executor.client, session: executor.session },
    to: { agentId: ask.from_agent, name: ask.from_name, client: ask.from_client, session: ask.from_session } });
  store.appendMessage(ask.thread_id, { id: idFactory(), kind: 'handback', body, status: 'sent', inReplyTo: ask.id, via,
    from: { agentId: ask.from_agent, name: ask.from_name, client: executor.client, session: executor.session },
    to: recipient, targetProjectId: ask.target_project_id, delivery: 'pending' });
  return { status: 'sent', threadId: ask.thread_id, standIn: true };
}

// What get_agent_message_status says about an ask a session stands in for.
export function standInState(ask) {
  return { delivery: STAND_IN_VIA, guidance: `${ask.from_name}'s ${clientName(ask.to_client)} session is standing in for ${ask.to_name} (代入). `
    + `${ask.to_name} also sees it in its inbox and may answer first; the stand-in answers with reply_agent_message.` };
}

function clientName(client) {
  return CLIENT_LABELS[client] ?? client;
}
