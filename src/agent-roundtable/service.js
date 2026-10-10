import { randomUUID } from 'node:crypto';

import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { WAKE_CLIENTS, resolveClientCommand, sessionWorkingDirectory, wakeAgent } from './wake.js';

const CLIENT_LABELS = { claude_code: 'Claude Code', codex: 'Codex', cursor: 'Cursor', claude: 'Claude', other: 'Agent' };
const THREAD_MESSAGE_LIMIT = 24;
const NESTED_ASK_LIMIT = 3;

// Agents talk to each other directly: an ask wakes the recipient in its own
// client and returns its answer, or waits in its inbox for its next task.
export function createAgentRoundtable({ app, openStore, wake = wakeAgent, idFactory = randomUUID,
  env = process.env, locateCwd = sessionWorkingDirectory, clientAvailable = (client) => Boolean(resolveClientCommand(client)) }) {
  const spaceId = () => app.config.personal.spaceId;
  // Opened on first use: most MCP processes never touch the roundtable.
  let opened = null;
  const store = new Proxy({}, { get: (_target, property) => (opened ??= openStore())[property] });

  async function sender({ taskContextToken, sourceApplication }) {
    if (!taskContextToken) return { agent: null, client: sourceApplication ?? 'other', session: null, projectId: null };
    const task = await app.taskContextRegistry.context(taskContextToken, sourceApplication);
    return { agent: task.projectAgentId ? await agentById(task.projectAgentId) : null,
      client: task.sourceApplication ?? sourceApplication, session: task.sessionId, projectId: task.personalProjectId };
  }

  async function agents() {
    return (await app.listProjectAgents({ personalSpaceId: spaceId() }))
      .filter((agent) => agent.profile.status === 'active');
  }
  async function agentById(agentId) {
    return (await agents()).find((agent) => agent.agentId === agentId) ?? null;
  }
  async function recipient(to) {
    const needle = String(to ?? '').trim().replace(/^@\{?|\}$/g, '');
    const all = await agents();
    const exact = all.find((agent) => agent.agentId === needle || agent.agentId === decodeURIComponent(needle));
    if (exact) return exact;
    const number = needle.match(/^(?:FLA\s*)?(\d{6,})$/i)?.[1];
    const numbered = number && all.find((agent) => agent.employeeNumber === number);
    if (numbered) return numbered;
    const named = all.filter((agent) => [agent.profile.displayName, agent.profile.name]
      .some((name) => name?.toLowerCase() === needle.toLowerCase()));
    if (named.length === 1) return named[0];
    throw validation(named.length
      ? `More than one Agent is named "${needle}"; use its agentId: ${named.map((agent) => agent.agentId).join(', ')}`
      : `No active Agent matches "${needle}". Call find_agents first.`);
  }

  async function conversations(agent, projectId) {
    const sessions = await app.personal.recentAgentSessions({ personalSpaceId: spaceId(), agentId: agent.agentId,
      personalProjectId: projectId ?? null, limit: 5 }).catch(() => []);
    return sessions.filter((session) => WAKE_CLIENTS.includes(session.source_application))
      .map((session) => ({ client: session.source_application, sessionId: session.session_id,
        projectId: session.personal_project_id, lastActive: session.last_active }));
  }

  async function findAgents({ query = null, personalProjectId = null } = {}) {
    const needle = query?.trim().toLowerCase();
    const matches = (await agents()).filter((agent) => !needle || [agent.agentId,
      agent.employeeNumber ? `FLA ${agent.employeeNumber}` : null, agent.profile.displayName,
      agent.profile.name, agent.profile.responsibility, ...(agent.profile.capabilities ?? [])]
      .some((value) => value?.toLowerCase().includes(needle)));
    return { agents: await Promise.all(matches.slice(0, 20).map(async (agent) => ({
      agentId: agent.agentId, employeeNumber: agent.employeeNumber, name: label(agent), responsibility: agent.profile.responsibility,
      clients: (agent.profile.allowedClients ?? []).filter((client) => WAKE_CLIENTS.includes(client)),
      recentConversations: await conversations(agent, personalProjectId)
    }))),
    guidance: 'message_agent sends to an Agent (optionally one of its recentConversations) and returns its answer.' };
  }

  // Ordered attempts: the chosen conversation (or the Agent's latest one), then a
  // fresh session with the Agent's memory in that client and in its other clients.
  async function deliveryTargets(agent, conversation, projectId, projectPath) {
    const allowed = (agent.profile.allowedClients ?? []).filter((client) => WAKE_CLIENTS.includes(client) && clientAvailable(client));
    const explicit = Boolean(conversation) && !['auto', 'new'].includes(conversation);
    let resumable = null;
    if (conversation !== 'new') {
      const known = await conversations(agent, null);
      const candidates = explicit
        ? known.filter((session) => session.sessionId === conversation)
        : known.filter((session) => !projectId || session.projectId === projectId);
      for (const session of candidates) {
        if (!allowed.includes(session.client)) continue;
        const cwd = locateCwd(session.client, session.sessionId);
        if (cwd) { resumable = { client: session.client, sessionId: session.sessionId, cwd }; break; }
      }
      if (explicit && !resumable) throw validation('That conversation cannot be resumed on this machine');
    }
    const freshClients = resumable
      ? [resumable.client, ...(explicit ? [] : allowed.filter((client) => client !== resumable.client))]
      : WAKE_CLIENTS.filter((client) => allowed.includes(client));
    const fresh = freshClients.map((client) => ({ client, sessionId: null,
      cwd: client === resumable?.client ? resumable.cwd : projectPath ?? resumable?.cwd ?? process.cwd() }));
    return resumable ? [resumable, ...fresh] : fresh;
  }

  async function messageAgent({ taskContextToken = null, sourceApplication, to, body, threadId = null,
    conversation = 'auto', wait = true, timeoutSeconds = 300, projectPath = null } = {}) {
    const from = await sender({ taskContextToken, sourceApplication });
    const target = await recipient(to);
    if (from.agent?.agentId === target.agentId && !threadId) throw validation('An Agent cannot open a thread with itself');
    let thread = threadId ? store.getThread(threadId) : null;
    if (threadId && (!thread || thread.space_id !== spaceId())) throw validation('Thread not found');
    const history = thread ? store.messages(thread.id) : [];
    if (history.length >= THREAD_MESSAGE_LIMIT) throw validation('This thread reached its message limit; start a new one');
    thread ??= store.createThread({ id: idFactory(), spaceId: spaceId(), projectId: from.projectId,
      subject: body.trim().split(/\r?\n/)[0].slice(0, 80) });
    const ask = store.appendMessage(thread.id, { id: idFactory(), kind: 'ask', body, status: 'queued',
      from: { agentId: from.agent?.agentId, name: from.agent ? label(from.agent) : CLIENT_LABELS[from.client] ?? from.client,
        client: from.client, session: from.session },
      to: { agentId: target.agentId, name: label(target) } });
    const nested = history.filter((message) => message.kind === 'ask' && message.status === 'delivering').length;
    if (!wait || nested >= NESTED_ASK_LIMIT) return queued(thread, ask, target, nested ? 'nested_limit' : 'not_waiting');
    if (!taskContextToken || !from.projectId) return queued(thread, ask, target, 'task_context_required');
    const attempts = await deliveryTargets(target, conversation, from.projectId, projectPath);
    if (!attempts.length) return queued(thread, ask, target, 'no_client');
    const prompt = wakePrompt({ thread, ask, target, senderName: ask.from_name, senderClient: from.client });
    const timeoutMs = Math.min(Math.max(timeoutSeconds, 30), 900) * 1000;
    const unusable = new Set();
    let failure = 'wake_failed';
    for (const delivery of attempts) {
      if (unusable.has(delivery.client)) continue;
      store.updateMessage(ask.id, { status: 'delivering', toClient: delivery.client, toSession: delivery.sessionId });
      let answer;
      let grant;
      try {
        grant = await app.personal.issueAgentDelegation({ personal_space_id: spaceId(),
          task_context_token: taskContextToken, source_application: from.client, agent_id: target.agentId,
          target_application: delivery.client,
          // Claude resumes into a fork with a new ID. Only Codex resumes in place.
          target_session_id: delivery.client === 'codex' ? delivery.sessionId : null,
          lifetime_seconds: timeoutMs / 1000 });
        answer = await wake({ client: delivery.client, sessionId: delivery.sessionId, cwd: delivery.cwd,
          timeoutMs, prompt, delegationToken: grant.token });
        const verified = answer.sessionId && await app.personal.verifyAgentDelegation({
          personal_space_id: spaceId(), token: grant.token, session_id: answer.sessionId });
        if (!verified?.redeemed) throw Object.assign(new Error('The receiving session did not restore the Agent'),
          { code: 'delegation_not_redeemed' });
      } catch (error) {
        failure = error.code ?? 'wake_failed';
        // A missing or logged-out client cannot answer from any session. A conversation
        // open in its app, or a sub-agent thread, still allows a new session.
        if (['client_login_required', 'client_unavailable'].includes(failure)) unusable.add(delivery.client);
        // A timeout already used the caller's wait.
        if (failure === 'wake_timeout') break;
        continue;
      } finally {
        // Even failed or timed-out attempts lose their authority. Expiry remains
        // the fail-closed backstop if the Provider is temporarily unreachable.
        if (grant?.token) await app.personal.revokeAgentDelegation({
          personal_space_id: spaceId(), token: grant.token }).catch(() => {});
      }
      const via = `${delivery.client}:${delivery.sessionId ? 'resume' : 'new'}`;
      store.updateMessage(ask.id, { status: 'answered', via });
      const reply = store.appendMessage(thread.id, { id: idFactory(), kind: 'reply', body: answer.body, status: 'sent',
        inReplyTo: ask.id, via, from: { agentId: target.agentId, name: label(target), client: delivery.client,
          session: answer.sessionId }, to: { agentId: from.agent?.agentId, name: ask.from_name, client: from.client, session: from.session } });
      return { status: 'answered', threadId: thread.id, messageId: ask.id, recipient: { agentId: target.agentId, name: label(target) },
        via, reply: reply.body };
    }
    store.updateMessage(ask.id, { status: 'queued', error: failure });
    return queued(thread, ask, target, failure);
  }

  async function readMessages({ taskContextToken, sourceApplication }) {
    const me = await sender({ taskContextToken, sourceApplication });
    if (!me.agent) return { messages: [] };
    return { messages: store.pendingFor(spaceId(), me.agent.agentId).map(inboxItem),
      guidance: 'Answer each with reply_agent_message.' };
  }

  async function replyMessage({ taskContextToken, sourceApplication, messageId, body }) {
    const me = await sender({ taskContextToken, sourceApplication });
    const ask = store.getMessage(messageId);
    if (!ask || ask.kind !== 'ask' || !me.agent || ask.to_agent !== me.agent.agentId) throw validation('No such message for this Agent');
    if (ask.status === 'answered') throw validation('This message was already answered');
    store.updateMessage(ask.id, { status: 'answered', via: `${me.client}:inbox` });
    store.appendMessage(ask.thread_id, { id: idFactory(), kind: 'reply', body, status: 'sent', inReplyTo: ask.id,
      via: `${me.client}:inbox`, from: { agentId: me.agent.agentId, name: label(me.agent), client: me.client, session: me.session },
      to: { agentId: ask.from_agent, name: ask.from_name, client: ask.from_client, session: ask.from_session } });
    return { status: 'sent', threadId: ask.thread_id };
  }

  function threads({ limit = 50 } = {}) {
    return { threads: store.listThreads(spaceId(), { limit }).map((thread) => {
      const messages = store.messages(thread.id);
      const people = new Map();
      for (const message of messages) {
        for (const [agentId, name, client] of [[message.from_agent, message.from_name, message.from_client], [message.to_agent, message.to_name, message.to_client]]) {
          const key = agentId ?? name;
          if (key && !people.has(key)) people.set(key, { agentId, name, client });
        }
      }
      const last = messages.at(-1);
      return { id: thread.id, subject: thread.subject, projectId: thread.project_id, updatedAt: thread.updated_at,
        messageCount: messages.length, participants: [...people.values()],
        waiting: messages.some((message) => message.kind === 'ask' && message.status !== 'answered'),
        last: last ? { from: last.from_name, body: last.body.slice(0, 160) } : null };
    }) };
  }

  function thread({ threadId }) {
    const record = store.getThread(threadId);
    if (!record || record.space_id !== spaceId()) throw validation('Thread not found');
    return { id: record.id, subject: record.subject, projectId: record.project_id, createdAt: record.created_at,
      messages: store.messages(record.id).map((message) => ({ id: message.id, kind: message.kind, status: message.status,
        body: message.body, inReplyTo: message.in_reply_to, via: message.via, error: message.error, createdAt: message.created_at,
        from: { agentId: message.from_agent, name: message.from_name, client: message.from_client },
        to: { agentId: message.to_agent, name: message.to_name, client: message.to_client } })) };
  }

  function taskEntryDelegation({ sessionId }) {
    // The public thread header is presentation only. The Provider validates this
    // process-local capability, including project, recipient, client and session.
    return env.FULI_ROUNDTABLE_DELEGATION
      ? { token: env.FULI_ROUNDTABLE_DELEGATION, sessionId: sessionId ?? null } : null;
  }

  return { findAgents, messageAgent, readMessages, replyMessage, threads, thread, taskEntryDelegation,
    pending: (agentId) => store.pendingFor(spaceId(), agentId).map(inboxItem),
    close: () => opened?.close() };
}

function queued(thread, ask, target, reason) {
  return { status: 'queued', threadId: thread.id, messageId: ask.id, reason,
    recipient: { agentId: target.agentId, name: label(target) },
    guidance: `${label(target)} will see this message when it next starts a task and answer with reply_agent_message.` };
}

function inboxItem(message) {
  return { messageId: message.id, threadId: message.thread_id, from: message.from_name,
    fromClient: message.from_client, body: message.body, createdAt: message.created_at };
}

function wakePrompt({ thread, target, senderName, senderClient, ask }) {
  return `@{${encodeURIComponent(target.agentId)}} [FULI 圆桌 · ${thread.id}]\n`
    + `${senderName}（${CLIENT_LABELS[senderClient] ?? senderClient}）发来消息：\n\n${ask.body}\n\n`
    + `请直接回答对方，你的最终回复会原样转达。需要再问其他 Agent 时，调用 message_agent 并带上 threadId="${thread.id}"。`;
}

function label(agent) {
  return agent.profile.displayName || agent.profile.name || agent.agentId;
}

function validation(message) {
  return new ApplicationError(ApplicationErrorCode.VALIDATION, message);
}
