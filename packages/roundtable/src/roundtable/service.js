import { waitForChatChange } from './chat-wait.js';
import { createHash, randomUUID } from 'node:crypto';
import { projectAddress, resolveProjectLead, verifiedProjectFolder } from './project-target.js';
import { observeReturnedMemory, taskContextHash } from './memory-observation.js';
import { createAgentChat } from './chat.js';
import { createGroupDiscussion } from './group-discussion.js';
import { createPersonConversation } from './person-conversation.js';
import { ATTENTION_REPLIES_GUIDANCE, createAttentionInbox } from './attention-inbox.js';
import { agentDiscoveryProfile, matchesAgentDiscovery } from './discovery.js';

import { RoundtableError } from '../errors.js';
import { assertRoundtableHost } from '../host.js';
import { WAKE_CLIENTS, resolveClientCommand, sessionWorkingDirectory, wakeAgent } from './wake.js';

const CLIENT_LABELS = { claude_code: 'Claude Code', codex: 'Codex', cursor: 'Cursor', claude: 'Claude', other: 'Agent' };
const THREAD_MESSAGE_LIMIT = 24;
const NESTED_ASK_LIMIT = 3;
const REMOTE_PENDING = new Set(['sent', 'queued', 'claimed', 'running']);
const REMOTE_FINAL = new Set(['answered', 'failed', 'cancelled', 'expired', 'unknown']);

