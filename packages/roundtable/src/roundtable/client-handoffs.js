import { createHash, randomUUID } from 'node:crypto';

import { RoundtableError } from '../errors.js';

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 3;
const LAUNCH_CONFIRMATION_MS = 5 * 60_000;
const STATUS_TEXT = {
  opening: 'Opening requested · 正在请求启动',
  started: 'Conversation created · 会话已建立',
  saving: 'Saving the brief · 正在写入简报',
  sent: 'Brief saved to the conversation for its next turn · 简报已写入接收会话，等待下一轮处理',
  read: 'Recipient confirmed reading · 接收会话已确认阅读',
  launch_requested: 'Terminal launch requested · 已请求启动终端，接收状态未知',
  awaiting_user_launch: 'Brief saved. Open the CLI from the local console. · 简报已保存，请在本机控制台打开命令行客户端。',
  refused: 'Client refused the handoff · 客户端已拒绝交接',
  unconfirmed: 'Launch outcome unknown · 启动结果待确认'
};
const digest = fields => createHash('sha256').update(JSON.stringify(fields)).digest('hex');

// Use the ordinary roundtable thread and message so the person can see the
// sending session, target client, task text and delivery state together.
export function clientHandoffs({ store, spaceId, now }) {
  function receipt(row) {
    const expired = ['opening', 'started', 'saving'].includes(row.status) && now() - Date.parse(row.updated_at) >= LAUNCH_CONFIRMATION_MS;
    const status = expired ? (row.status === 'saving' || row.via === 'terminal' ? 'unconfirmed' : 'refused') : row.status;
    return { handoffId: row.id, threadId: row.thread_id, client: row.to_client, sessionId: row.to_session,
      sender: { agentId: row.from_agent, client: row.from_client, sessionId: row.from_session },
      sourceProjectId: store.getThread(row.thread_id).project_id, targetProjectId: row.target_project_id,
      cwd: row.handoffContext?.cwd ?? null, requestedModel: row.handoffContext?.requestedModel ?? null,
      actualModel: row.handoffContext?.actualModel ?? null, actualCwd: row.handoffContext?.actualCwd ?? null,
      wake: false, nextTurn: status === 'sent', delivery: ['sent', 'read'].includes(status) ? 'saved'
        : status === 'unconfirmed' || status === 'launch_requested' || status === 'saving' ? 'unknown' : 'not_saved',
      recipientAgentId: row.to_agent ?? null, method: row.via, status, read: status === 'read', message: STATUS_TEXT[status],
      reason: expired ? 'client_did_not_confirm' : row.error ?? null };
  }
  function find(id) {
    const row = store.getMessage(id);
    return row?.kind === 'client_handoff' && store.getThread(row.thread_id)?.space_id === spaceId() ? row : null;
  }
  const fail = (code, message, status) => { throw new RoundtableError(code, message, { status }); };
  return {
    receipt,
    claim(actor, { client, cwd, projectId, prompt, model, requestId, method }) {
      const id = digest([spaceId(), actor.client, actor.sessionId, actor.agentId, requestId]);
      const payload = digest([client, cwd, model, prompt]);
      return store.transaction(() => {
        const prior = find(id);
        if (prior) {
          if (prior.source_context_hash !== payload) fail('handoff_conflict',
            'This request already names a different handoff. 这个请求编号已经用于其他交接。', 409);
          return { fresh: false, receipt: receipt(prior) };
        }
        if (store.receivedClientHandoff(spaceId(), actor.client, actor.sessionId)) {
          fail('handoff_nested', 'Reply to the sending session to request another handoff. 请回复发起会话安排下一次交接。', 409);
        }
        const since = new Date(now() - WINDOW_MS).toISOString();
        if (store.clientHandoffCount(spaceId(), actor.client, actor.sessionId, since) >= MAX_PER_WINDOW) {
          fail('handoff_rate_limited', 'This session opened three handoffs in a minute. 请在一分钟后重试。', 429);
        }
        const thread = store.createThread({ id: randomUUID(), spaceId: spaceId(), projectId: actor.projectId,
          subject: `交接 / Handoff · ${client}` });
        const row = store.appendMessage(thread.id, { id, kind: 'client_handoff', status: 'opening', origin: 'client_handoff',
          body: JSON.stringify({ prompt, cwd, requestedModel: model }), targetProjectId: projectId,
          via: method, sourceContextHash: payload, from: { agentId: actor.agentId, client: actor.client, session: actor.sessionId },
          to: { client } });
        return { fresh: true, receipt: receipt(row) };
      });
    },
    update(id, values) {
      return store.transaction(() => {
        const row = find(id);
        if (values.runtime) store.recordHandoffRuntime(id, values.runtime);
        return receipt(row.status === 'read' ? row : store.updateMessage(id, values));
      });
    },
    terminal(id) {
      const row = find(id);
      if (row?.via !== 'terminal') fail('handoff_not_found', 'No terminal handoff. 找不到这次终端交接。', 404);
      const actor = { client: row.from_client, sessionId: row.from_session, agentId: row.from_agent,
        projectId: store.getThread(row.thread_id).project_id };
      return { actor, receipt: receipt(row), client: row.to_client, prompt: row.body,
        projectId: row.target_project_id, matches: cwd => digest([row.to_client, cwd, null, row.body]) === row.source_context_hash };
    },
    claimTerminal(id) {
      return store.transaction(() => {
        const row = find(id);
        if (row?.via !== 'terminal' || row.status !== 'awaiting_user_launch') return false;
        store.updateMessage(id, { status: 'opening' });
        return true;
      });
    },
    inspect(actor, id, acknowledge) {
      return store.transaction(() => {
        const row = find(id);
        const sender = row && row.from_client === actor.client && row.from_session === actor.sessionId && row.from_agent === actor.agentId;
        const recipient = row && row.to_client === actor.client && row.to_session && row.to_session === actor.sessionId
          && (!row.to_agent || row.to_agent === actor.agentId);
        if (!row || (acknowledge ? !recipient || !['saving', 'sent', 'unconfirmed', 'read'].includes(row.status) : !sender && !recipient)) {
          fail('handoff_not_found', 'No handoff for this session. 当前会话没有这条交接。', 404);
        }
        return receipt(acknowledge && row.status !== 'read' ? store.updateMessage(id, { status: 'read', toAgent: actor.agentId }) : row);
      });
    }
  };
}