// Agents talk to each other directly: an ask wakes the recipient in its own
// client and returns its answer, or waits in its inbox for its next task.
export function createAgentRoundtable({ host, peer = null, openStore, wake = wakeAgent, idFactory = randomUUID,
  env = process.env, locateCwd = sessionWorkingDirectory, clientAvailable = (client) => Boolean(resolveClientCommand(client)),
  // Boot-anchor evidence recorded with a cleanup hold. Production records none
  // (null) until a separately verified proof exists; release stays disabled.
  bootEvidence = async () => null, now = Date.now }) {
  assertRoundtableHost(host);
  const spaceId = () => host.spaceId();
  // Opened on first use: most MCP processes never touch the roundtable.
  let opened = null;
  const refreshes = new Map();
  let refreshOffset = 0;
  const store = new Proxy({}, { get: (_target, property) => (opened ??= openStore())[property] });

  async function sender({ taskContextToken, sourceApplication }) {
    if (!taskContextToken) return { agent: null, client: sourceApplication ?? 'other', session: null, projectId: null };
    const task = await host.taskContext(taskContextToken, sourceApplication);
    return { agent: task.projectAgentId ? await agentById(task.projectAgentId) : null,
      client: task.sourceApplication ?? sourceApplication, session: task.sessionId, projectId: task.personalProjectId };
  }

  async function agents() {
    return (await host.listAgents())
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

  // An Agent addressed by ID who works only in another project is a cross-project
  // ask to that project (the Provider still admits only its lead). Several
  // possible projects must be named; Agents without a project keep the sender's.
  function agentProjectOutsideSender(agent, from) {
    if (!from.projectId) return null;
    const active = (agent.assignments ?? []).filter(assignment => assignment.status === 'active')
      .map(assignment => assignment.personalProjectId);
    const projects = [...new Set(active.length ? active : [agent.personalProjectId].filter(Boolean))];
    if (!projects.length || projects.includes(from.projectId)) return null;
    if (projects.length > 1) {
      throw validation(`${label(agent)} works in several projects; address one as project:<projectId> (${projects.join(', ')})`);
    }
    return projects[0];
  }

  async function conversations(agent, projectId) {
    const sessions = await host.recentSessions({ agentId: agent.agentId, projectId: projectId ?? null, limit: 5 })
      .catch(() => []);
    return sessions.filter((session) => WAKE_CLIENTS.includes(session.client));
  }

  // A host that knows the person's own names for work (project names, standing
  // assignments) matches the query against them; Roundtable only places the
  // leads it names. Asked for one project, only that project's work counts.
  // A host that cannot match leaves the directory's answer as it is and names
  // why, as an unreachable peer does.
  async function workMatches(query, personalProjectId) {
    const work = new Map();
    if (!query || !host.matchWork) return { work };
    let found;
    try { found = await host.matchWork(query); }
    catch (error) { return { work, workUnavailable: error.code ?? 'work_match_failed' }; }
    for (const { agentId, ...match } of found) {
      if (personalProjectId && match.projectId !== personalProjectId) continue;
      work.set(agentId, [...(work.get(agentId) ?? []), match]);
    }
    return { work };
  }

  async function findAgents({ query = null, personalProjectId = null, occupation = null, capability = null, projectId = null } = {}) {
    const project = personalProjectId ? await resolveProjectLead(host, personalProjectId) : null;
    const needle = query?.trim().toLowerCase();
    const { work, workUnavailable } = await workMatches(query?.trim(), personalProjectId);
    const names = (agent) => [agent.agentId, agent.employeeNumber ? `FLA ${agent.employeeNumber}` : null,
      agent.profile.displayName, agent.profile.name];
    const matches = (project ? (project.agent ? [project.agent] : []) : await agents()).filter((agent) => matchesAgentDiscovery(agentDiscoveryProfile(agent), { occupation, capability, projectId })
      && (!needle || work.has(agent.agentId) || [...names(agent), agent.profile.responsibility, ...(agent.profile.capabilities ?? [])]
        .some((value) => value?.toLowerCase().includes(needle))));
    // An exact name still comes first, then the leads the person's work names;
    // without work matches the directory's order stays as it is.
    const rank = (agent) => [...names(agent), agent.employeeNumber].some((name) => name?.toLowerCase() === needle) ? 0
      : work.has(agent.agentId) ? 1 : 2;
    if (work.size) matches.sort((a, b) => rank(a) - rank(b));
    const local = await Promise.all(matches.slice(0, 20).map(async (agent) => ({
      agentId: agent.agentId, employeeNumber: agent.employeeNumber, name: label(agent), responsibility: agent.profile.responsibility,
      ...(work.has(agent.agentId) ? { matchedWork: work.get(agent.agentId) } : {}),
      ...agentDiscoveryProfile(agent),
      clients: (agent.profile.allowedClients ?? []).filter((client) => WAKE_CLIENTS.includes(client)),
      recentConversations: await conversations(agent, personalProjectId)
    })));
    const remote = peer ? await peer.remoteAgents({ query: needle, occupation, capability, projectId }).catch(() => null) : null;
    return { agents: local, ...(workUnavailable ? { workUnavailable } : {}),
      ...(project ? { project: { projectId: personalProjectId, address: `project:${personalProjectId}`, reason: project.reason } } : {}),
      ...(remote ? { remoteAgents: remote.agents, ...(remote.unavailable ? { remoteUnavailable: remote.unavailable } : {}) } : {}),
      guidance: remote
        ? 'message_agent sends to an Agent (optionally one of its recentConversations) and returns its answer. remoteAgents run on other paired devices (LAN roundtable Beta): address them by their exact address, from an active project task. Only each shared project\'s lead can be asked. Use get_agent_message_status for a pending reply.'
        : 'message_agent sends to an Agent (optionally one of its recentConversations) and returns its answer.' };
  }

  // Ordered attempts: the chosen conversation (or the Agent's latest one), then a
  // fresh session with the Agent's memory in that client and in its other clients.
  async function deliveryTargets(agent, conversation, projectId, projectPath, { clients = null, freshCwd = null, strictCwd = false } = {}) {
    const allowed = (agent.profile.allowedClients ?? []).filter((client) => WAKE_CLIENTS.includes(client)
      && (!clients || clients.includes(client)) && clientAvailable(client));
    const explicit = Boolean(conversation) && !['auto', 'new'].includes(conversation);
    let resumable = null;
    if (conversation !== 'new') {
      const known = await conversations(agent, null);
      const candidates = explicit
        ? known.filter((session) => session.sessionId === conversation && (!strictCwd || session.projectId === projectId))
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
    // A strict delivery only starts new sessions in a folder known for this project.
    const strictFolder = strictCwd ? freshCwd ?? resumable?.cwd ?? await projectFolder(agent, projectId) : null;
    if (strictCwd && !strictFolder) return resumable ? [resumable] : [];
    const fresh = freshClients.map((client) => ({ client, sessionId: null,
      cwd: client === resumable?.client ? resumable.cwd
        : strictCwd ? strictFolder : freshCwd ?? projectPath ?? resumable?.cwd ?? process.cwd() }));
    return resumable ? [resumable, ...fresh] : fresh;
  }

  async function projectFolder(agent, projectId) {
    for (const session of await conversations(agent, projectId)) {
      if (session.projectId !== projectId) continue;
      const cwd = locateCwd(session.client, session.sessionId);
      if (cwd) return cwd;
    }
    // A host that records each project's folder answers when no session does.
    return await host.projectFolder?.(projectId) ?? null;
  }

  // Tries each target until one answers as the restored Agent. The grant is the
  // only authority the woken session receives and is revoked after every attempt.
  async function deliver({ ask, attempts, prompt, timeoutMs, issueGrant, signal, onSpawn, peerDepth, oneGrant = false,
    readOnly = false }) {
    const unusable = new Set();
    let failure = 'wake_failed';
    let cleanup = null;
    for (const delivery of attempts) {
      if (unusable.has(delivery.client)) continue;
      if (signal?.aborted) { failure = 'cancelled'; break; }
      store.updateMessage(ask.id, { status: 'delivering', toClient: delivery.client, toSession: delivery.sessionId });
      let answer;
      let grant;
      try {
        grant = await issueGrant(delivery, timeoutMs / 1000);
        answer = await wake({ client: delivery.client, sessionId: delivery.sessionId, cwd: delivery.cwd,
          timeoutMs, prompt, delegationToken: grant.token, peerDepth, signal, onSpawn, readOnly,
          onSession: session => host.sealDelegation({ token: grant.token, sessionId: session }) });
        const verified = answer.sessionId && await host.verifyDelegation({ token: grant.token, sessionId: answer.sessionId });
        if (!verified?.redeemed) throw Object.assign(new Error('The receiving session did not restore the Agent'),
          { code: 'delegation_not_redeemed' });
        store.recordMemoryResult(ask.id, verified.memoryResultCount ?? 0);
      } catch (error) {
        failure = error.code ?? 'wake_failed';
        // A process that may still be running must not get a sibling on another channel.
        if (error.cleanup) {
          cleanup = error.cleanup;
          store.setCleanup(ask.id, cleanup, await bootEvidence().catch(() => null));
          break;
        }
        // A missing or logged-out client cannot answer from any session. A conversation
        // open in its app, or a sub-agent thread, still allows a new session.
        if (['client_login_required', 'client_unavailable'].includes(failure)) unusable.add(delivery.client);
        // A timeout already used the caller's wait; a cancellation ends the delivery.
        if (failure === 'wake_timeout' || failure === 'cancelled') break;
        // A remote attempt receives authority once; a second channel would only be
        // refused and hide why the first one failed.
        if (oneGrant) break;
        continue;
      } finally {
        // Even failed or timed-out attempts lose their authority. Expiry remains
        // the fail-closed backstop if the Provider is temporarily unreachable.
        if (grant?.token) await host.revokeDelegation({ token: grant.token }).catch(() => {});
      }
      return { answer, delivery, via: `${delivery.client}:${delivery.sessionId ? 'resume' : 'new'}` };
    }
    throw Object.assign(new Error('No client answered'), { code: failure, ...(cleanup ? { cleanup } : {}) });
  }

  // While an earlier wake of this Agent may still be running, no new one starts.
  // The claim is durable and atomic across coordinators; it ends only when the
  // owned process was observed to end (or never started), not on reply/cancel.
  function finishWake(ask, error = null) {
    if (!error?.cleanup) store.finishExecution(ask.id);
  }

  async function messageAgent({ taskContextToken = null, sourceApplication, to, body, threadId = null,
    conversation = 'auto', wait = true, timeoutSeconds = 300, projectPath = null, roundtableProjectId = null, signal, chatWakeChatId = null, chatWake = null,
    // readOnly: a group discussion turn, woken where it can change nothing (wake adapters).
    readOnly = false } = {}) {
    if (roundtableProjectId && peer?.isRemoteAddress(to)) throw validation('This scoped consultation cannot leave its project');
    if (peer?.isRemoteAddress(to)) {
      return messageRemote({ taskContextToken, sourceApplication, to, body, threadId, conversation, wait, timeoutSeconds, chatWake, signal });
    }
    const from = await sender({ taskContextToken, sourceApplication });
    const projectId = projectAddress(to);
    if (roundtableProjectId && (from.projectId !== roundtableProjectId || (projectId && projectId !== roundtableProjectId))) {
      throw validation('This scoped consultation cannot leave its project');
    }
    const resolved = projectId ? await resolveProjectLead(host, projectId, { source: from, recruit: true }) : null;
    if (resolved && !resolved.agent) return { status: 'queued', reason: resolved.reason, targetProjectId: projectId };
    const target = resolved?.agent ?? await recipient(to);
    const targetProjectId = projectId ?? agentProjectOutsideSender(target, from) ?? from.projectId;
    const crossProject = Boolean(targetProjectId && from.projectId && targetProjectId !== from.projectId);
    if (from.agent?.agentId === target.agentId && !crossProject && !threadId) throw validation('An Agent cannot open a thread with itself');
    const { thread, history } = openThread(threadId, from.projectId, body);
    const ask = store.appendMessage(thread.id, { id: idFactory(), kind: 'ask', body, status: 'queued',
      from: { agentId: from.agent?.agentId, name: from.agent ? label(from.agent) : CLIENT_LABELS[from.client] ?? from.client,
        client: from.client, session: from.session },
      to: { agentId: target.agentId, name: label(target) }, targetProjectId,
      sourceContextHash: taskContextToken ? taskContextHash(taskContextToken) : null });
    // The source token never enters the communication log.
    const nested = history.filter((message) => message.kind === 'ask' && message.status === 'delivering').length;
    if (!wait || nested >= NESTED_ASK_LIMIT) return queued(thread, ask, target, nested ? 'nested_limit' : 'not_waiting');
    if (!taskContextToken || !from.projectId) return queued(thread, ask, target, 'task_context_required');
    const woken = await wakeAsk({ thread, ask, target, chatWakeChatId, signal, readOnly,
      timeoutMs: Math.min(Math.max(timeoutSeconds, 30), 900) * 1000,
      targets: async () => deliveryTargets(target, conversation, targetProjectId, crossProject ? null : projectPath,
        crossProject ? { strictCwd: true, freshCwd: await verifiedProjectFolder(host, targetProjectId, projectPath) } : {}),
      noTargets: () => crossProject && WAKE_CLIENTS.some(client => target.profile.allowedClients.includes(client) && clientAvailable(client))
        ? 'no_working_directory' : 'no_client',
      prompt: wakePrompt({ thread, ask, target, senderName: ask.from_name, senderClient: from.client,
        targetProjectId: crossProject ? targetProjectId : null }),
      issueGrant: (delivery, lifetime) => host.issueDelegation({ taskContextToken, client: from.client,
        agentId: target.agentId, ...(crossProject ? { targetProjectId } : {}), targetClient: delivery.client,
        // Claude resumes into a fork with a new ID. Only Codex resumes in place.
        targetSessionId: delivery.client === 'codex' ? delivery.sessionId : null,
        lifetimeSeconds: lifetime }),
      replyTo: { agentId: from.agent?.agentId, name: ask.from_name, client: from.client, session: from.session } });
    if (woken.status !== 'answered') return { ...queued(thread, ask, target, woken.reason), ...cleanupView(woken.cleanup) };
    const observation = await observeReturnedMemory(host, store, { ask, reply: woken.reply, from, taskContextToken });
    return { status: 'answered', threadId: thread.id, messageId: ask.id, recipient: { agentId: target.agentId, name: label(target) },
      ...(observation ? { memoryObservation: observation } : {}),
      via: woken.via, reply: woken.reply.body };
  }

  // The one way an ask wakes its recipient, whoever sent it: a durable execution
  // claim, the recipient's own clients in order, a per-attempt grant, and only a
  // verified answer becomes its reply. An ask that is not answered stays queued
  // with the reason, so the recipient still sees it when it next works.
  async function wakeAsk({ thread, ask, target, targets, noTargets, prompt, timeoutMs, signal, issueGrant, replyTo,
    chatWakeChatId = null, readOnly = false }) {
    const claim = store.claimExecution(spaceId(), target.agentId, ask.id, { chatWakeChatId });
    if (!claim.claimed) return { status: 'queued', reason: claim.reason };
    let attempts;
    try { attempts = await targets(); }
    catch (error) { finishWake(ask); throw error; }
    if (!attempts.length) { finishWake(ask); return { status: 'queued', reason: noTargets() }; }
    try {
      const { answer, delivery, via } = await deliver({ ask, attempts, prompt, timeoutMs, signal, readOnly, issueGrant });
      finishWake(ask);
      store.updateMessage(ask.id, { status: 'answered', via });
      const reply = store.appendMessage(thread.id, { id: idFactory(), kind: 'reply', body: answer.body, status: 'sent',
        inReplyTo: ask.id, via, from: { agentId: target.agentId, name: label(target), client: delivery.client,
          session: answer.sessionId }, to: replyTo });
      return { status: 'answered', reply, via };
    } catch (error) {
      finishWake(ask, error);
      store.updateMessage(ask.id, { status: 'queued', error: error.code ?? 'wake_failed' });
      return { status: 'queued', reason: error.code ?? 'wake_failed', cleanup: error.cleanup ?? null };
    }
  }

  function openThread(threadId, projectId, body) {
    let thread = threadId ? store.getThread(threadId) : null;
    if (threadId && (!thread || thread.space_id !== spaceId())) throw validation('Thread not found');
    if (thread && thread.project_id !== projectId) throw validation('This thread belongs to another project');
    const history = thread ? store.messages(thread.id) : [];
    if (history.length >= THREAD_MESSAGE_LIMIT) throw validation('This thread reached its message limit; start a new one');
    thread ??= store.createThread({ id: idFactory(), spaceId: spaceId(), projectId,
      subject: body.trim().split(/\r?\n/)[0].slice(0, 80) });
    return { thread, history };
  }

  // A remote ask is signed by this device for one verified local task. The task
  // token itself never leaves this computer.
  async function messageRemote({ taskContextToken, sourceApplication, to, body, threadId, conversation, wait, timeoutSeconds, chatWake, signal }) {
    if (!['auto', 'new'].includes(conversation ?? 'auto')) throw validation('Remote Agents accept conversation "auto" or "new"');
    const from = await sender({ taskContextToken, sourceApplication });
    if (!from.agent || !from.projectId) throw validation('A remote message must come from an active project task of a FULI Agent; pass taskContextToken');
    const target = await peer.resolveRemote(to);
    const { thread } = openThread(threadId, from.projectId, body);
    if (thread.project_id !== from.projectId) throw validation('This thread belongs to another project');
    const ask = store.appendMessage(thread.id, { id: idFactory(), kind: 'ask', body, status: 'sent', via: 'peer',
      from: { agentId: from.agent.agentId, name: label(from.agent), client: from.client, session: from.session },
      to: { agentId: target.address, name: `${target.name} · ${target.deviceName}` } });
    if (chatWake) {
      const claim = store.claimExecution(spaceId(), target.address, ask.id);
      if (!claim.claimed) {
        store.updateMessage(ask.id, { status: 'failed', error: claim.reason });
        return { status: 'queued', reason: claim.reason, threadId: thread.id, messageId: ask.id };
      }
    }
    let state;
    try {
      state = await peer.send({ messageId: ask.id, threadId: thread.id, target, body,
        ...(chatWake ? { chatWake } : {}), conversation: conversation ?? 'auto', depth: peerDepth(env) + 1, taskContextToken, sourceApplication: from.client,
        from: { agentId: from.agent.agentId, name: label(from.agent), client: from.client } });
    } catch (error) {
      store.updateMessage(ask.id, { status: 'failed', error: error.code ?? 'peer_send_failed' });
      // A rejected request did not start. Transport ambiguity retains the claim.
      if (chatWake && error.status >= 400 && error.status < 500 && error.code !== 'aborted') store.finishExecution(ask.id);
      throw error;
    }
    if (wait) state = await peer.waitFor(ask.id, Math.min(Math.max(timeoutSeconds, 30), 900) * 1000, { signal });
    return remoteView(applyRemote(ask.id, state));
  }

  function applyRemote(messageId, state) {
    const ask = store.getMessage(messageId);
    if (!ask || !state || !REMOTE_PENDING.has(ask.status)) return ask;
    const status = state.status === 'queued' ? 'sent' : state.status;
    if (status === 'answered' && state.reply) {
      store.updateMessage(ask.id, { status: 'answered', via: state.via ?? 'peer' });
      store.appendMessage(ask.thread_id, { id: idFactory(), kind: 'reply', body: state.reply, status: 'sent', inReplyTo: ask.id,
        via: state.via ?? 'peer', from: { agentId: ask.to_agent, name: ask.to_name, client: state.via?.split(':')[0] ?? null },
        to: { agentId: ask.from_agent, name: ask.from_name, client: ask.from_client, session: ask.from_session } });
    } else if (status !== ask.status) {
      store.updateMessage(ask.id, { status, error: state.error ?? null });
    }
    if (REMOTE_FINAL.has(status) && status !== 'unknown' && state.cleanup?.status !== 'unconfirmed') store.finishExecution(ask.id);
    // The peer port already bounded it; only an unanswered remote run can leave one.
    if (status !== 'answered' && state.cleanup?.status === 'unconfirmed') store.setCleanup(ask.id, state.cleanup);
    return store.getMessage(ask.id);
  }

  function remoteView(ask) {
    const reply = ask.status === 'answered'
      ? store.messages(ask.thread_id).find((message) => message.in_reply_to === ask.id) : null;
    return { status: ask.status === 'sent' ? 'queued' : ask.status, threadId: ask.thread_id, messageId: ask.id,
      recipient: { agentId: ask.to_agent, name: ask.to_name }, remote: true,
      ...(reply ? { reply: reply.body, via: reply.via } : {}), ...(ask.error ? { reason: ask.error } : {}),
      ...cleanupView(storedCleanup(ask)),
      ...(REMOTE_FINAL.has(ask.status) ? {} : { guidance: 'The remote device has not answered yet. Check later with get_agent_message_status; it does not mean the work ran.' }),
      ...(ask.status === 'unknown' ? { guidance: 'The remote device lost track of this attempt; it may or may not have run. It is not retried automatically.' } : {}) };
  }

  // Runs on the receiving device for one claimed, locally authorized remote ask.
  async function answerRemote({ claim, share, prompt: promptOverride = null, issueGrant, signal, onSpawn, timeoutMs }) {
    const { assertion, sender: device } = claim;
    if (share.spaceId !== spaceId()) throw Object.assign(new Error('The share belongs to another space'), { code: 'share_unavailable' });
    const target = await agentById(share.agentId);
    if (!target) throw Object.assign(new Error('The shared Agent is no longer active'), { code: 'agent_unavailable' });
    // Remote IDs are only meaningful together with their device and this share,
    // so they never address an existing local row.
    const scope = [device.nodeId, share.spaceId, share.projectId, share.bindingId, share.agentId];
    const threadId = remoteRowId('thread', [...scope, assertion.threadId]);
    const askId = remoteRowId('ask', [...scope, assertion.messageId]);
    if (store.getMessage(askId)) {
      throw Object.assign(new Error('This remote message was already delivered here'), { code: 'already_delivered' });
    }
    const thread = store.getThread(threadId) ?? store.createThread({ id: threadId, spaceId: share.spaceId,
      projectId: share.projectId, subject: assertion.body.trim().split(/\r?\n/)[0].slice(0, 80) });
    const ask = store.appendMessage(thread.id, { id: askId, kind: 'ask',
      body: assertion.body, status: 'delivering', via: 'peer',
      from: { agentId: `peer:${device.nodeId.slice(0, 16)}:${assertion.from.agentId}`, name: `${assertion.from.name} · ${device.name}`,
        client: assertion.from.client ?? 'other' },
      to: { agentId: target.agentId, name: label(target) } });
    const execution = store.claimExecution(share.spaceId, target.agentId, ask.id);
    if (!execution.claimed) {
      store.updateMessage(ask.id, { status: 'failed', error: execution.reason });
      throw Object.assign(new Error('An earlier run of this Agent may still be running on this device'), { code: execution.reason });
    }
    let attempts;
    try {
      attempts = await deliveryTargets(target, assertion.conversation, share.projectId, null,
        { clients: share.clients, freshCwd: share.workingDirectory ?? null, strictCwd: true });
    } catch (error) { finishWake(ask); throw error; }
    if (!attempts.length) {
      finishWake(ask);
      const code = share.clients.some((client) => clientAvailable(client)) ? 'no_working_directory' : 'no_client';
      store.updateMessage(ask.id, { status: 'failed', error: code });
      throw Object.assign(new Error(code === 'no_working_directory'
        ? 'This shared project has no known folder on this device; the owner sets one in Settings'
        : 'No shared client can run on this device'), { code });
    }
    const prompt = promptOverride ?? wakePrompt({ thread, ask, target, senderName: ask.from_name, senderClient: ask.from_client });
    try {
      const { answer, delivery, via } = await deliver({ ask, attempts, prompt, timeoutMs, issueGrant, signal, onSpawn,
        peerDepth: assertion.depth, oneGrant: true });
      finishWake(ask);
      store.updateMessage(ask.id, { status: 'answered', via });
      store.appendMessage(thread.id, { id: idFactory(), kind: 'reply', body: answer.body, status: 'sent', inReplyTo: ask.id, via,
        from: { agentId: target.agentId, name: label(target), client: delivery.client, session: answer.sessionId },
        to: { agentId: ask.from_agent, name: ask.from_name, client: ask.from_client } });
      return { body: answer.body, via, sessionId: answer.sessionId };
    } catch (error) {
      finishWake(ask, error);
      store.updateMessage(ask.id, { status: error.code === 'cancelled' ? 'cancelled' : 'failed', error: error.code ?? 'wake_failed' });
      throw error;
    }
  }

  async function messageStatus({ taskContextToken, sourceApplication, messageId }) {
    const me = await sender({ taskContextToken, sourceApplication });
    const ask = taskScopedAsk(me, messageId);
    if (![ask.from_agent, ask.to_agent].includes(me.agent.agentId)) throw validation('No such message for this Agent');
    const result = await statusOf(ask);
    const reply = store.messages(ask.thread_id).find(message => message.in_reply_to === ask.id);
    const observation = await observeReturnedMemory(host, store, { ask: store.getMessage(ask.id), reply, from: me, taskContextToken });
    return { ...result, ...(observation ? { memoryObservation: observation } : {}) };
  }

  async function statusOf(ask) {
    if (REMOTE_PENDING.has(ask.status) && peer?.hasSent(ask.id)) {
      const state = await peer.status(ask.id).catch(() => null);
      return remoteView(applyRemote(ask.id, state) ?? ask);
    }
    if (ask.via === 'peer' || peer?.hasSent(ask.id)) return remoteView(ask);
    const reply = store.messages(ask.thread_id).find((message) => message.in_reply_to === ask.id);
    return { status: ask.status, threadId: ask.thread_id, messageId: ask.id,
      recipient: { agentId: ask.to_agent, name: ask.to_name }, ...(reply ? { reply: reply.body, via: reply.via } : {}),
      ...(ask.error ? { reason: ask.error } : {}), ...cleanupView(storedCleanup(ask)) };
  }

  async function cancelMessage({ taskContextToken, sourceApplication, messageId }) {
    const me = await sender({ taskContextToken, sourceApplication });
    const ask = taskScopedAsk(me, messageId);
    if (ask.from_agent !== me.agent.agentId) throw validation('No such message sent by this Agent');
    return cancelAsk(ask);
  }

  // The same Agent ID can work in several projects; a task only reaches its own project's messages.
  function taskScopedAsk(me, messageId) {
    const ask = store.getMessage(messageId);
    const thread = ask && store.getThread(ask.thread_id);
    if (!ask || ask.kind !== 'ask' || !me.agent || !me.projectId || thread?.space_id !== spaceId()
      || !((ask.from_agent === me.agent.agentId && thread.project_id === me.projectId)
        || (ask.to_agent === me.agent.agentId && messageProject(ask) === me.projectId))) {
      throw validation('No such message for this Agent in the current project');
    }
    return ask;
  }

  async function cancelAsk(ask) {
    if (peer?.hasSent(ask.id)) {
      if (!REMOTE_PENDING.has(ask.status)) return remoteView(ask);
      return remoteView(applyRemote(ask.id, await peer.cancel(ask.id)));
    }
    if (ask.status === 'queued') store.updateMessage(ask.id, { status: 'cancelled', error: 'cancelled' });
    else if (ask.status === 'delivering') throw validation('This message is being answered in another process; it ends at its timeout');
    return statusOf(store.getMessage(ask.id));
  }

  // The local owner can inspect and cancel any message from the console.
  function ownedAsk(messageId) {
    const ask = store.getMessage(messageId);
    const thread = ask && store.getThread(ask.thread_id);
    if (!ask || ask.kind !== 'ask' || thread?.space_id !== spaceId()) throw validation('Message not found');
    return ask;
  }

  async function readMessages({ taskContextToken, sourceApplication }) {
    const me = await sender({ taskContextToken, sourceApplication });
    if (!me.agent) return { messages: [] };
    const attentionReplies = me.projectId ? attentionInbox.read(me.agent.agentId, me.projectId) : [];
    return { messages: store.pendingFor(spaceId(), me.agent.agentId)
      .filter(message => messageProject(message) === me.projectId).map(inboxItem),
      guidance: 'Answer each with reply_agent_message.',
      ...(attentionReplies.length ? { attentionReplies, attentionRepliesGuidance: ATTENTION_REPLIES_GUIDANCE } : {}) };
  }

  async function replyMessage({ taskContextToken, sourceApplication, messageId, body }) {
    const me = await sender({ taskContextToken, sourceApplication });
    const ask = store.getMessage(messageId);
    if (!ask || ask.kind !== 'ask' || !me.agent || ask.to_agent !== me.agent.agentId
        || messageProject(ask) !== me.projectId) throw validation('No such message for this Agent');
    if (ask.target_project_id && ask.target_project_id !== store.getThread(ask.thread_id)?.project_id) {
      if (await host.projectLeadId(ask.target_project_id) !== me.agent.agentId) throw validation('The target project lead changed');
    }
    if (ask.status === 'answered') throw validation('This message was already answered');
    if (ask.from_agent?.startsWith('peer:')) throw validation('A remote device message is answered by its delivery, not from the inbox');
    store.updateMessage(ask.id, { status: 'answered', via: `${me.client}:inbox` });
    store.appendMessage(ask.thread_id, { id: idFactory(), kind: 'reply', body, status: 'sent', inReplyTo: ask.id,
      via: `${me.client}:inbox`, from: { agentId: me.agent.agentId, name: label(me.agent), client: me.client, session: me.session },
      to: { agentId: ask.from_agent, name: ask.from_name, client: ask.from_client, session: ask.from_session } });
    return { status: 'sent', threadId: ask.thread_id };
  }

  function refreshRemote({ threadId = null } = {}) {
    if (!peer) return Promise.resolve();
    const key = threadId ?? 'directory';
    if (refreshes.has(key)) return refreshes.get(key);
    const records = threadId ? [store.getThread(threadId)] : store.listThreads(spaceId(), { limit: 200 });
    const pending = records.filter((record) => record?.space_id === spaceId()).flatMap((record) => store.messages(record.id))
      .filter((message) => message.kind === 'ask' && REMOTE_PENDING.has(message.status) && peer.hasSent(message.id));
    const start = pending.length && !threadId ? refreshOffset % pending.length : 0;
    const batch = [...pending.slice(start), ...pending.slice(0, start)].slice(0, 20);
    if (!threadId) refreshOffset += batch.length;
    // A shared deadline bounds the whole console refresh even with many offline asks.
    const signal = AbortSignal.timeout(2_000);
    const work = Promise.all(Array.from({ length: Math.min(4, batch.length) }, async () => {
      while (batch.length && !signal.aborted) {
        const message = batch.shift();
        try { applyRemote(message.id, await peer.status(message.id, { signal, timeoutMs: 2_000 })); }
        catch { /* Keep the last known result when the other computer is unavailable. */ }
      }
    })).finally(() => refreshes.delete(key));
    refreshes.set(key, work);
    return work;
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
      const open = messages.filter((message) => message.kind === 'ask' && !REMOTE_FINAL.has(message.status));
      return { id: thread.id, subject: thread.subject, projectId: thread.project_id, updatedAt: thread.updated_at,
        messageCount: messages.length, participants: [...people.values()],
        waiting: open.length > 0,
        // Who the open asks are addressed to, so the list never shows a bare "waiting".
        waitingFor: [...new Set(open.map((message) => message.to_name).filter(Boolean))],
        last: last ? { from: last.from_name, body: last.body.slice(0, 160) } : null };
    }) };
  }

  function thread({ threadId }) {
    const record = store.getThread(threadId);
    if (!record || record.space_id !== spaceId()) throw validation('Thread not found');
    return { id: record.id, subject: record.subject, projectId: record.project_id, createdAt: record.created_at,
      messages: store.messages(record.id).map((message) => ({ id: message.id, kind: message.kind, status: message.status,
        body: message.body, inReplyTo: message.in_reply_to, via: message.via, error: message.error,
        ...cleanupView(storedCleanup(message)), createdAt: message.created_at,
        from: { agentId: message.from_agent, name: message.from_name, client: message.from_client },
        to: { agentId: message.to_agent, name: message.to_name, client: message.to_client } })) };
  }

  function taskEntryDelegation({ sessionId }) {
    // The public thread header is presentation only. The Provider validates this
    // process-local capability, including project, recipient, client and session.
    return env.FULI_ROUNDTABLE_DELEGATION
      ? { token: env.FULI_ROUNDTABLE_DELEGATION, sessionId: sessionId ?? null } : null;
  }

  const messageProject = message => message.target_project_id ?? store.getThread(message.thread_id)?.project_id ?? null;
  const attentionInbox = createAttentionInbox({ store, spaceId });
  // False when an earlier run of this Agent may still be running (a cleanup hold).
  const waitUntilIdle = async (agentId, signal) => {
    const state = await waitForChatChange(() => store.executionState(spaceId(), agentId),
      { store: store.chat, signal, ready: state => state.held || !state.busy });
    return !state.held;
  };
  const wakeClientsFor = agent => (agent.profile.allowedClients ?? []).filter(client => WAKE_CLIENTS.includes(client) && clientAvailable(client));
  const canWake = agent => wakeClientsFor(agent).length > 0;
  const { memberChat, ...chat } = createAgentChat({ host, peer, store, agents, idFactory, messageAgent, attentionInbox, waitUntilIdle, canWake });
  // A discussion member that did not answer keeps no ask in its inbox.
  const withdraw = messageId => {
    const ask = store.getMessage(messageId);
    if (ask?.status === 'queued') store.updateMessage(ask.id, { status: 'cancelled', error: ask.error ?? 'cancelled' });
  };
  const discussions = createGroupDiscussion({ host, store, agents, chat: chat.chat, memberChat, messageAgent, withdraw, canWake,
    // A woken session has no person in it to confirm members or ask a follow-up.
    inDelegatedWake: () => Boolean(env.FULI_ROUNDTABLE_DELEGATION), now });
  const person = createPersonConversation({ host, store, spaceId, agents, idFactory, label, wakeAsk, deliveryTargets,
    waitUntilIdle, canWake, wakeClientsFor });
  // The console's view of a thread: its messages and, for the person's own
  // conversations, who is subscribed and how each one receives a post.
  const ownerThread = async ({ threadId }) => ({ ...thread({ threadId }), ...await person.view(threadId) });
  return { ...chat, findAgents, messageAgent, readMessages, replyMessage, threads, thread, refreshRemote, taskEntryDelegation,
    messageStatus, cancelMessage, answerRemote,
    discuss: discussions.discuss,
    ownerGroupDiscussion: discussions.ownerView,
    ownerStopGroupDiscussion: discussions.ownerStop,
    recordGroupChoice: discussions.ownerRecordChoice,
    requestGroupFollowUp: discussions.ownerFollowUp,
    groupDiscussionStatus: discussions.ownerStatus,
    ownerMessageStatus: ({ messageId }) => statusOf(ownedAsk(messageId)),
    // Cancelling is not evidence that a possibly running process exited; any cleanup hold stays.
    ownerCancelMessage: ({ messageId }) => cancelAsk(ownedAsk(messageId)),
    pending: (agentId, projectId = undefined) => store.pendingFor(spaceId(), agentId)
      .filter(message => projectId === undefined || messageProject(message) === projectId).map(inboxItem),
    deliverAttentionReply: attentionInbox.deliver,
    attentionReplies: attentionInbox.taskEntry,
    ownerThread,
    ownerSend: async input => ownerThread({ threadId: await person.send(input) }),
    ownerSetMode: async input => ownerThread({ threadId: await person.setMode(input) }),
    close: () => {
      const pending = [chat.closeChatWakes(), discussions.close(), person.close()].filter(Boolean);
      return pending.length ? Promise.all(pending).then(() => opened?.close()) : opened?.close();
    } };
}

function remoteRowId(kind, parts) {
  return `peer-${kind}-${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40)}`;
}

function peerDepth(env) {
  const depth = Number(env.FULI_ROUNDTABLE_PEER_DEPTH);
  return Number.isSafeInteger(depth) && depth > 0 ? depth : 0;
}

function queued(thread, ask, target, reason) {
  return { status: 'queued', threadId: thread.id, messageId: ask.id, reason,
    recipient: { agentId: target.agentId, name: label(target) },
    guidance: `${label(target)} will see this message when it next starts a task and answer with reply_agent_message.` };
}

function storedCleanup(message) {
  return message.cleanup_status ? { status: message.cleanup_status, code: message.cleanup_code } : null;
}

function cleanupView(cleanup) {
  return cleanup ? { cleanup: { status: cleanup.status, code: cleanup.code ?? null } } : {};
}

function inboxItem(message) {
  return { messageId: message.id, threadId: message.thread_id, from: message.from_name,
    fromClient: message.from_client, body: message.body, createdAt: message.created_at };
}

function wakePrompt({ thread, target, senderName, senderClient, ask, targetProjectId = null }) {
  return `@{${encodeURIComponent(target.agentId)}} [FULI 圆桌 · ${thread.id}]\n`
    + (targetProjectId ? `在目标项目上下文执行：personalProjectId=${JSON.stringify(targetProjectId)}。原项目负责人保持不变，只回传本条限定需求的结果。\n` : '')
    + `${senderName}（${CLIENT_LABELS[senderClient] ?? senderClient}）发来消息：\n\n${ask.body}\n\n`
    + `请直接回答对方，你的最终回复会原样转达。需要再问其他 Agent 时，调用 message_agent 并带上 threadId="${thread.id}"。`;
}

function label(agent) {
  return agent.profile.displayName || agent.profile.name || agent.agentId;
}

function validation(message) {
  return new RoundtableError('validation', message);
}

// Release proof for one recorded hold: the same machine, an anchor recorded as
// critical, and a complete current snapshot whose single critical session-0
// anchor is a different process. Anything else is no proof. No production path
// calls this yet: the boot-anchor assumption is unverified, so release stays off.
export function cleanupReleaseProof(row, current) {
  if (row?.cleanup_status !== 'unconfirmed' || row.cleanup_released_at != null || row.cleanup_evidence_version !== '1'
      || row.cleanup_anchor_critical !== '1' || !row.cleanup_machine_hash || !row.cleanup_anchor_pid) return null;
  if (current?.version !== 1 || current.machineHash !== row.cleanup_machine_hash || current.anchor?.critical !== true
      || !Number.isInteger(current.anchor.pid) || current.anchor.pid <= 0) return null;
  if (String(current.anchor.pid) === row.cleanup_anchor_pid) return null;
  return { machineHash: row.cleanup_machine_hash, anchorPid: row.cleanup_anchor_pid,
    proof: 'boot_anchor_replaced', observation: 'anchor_pid_changed' };
}
