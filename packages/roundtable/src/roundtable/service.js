import { waitForChatChange } from './chat-wait.js';
import { createWakeClaimRelease } from './wake-claim-release.js';
import { createHash, randomUUID } from 'node:crypto';
import { projectAddress, resolveProjectAddress, resolveProjectLead, verifiedProjectFolder } from './project-target.js';
import { observeReturnedMemory, taskContextHash } from './memory-observation.js';
import { createAgentChat } from './chat.js';
import { flaAddress } from './fla-address.js';
import { createGroupDiscussion } from './group-discussion.js';
import { createPersonConversation } from './person-conversation.js';
import { ATTENTION_REPLIES_GUIDANCE, createAttentionInbox } from './attention-inbox.js';
import { STAND_IN_HANDBACKS_GUIDANCE, createReplyInbox } from './reply-inbox.js';
import { agentDiscoveryProfile, matchesAgentDiscovery } from './discovery.js';
import { CLIENT_LABELS, deliveryState } from './delivery-state.js';

import { RoundtableError } from '../errors.js';
import { visitView } from '../peer/query-answer.js';
import { isOpaqueId, validVisitRequest } from '../peer/protocol.js';
import { assertRoundtableHost } from '../host.js';
import { nearNames } from './near-names.js';
import { WAKE_CLIENTS, resolveClientCommand, sessionTurnRunning, sessionWorkingDirectory, wakeAgent } from './wake.js';
import { REMOTE_WAKE_ATTEMPTS, createWakeLadder, standInAllowed } from './wake-ladder.js';
import { outwardFailureView, wakeAttemptRecord } from './wake-failure.js';
import { enterStandIn, recordStandInReply, standInState } from './stand-in.js';

const THREAD_MESSAGE_LIMIT = 24;
const NESTED_ASK_LIMIT = 3;
const REMOTE_PENDING = new Set(['sent', 'queued', 'claimed', 'running']);
const REMOTE_FINAL = new Set(['answered', 'failed', 'cancelled', 'expired', 'unknown']);
// Claim refusals kept on the ask; a chat wait is the chat's own state, not the ask's.
const RECORDED_REFUSALS = new Set(['execution_claimed', 'cleanup_unconfirmed']);
// A later wake of a remote ask starts only with this much of its deadline left
// (the shortest grant lifetime the Provider issues).
const MIN_REMOTE_WAKE_MS = 30_000;
// Who a visit request's wake is from on the lead's thread: the request, on the owner's grant.
const VISIT_SENDER = 'FULI visit request';
const VISIT_CLIENT = 'fuli_visit';

// Agents talk to each other directly: an ask wakes the recipient in its own
// client and returns its answer, or waits in its inbox for its next task.
export function createAgentRoundtable({ host, peer = null, openStore, wake = wakeAgent, idFactory = randomUUID,
  env = process.env, locateCwd = sessionWorkingDirectory, turnRunning = sessionTurnRunning, clientAvailable = (client) => Boolean(resolveClientCommand(client)),
  // Boot-anchor evidence recorded with a cleanup hold. Production records none
  // (null) until a separately verified proof exists; release stays disabled.
  bootEvidence = async () => null, now = Date.now,
  // Which recorded wake processes still run (wake-claim-release.js); null = cannot tell.
  inspectProcess = async () => null,
  groupAlive = undefined,
  // The installed desktop app of a client, or null. Runtimes pass
  // createDesktopApps (agents/desktop-registry.js); without it every ask wakes headlessly.
  desktopApp = () => null }) {
  assertRoundtableHost(host);
  const spaceId = () => host.spaceId();
  // Opened on first use: most MCP processes never touch the roundtable.
  let opened = null;
  const refreshes = new Map();
  let refreshOffset = 0;
  const store = new Proxy({}, { get: (_target, property) => (opened ??= openStore())[property] });
  const wakeClaims = createWakeClaimRelease({ store, inspectProcess, groupAlive, now });

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
  const agentNames = agent => [agent.profile.displayName, agent.profile.name];
  function didYouMean(needle, all) {
    const near = nearNames(needle, all, agentNames);
    return near.length ? ` Did you mean ${near.map(agent => `${label(agent)} (${agent.agentId})`).join(', ')}? Ask the person before using it.` : '';
  }
  async function recipient(to) {
    // find_agents' address (local:<agentId>) is accepted as it is (rec#110).
    const needle = String(to ?? '').trim().replace(/^@\{?|\}$/g, '').replace(/^local:/, '');
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
      : `No active Agent matches "${needle}".${didYouMean(needle, all)} Call find_agents first.`);
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
    // Nothing matched what the person typed: the closest names, as a question to them (rec#110).
    const near = !local.length && needle && !project ? nearNames(needle, await agents(), agentNames) : [];
    return { agents: local, ...(workUnavailable ? { workUnavailable } : {}),
      ...(near.length ? { didYouMean: near.map(agent => ({ agentId: agent.agentId, name: label(agent) })),
        didYouMeanGuidance: 'No Agent has that name; ask the person whether they meant one of these before messaging it.' } : {}),
      ...(project ? { project: { projectId: personalProjectId, address: `project:${personalProjectId}`, reason: project.reason } } : {}),
      ...(remote ? { remoteAgents: remote.agents, ...(remote.unavailable ? { remoteUnavailable: remote.unavailable } : {}) } : {}),
      guidance: remote
        ? 'message_agent sends to an Agent (optionally one of its recentConversations) and returns its answer. remoteAgents run on other paired devices (LAN roundtable Beta): address them by their exact address, from an active project task. Only each shared project\'s lead can be asked. Use get_agent_message_status for a pending reply.'
        : 'message_agent sends to an Agent (optionally one of its recentConversations) and returns its answer.' };
  }

  // Ordered attempts (wake-ladder.js): the chosen conversation (or the Agent's
  // latest one), then a fresh session with the Agent's memory, in the sender's
  // own client first (preferClient), then in the Agent's other clients. Each
  // candidate passed over is said on the ladder with why.
  async function deliveryTargets(agent, conversation, projectId, projectPath, { clients = null, freshCwd = null, strictCwd = false,
    preferClient = null, ladder = null } = {}) {
    const permitted = (agent.profile.allowedClients ?? []).filter((client) => WAKE_CLIENTS.includes(client)
      && (!clients || clients.includes(client)));
    const allowed = permitted.filter(client => clientAvailable(client));
    const explicit = Boolean(conversation) && !['auto', 'new'].includes(conversation);
    let resumable = null;
    if (conversation !== 'new') {
      const known = await conversations(agent, null);
      const candidates = explicit
        ? known.filter((session) => session.sessionId === conversation && (!strictCwd || session.projectId === projectId))
        : known.filter((session) => !projectId || session.projectId === projectId);
      if (!candidates.length) ladder?.skip('resume', { reason: 'no_previous_session' });
      for (const session of candidates) {
        const passed = reason => ladder?.skip('resume', { client: session.client, session: session.sessionId, reason });
        if (!allowed.includes(session.client)) { passed(permitted.includes(session.client) ? 'client_unavailable' : 'client_not_allowed'); continue; }
        const cwd = locateCwd(session.client, session.sessionId);
        if (!cwd) { passed('session_not_found'); continue; }
        // A running turn is never joined: a desktop app queues behind it, a headless wake passes it over (deliver).
        resumable = { client: session.client, sessionId: session.sessionId, cwd,
          ...(turnRunning(session.client, session.sessionId) ? { busy: true } : {}) };
        break;
      }
      if (explicit && !resumable) throw validation('That conversation cannot be resumed on this machine');
    }
    if (!explicit && preferClient && WAKE_CLIENTS.includes(preferClient) && !allowed.includes(preferClient)) {
      ladder?.skip('new_session', { client: preferClient,
        reason: permitted.includes(preferClient) ? 'client_unavailable' : 'client_not_allowed' });
    }
    // A share names its clients in the owner's order.
    const freshClients = explicit ? [resumable.client]
      : [...new Set([preferClient ?? resumable?.client, ...(clients ?? WAKE_CLIENTS)])].filter((client) => allowed.includes(client));
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
  // remote ({ deadline }): a paired device's ask wakes at most REMOTE_WAKE_ATTEMPTS
  // times, all within its one execution deadline, and a refused grant ends it.
  async function deliver({ ask, attempts, prompt, timeoutMs, issueGrant, signal, onSpawn, peerDepth, remote = null,
    wakeMode = 'answer', ladder = null }) {
    const unusable = new Set();
    let failure = 'wake_failed';
    let detail = null;
    let woken = 0;
    let cleanup = null;
    for (const delivery of attempts) {
      if (unusable.has(delivery.client)) continue;
      if (signal?.aborted) { failure = 'cancelled'; detail = 'cancelled'; break; }
      // Resuming in place would write into a turn that is still running.
      if (delivery.busy) {
        failure = 'session_busy';
        detail = null;
        ladder?.skip('resume', { client: delivery.client, session: delivery.sessionId, reason: failure });
        continue;
      }
      const waitMs = remote ? Math.min(timeoutMs, remote.deadline - now()) : timeoutMs;
      if (remote && woken && (woken >= REMOTE_WAKE_ATTEMPTS || waitMs < MIN_REMOTE_WAKE_MS)) break;
      store.updateMessage(ask.id, { status: 'delivering', toClient: delivery.client, toSession: delivery.sessionId });
      let answer;
      let grant;
      const startedAt = now();
      try {
        grant = await issueGrant(delivery, waitMs / 1000);
        woken += 1;
        answer = await wake({ client: delivery.client, sessionId: delivery.sessionId, cwd: delivery.cwd,
          timeoutMs: waitMs, prompt, delegationToken: grant.token, peerDepth, signal, mode: wakeMode,
          onSpawn: (pid) => { wakeClaims.recordSpawn(ask.id, pid); onSpawn?.(pid); },
          onSession: session => host.sealDelegation({ token: grant.token, sessionId: session }) });
        const verified = answer.sessionId && await host.verifyDelegation({ token: grant.token, sessionId: answer.sessionId });
        if (!verified?.redeemed) throw Object.assign(new Error('The receiving session did not restore the Agent'),
          { code: 'delegation_not_redeemed' });
        store.recordMemoryResult(ask.id, verified.memoryResultCount ?? 0);
      } catch (error) {
        failure = attemptFailure(error);
        detail = error.detail ?? null;
        ladder?.attempt(delivery, 'failed', failure);
        if (grant) recordWake(ask, delivery, { startedAt, remote, error });
        // The team rules refused this Agent: no other channel or stand-in may reach it.
        if (failure === 'not_permitted') break;
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
        // Each wake of a remote ask is authorised as the first one was (its own
        // grant from the owner's Provider); a refused grant ends the ask.
        if (remote && !grant) break;
        continue;
      } finally {
        // Even failed or timed-out attempts lose their authority. Expiry remains
        // the fail-closed backstop if the Provider is temporarily unreachable.
        if (grant?.token) await host.revokeDelegation({ token: grant.token }).catch(() => {});
      }
      recordWake(ask, delivery, { startedAt, remote });
      ladder?.attempt(delivery, 'answered');
      return { answer, delivery, via: `${delivery.client}:${delivery.sessionId ? 'resume' : 'new'}` };
    }
    throw Object.assign(new Error('No client answered'), { code: failure, ...(detail ? { detail } : {}),
      ...(remote ? { attempts: woken } : {}), ...(cleanup ? { cleanup } : {}) });
  }

  // Each wake is kept where it ran, its output only as the host redacts it
  // (wake-failure.js); a failure also reaches the host's diagnostics, without that output.
  // The record is diagnostics: failing to keep it never changes what the ask answers.
  function recordWake(ask, delivery, { startedAt, remote, error = null }) {
    try {
      const record = wakeAttemptRecord({ client: delivery.client, sessionId: delivery.sessionId, error,
        durationMs: now() - startedAt, redact: host.redactDiagnostic });
      store.wakeAttempts.record(ask.id, record);
      if (!error || record.code === 'cancelled') return;
      const { client, sessionMode, code, detail, exitCode, signal, durationMs } = record;
      host.recordWakeFailure?.({ client, sessionMode, code, detail, exitCode, signal, durationMs, remote: Boolean(remote) });
    } catch { /* the wake's own outcome stands */ }
  }

  // While an earlier wake of this Agent may still be running, no new one starts.
  // The claim is durable and atomic across coordinators; it ends only when the
  // owned process was observed to end (or never started), not on reply/cancel.
  function finishWake(ask, error = null) {
    if (!error?.cleanup) store.finishExecution(ask.id);
  }

  async function messageAgent({ taskContextToken = null, sourceApplication, to, body, threadId = null,
    conversation = 'auto', wait = true, timeoutSeconds = 300, projectPath = null, roundtableProjectId = null, signal, chatWakeChatId = null, chatWake = null,
    // wakeMode: read_only for a group discussion turn, woken where it can change nothing (wake adapters).
    wakeMode = 'answer' } = {}) {
    const readOnly = wakeMode === 'read_only';
    if (roundtableProjectId && peer?.isRemoteAddress(to)) throw validation('This scoped consultation cannot leave its project');
    if (peer?.isRemoteAddress(to)) {
      return messageRemote({ taskContextToken, sourceApplication, to, body, threadId, conversation, wait, timeoutSeconds, chatWake, signal });
    }
    const from = await sender({ taskContextToken, sourceApplication });
    const address = projectAddress(to);
    const projectId = address && await resolveProjectAddress(host, address);
    if (roundtableProjectId && (from.projectId !== roundtableProjectId || (projectId && projectId !== roundtableProjectId))) {
      throw validation('This scoped consultation cannot leave its project');
    }
    const resolved = projectId ? await resolveProjectLead(host, projectId, { source: from, recruit: true }) : null;
    if (resolved && !resolved.agent) return { status: 'queued', reason: resolved.reason, targetProjectId: projectId };
    const target = resolved?.agent ?? await recipient(to);
    const targetProjectId = projectId ?? agentProjectOutsideSender(target, from) ?? from.projectId;
    const crossProject = Boolean(targetProjectId && from.projectId && targetProjectId !== from.projectId);
    // The same FLA in another session is another instance of it (rec#109): it
    // is reached by naming that session, never by its bare name.
    if (from.agent?.agentId === target.agentId && !crossProject && !threadId
        && (['auto', 'new'].includes(conversation ?? 'auto') || conversation === from.session)) {
      throw validation(await sameAgentGuidance(target, from));
    }
    const { thread, history } = openThread(threadId, from.projectId, body, label(target));
    const ask = store.appendMessage(thread.id, { id: idFactory(), kind: 'ask', body, status: 'queued',
      from: { agentId: from.agent?.agentId, name: from.agent ? label(from.agent) : CLIENT_LABELS[from.client] ?? from.client,
        client: from.client, session: from.session },
      to: { agentId: target.agentId, name: label(target) }, targetProjectId,
      sourceContextHash: taskContextToken ? taskContextHash(taskContextToken) : null });
    // The source token never enters the communication log.
    const nested = history.filter((message) => message.kind === 'ask' && message.status === 'delivering').length;
    if (!wait || nested >= NESTED_ASK_LIMIT) return queued(thread, ask, target, nested ? 'nested_limit' : 'not_waiting');
    if (!taskContextToken) return queued(thread, ask, target, 'task_context_required');
    const ladder = createWakeLadder();
    // A task outside every project holds no authority the Provider can pass on.
    const woken = !from.projectId ? withoutGrant(ask, ladder) : await wakeAsk({ thread, ask, target, chatWakeChatId, signal, wakeMode, ladder,
      timeoutMs: Math.min(Math.max(timeoutSeconds, 30), 900) * 1000,
      targets: async () => deliveryTargets(target, conversation, targetProjectId, crossProject ? null : projectPath,
        { preferClient: from.client, ladder,
          ...(crossProject ? { strictCwd: true, freshCwd: await verifiedProjectFolder(host, targetProjectId, projectPath) } : {}) }),
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
    if (woken.status !== 'answered') {
      // Nobody could come: the sender's own session takes the recipient on, unless
      // the recipient may still be running, the rules refused it, or this is a woken session.
      // A cross-project ask keeps its strict boundary, and a chat or discussion turn
      // must be the member itself.
      if (woken.reason !== 'waiting_in_desktop_app' && standInAllowed(woken.reason) && !woken.cleanup
          && !env.FULI_ROUNDTABLE_DELEGATION && !crossProject && !readOnly && !chatWakeChatId) {
        return { ...await enterStandIn({ host, store, thread, ask, target: { agentId: target.agentId, name: label(target),
          occupation: target.occupation ?? null }, from: { name: ask.from_name, client: from.client, session: from.session },
          projectId: targetProjectId, reason: woken.reason }), ladder: ladder.view('stand_in') };
      }
      return { ...queued(thread, ask, target, woken.reason, woken), ...cleanupView(woken.cleanup), ladder: ladder.view(woken.tier ?? null) };
    }
    replyInbox.handOver(woken.reply, 'message_agent');
    const observation = await observeReturnedMemory(host, store, { ask, reply: woken.reply, from, taskContextToken });
    return { status: 'answered', threadId: thread.id, messageId: ask.id, recipient: { agentId: target.agentId, name: label(target) },
      ...(observation ? { memoryObservation: observation } : {}),
      via: woken.via, reply: woken.reply.body, ladder: ladder.view(woken.tier),
      // A discussion turn records who answered with what (rec#129); other asks stay as they were.
      ...(readOnly ? { executor: { client: woken.reply.from_client, session: woken.reply.from_session,
        model: woken.model ?? null } } : {}) };
  }

  // The one way an ask wakes its recipient, whoever sent it: a durable execution
  // claim, the recipient's own clients in order, a per-attempt grant, and only a
  // verified answer becomes its reply. An ask that is not answered stays queued
  // with the reason, so the recipient still sees it when it next works.
  async function wakeAsk({ thread, ask, target, targets, noTargets, prompt, timeoutMs, signal, issueGrant, replyTo,
    chatWakeChatId = null, wakeMode = 'answer', ladder = null }) {
    await wakeClaims.release(spaceId(), target.agentId);
    const claim = store.claimExecution(spaceId(), target.agentId, ask.id, { chatWakeChatId });
    if (!claim.claimed) {
      // Recorded so the thread and get_agent_message_status say why no client has it.
      if (RECORDED_REFUSALS.has(claim.reason)) store.updateMessage(ask.id, { status: 'queued', error: claim.reason });
      return { status: 'queued', reason: claim.reason, blockedBy: claim.blockedBy ?? null };
    }
    let attempts;
    try { attempts = await targets(); }
    catch (error) { finishWake(ask); throw error; }
    if (!attempts.length) {
      finishWake(ask);
      const reason = noTargets();
      store.updateMessage(ask.id, { status: 'queued', error: reason });
      return { status: 'queued', reason };
    }
    // A read-only turn cannot go to a desktop conversation, which runs with the person's own settings.
    const app = wakeMode === 'read_only' ? null : desktopApp(attempts[0].client);
    if (app) return handToDesktop({ thread, ask, target, delivery: attempts[0], app, timeoutMs, signal, ladder });
    try {
      const { answer, delivery, via } = await deliver({ ask, attempts, prompt, timeoutMs, signal, wakeMode, issueGrant, ladder });
      finishWake(ask);
      store.updateMessage(ask.id, { status: 'answered', via });
      const reply = store.appendMessage(thread.id, { id: idFactory(), kind: 'reply', body: answer.body, status: 'sent',
        inReplyTo: ask.id, via, from: { agentId: target.agentId, name: label(target), client: delivery.client,
          session: answer.sessionId }, to: replyTo, delivery: replyInbox.pendingFor(replyTo) });
      return { status: 'answered', reply, via, tier: delivery.sessionId ? 'resume' : 'new_session',
        ...(answer.model ? { model: answer.model } : {}) };
    } catch (error) {
      finishWake(ask, error);
      store.updateMessage(ask.id, { status: 'queued', error: error.code ?? 'wake_failed' });
      return { status: 'queued', reason: error.code ?? 'wake_failed', cleanup: error.cleanup ?? null };
    }
  }

  // The ask joins a conversation in the desktop app, where the person sees it
  // being worked on: the Agent's own latest conversation when it has one (the
  // app queues it behind a running turn), else the Agent's inbox conversation.
  // The conversation answers with reply_agent_message. The caller waits for that
  // reply up to its timeout; after it, the ask stays queued and the reply still
  // reaches the thread.
  async function handToDesktop({ thread, ask, target, delivery, app, timeoutMs, signal, ladder = null }) {
    const inbox = { spaceId: spaceId(), agentId: target.agentId, projectId: messageProject(ask) ?? '', client: delivery.client };
    const message = wakePrompt({ thread, ask, target, senderName: ask.from_name,
      senderClient: ask.from_client, targetProjectId: ask.target_project_id, replyInInbox: true });
    const handTo = async conversationId => {
      store.updateMessage(ask.id, { status: 'queued', toClient: delivery.client, toSession: conversationId });
      await app.handOff({ threadId: conversationId, message });
    };
    let tier = null;
    try {
      if (delivery.sessionId) {
        try {
          await handTo(delivery.sessionId);
          ladder?.attempt(delivery, 'handed_off');
          tier = 'resume';
        } catch (error) {
          ladder?.attempt(delivery, 'failed', error.code ?? 'codex_app_failed');
        }
      }
      if (!tier) {
        const conversationId = store.desktopInboxes.find(inbox) ?? store.desktopInboxes.remember({ ...inbox,
          conversationId: await app.createInbox({ cwd: delivery.cwd, greeting: inboxGreeting(target) }) });
        await handTo(conversationId);
        ladder?.attempt({ client: delivery.client, sessionId: null }, 'handed_off');
        tier = 'new_session';
      }
    } catch (error) {
      ladder?.attempt({ client: delivery.client, sessionId: null }, 'failed', error.code ?? 'wake_failed');
      store.updateMessage(ask.id, { status: 'queued', error: error.code ?? 'wake_failed' });
      return { status: 'queued', reason: error.code ?? 'wake_failed' };
    } finally { finishWake(ask); }
    const replied = await waitForChatChange(() => store.messages(thread.id).find(message => message.in_reply_to === ask.id) ?? null,
      { store: store.chat, signal, timeoutSeconds: timeoutMs / 1000, ready: Boolean }).catch(() => null);
    const handed = store.getMessage(ask.id);
    return replied ? { status: 'answered', reply: replied, via: replied.via, tier }
      : { status: 'queued', reason: 'waiting_in_desktop_app', toClient: handed.to_client, toSession: handed.to_session, tier };
  }

  // A sender outside every project cannot grant a wake; the ladder says so for
  // both tiers that need the grant.
  function withoutGrant(ask, ladder) {
    for (const tier of ['resume', 'new_session']) ladder.skip(tier, { reason: 'sender_without_project' });
    store.updateMessage(ask.id, { status: 'queued', error: 'sender_without_project' });
    return { status: 'queued', reason: 'sender_without_project' };
  }

  // Addressing one's own FLA by name: name the other session instead.
  async function sameAgentGuidance(target, from) {
    const others = (await conversations(target, null)).filter(session => session.sessionId !== from.session);
    return `${label(target)} is the current task's own FLA. To reach another session of it, pass conversation: `
      + (others.length ? others.map(session => `"${session.sessionId}" (${CLIENT_LABELS[session.client] ?? session.client})`).join(', ')
        : 'a sessionId from find_agents recentConversations (none is known now)') + '.';
  }

  // The recipient is resolved before the thread, so an unknown threadId never
  // means the Agent is missing (rec#68): say which one exists and how to go on.
  function openThread(threadId, projectId, body, recipientName) {
    let thread = threadId ? store.getThread(threadId) : null;
    if (threadId && (!thread || thread.space_id !== spaceId())) {
      throw validation(`Roundtable thread ${threadId} not found. Agent ${recipientName} exists; threadId takes only a FULI `
        + 'roundtable thread ID from an earlier message_agent result, never a host session or conversation ID. Omit threadId to start a new thread.');
    }
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
    const { thread } = openThread(threadId, from.projectId, body, target.name);
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
    return handedOver(remoteView(applyRemote(ask.id, state)), 'message_agent');
  }

  // The visiting assistant: the current task's Agent reads a paired device's
  // shared project with this client's own model. The other device answers from
  // its shared knowledge and wakes nothing; message_agent is the path that wakes its lead.
  async function visitSharedLead({ taskContextToken = null, sourceApplication, address, action, queries, request, requestId, signal }) {
    if (!peer?.isRemoteAddress(address)) throw validation('Visit a paired device\'s lead by its peer:<device>:<binding> address from find_agents');
    if (!VISIT_ACTIONS.has(action)) throw validation('action is card, search, request or request_status');
    if (action === 'search' && (!Array.isArray(queries) || !queries.length || queries.length > 4
      || !queries.every((query) => typeof query === 'string' && query.trim() && query.length <= 200))) {
      throw validation('search needs 1-4 focused queries of at most 200 characters');
    }
    if (action === 'request' && !validVisitRequest(request)) {
      throw validation('request needs request: { title (≤160), what (≤4000), expectedAreas? (≤10 paths of ≤200) }');
    }
    if (action === 'request_status' && !isOpaqueId(requestId)) throw validation('request_status needs the requestId request answered');
    const from = await sender({ taskContextToken, sourceApplication });
    if (!from.agent || !from.projectId) throw validation('A visit must come from an active project task of a FULI Agent; pass taskContextToken');
    const target = await peer.resolveRemote(address);
    const answer = await peer.query(target, visitQuestion({ action, queries, request, requestId }), { taskContextToken,
      sourceApplication: from.client, from: { agentId: from.agent.agentId, name: label(from.agent) }, signal });
    return visitView({ address: target.address, device: target.deviceName, action, answer });
  }

  function applyRemote(messageId, state) {
    const ask = store.getMessage(messageId);
    if (!ask || !state || !REMOTE_PENDING.has(ask.status)) return ask;
    const status = state.status === 'queued' ? 'sent' : state.status;
    if (status === 'answered' && state.reply) {
      store.updateMessage(ask.id, { status: 'answered', via: state.via ?? 'peer' });
      const to = { agentId: ask.from_agent, name: ask.from_name, client: ask.from_client, session: ask.from_session };
      store.appendMessage(ask.thread_id, { id: idFactory(), kind: 'reply', body: state.reply, status: 'sent', inReplyTo: ask.id,
        via: state.via ?? 'peer', from: { agentId: ask.to_agent, name: ask.to_name, client: state.via?.split(':')[0] ?? null },
        to, delivery: replyInbox.pendingFor(to) });
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
      ...(reply ? { reply: reply.body, via: reply.via } : {}), ...(ask.error ? outwardFailureView(ask.error) : {}),
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
    await wakeClaims.release(share.spaceId, target.agentId);
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
      // A paired device only asks: every client is woken read-only on this computer.
      const { answer, delivery, via } = await deliver({ ask, attempts, prompt, timeoutMs, issueGrant, signal, onSpawn,
        peerDepth: assertion.depth, wakeMode: 'read_only', remote: { deadline: now() + timeoutMs } });
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

  // A visit request's wake on this computer (FULI's src/visit-requests): the
  // person approved it, or the mode they set did, so it runs under the owner's
  // grant, as one fresh session of the lead in the request's own worktree
  // (cwd), in the given wake mode. It is an ask like any other: recorded in its
  // own thread, one run of the lead at a time (it waits for an earlier one),
  // every attempt's grant revoked after it. Answers { body, client } or throws
  // with the wake's code.
  async function wakeForVisit({ agentId, projectId, subject, cwd, prompt, mode, timeoutMs, signal }) {
    if (!host.issueOwnerDelegation) throw Object.assign(new Error('This host cannot grant an owner-approved wake'), { code: 'owner_grant_unavailable' });
    const target = await agentById(agentId);
    if (!target) throw Object.assign(new Error('The lead is no longer active'), { code: 'agent_unavailable' });
    const attempts = wakeClientsFor(target).map((client) => ({ client, sessionId: null, cwd }));
    if (!attempts.length) throw Object.assign(new Error('No client of the lead can run on this computer'), { code: 'no_client' });
    const thread = store.createThread({ id: idFactory(), spaceId: spaceId(), projectId, subject: subject.slice(0, 80) });
    const ask = store.appendMessage(thread.id, { id: idFactory(), kind: 'ask', body: prompt, status: 'delivering',
      from: { agentId: null, name: VISIT_SENDER, client: VISIT_CLIENT }, to: { agentId, name: label(target) } });
    if (!await waitUntilIdle(agentId, signal).catch(() => false)) {
      store.updateMessage(ask.id, { status: 'failed', error: signal?.aborted ? 'cancelled' : 'cleanup_unconfirmed' });
      throw Object.assign(new Error('The lead could not be woken now'), { code: signal?.aborted ? 'cancelled' : 'cleanup_unconfirmed' });
    }
    const claim = store.claimExecution(spaceId(), agentId, ask.id);
    if (!claim.claimed) {
      store.updateMessage(ask.id, { status: 'failed', error: claim.reason });
      throw Object.assign(new Error('Another run of the lead holds it'), { code: claim.reason });
    }
    try {
      const { answer, delivery, via } = await deliver({ ask, attempts, prompt, timeoutMs, signal, wakeMode: mode,
        issueGrant: (delivery, lifetime) => host.issueOwnerDelegation({ projectId, agentId, targetClient: delivery.client,
          targetSessionId: null, lifetimeSeconds: Math.max(30, Math.min(900, Math.round(lifetime))) }) });
      finishWake(ask);
      store.updateMessage(ask.id, { status: 'answered', via });
      return { body: answer.body, client: delivery.client };
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
    if (ask.from_agent === me.agent.agentId) replyInbox.handOver(reply, 'get_agent_message_status');
    const observation = await observeReturnedMemory(host, store, { ask: store.getMessage(ask.id), reply, from: me, taskContextToken });
    return { ...result, ...(observation ? { memoryObservation: observation } : {}) };
  }

  // A queued ask's delivery in words: what was recorded, and which earlier ask holds the Agent now.
  async function queuedState(ask) {
    const reason = ask.error ?? (ask.to_client ? 'waiting_in_desktop_app' : null);
    const blockedBy = reason === 'execution_claimed' ? store.executionState(spaceId(), ask.to_agent, ask.id).claim : null;
    return deliveryState({ reason, name: ask.to_name ?? ask.to_agent, clients: wakeClients(await agentById(ask.to_agent)),
      blockedBy, toClient: ask.to_client, toSession: ask.to_session });
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
      ...(ask.error ? { reason: ask.error } : {}), ...cleanupView(storedCleanup(ask)),
      ...(ask.status === 'queued' ? await queuedState(ask) : {}), ...(ask.status === 'stand_in' ? standInState(ask) : {}) };
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
    if (!ask || ask.kind !== 'ask' || !me.agent || thread?.space_id !== spaceId()
      || !((ask.from_agent === me.agent.agentId && sameProject(thread.project_id, me.projectId))
        || (ask.to_agent === me.agent.agentId && sameProject(messageProject(ask), me.projectId)))) {
      throw validation('No such message for this Agent in the current project');
    }
    return ask;
  }

  async function cancelAsk(ask) {
    // A wake its console lost, whose process has ended, no longer answers; its ask is back in the inbox.
    if (ask.status === 'delivering' && !peer?.hasSent(ask.id) && await wakeClaims.release(spaceId(), ask.to_agent)) ask = store.getMessage(ask.id);
    if (peer?.hasSent(ask.id)) {
      if (!REMOTE_PENDING.has(ask.status)) return remoteView(ask);
      return remoteView(applyRemote(ask.id, await peer.cancel(ask.id)));
    }
    if (['queued', 'stand_in'].includes(ask.status)) store.updateMessage(ask.id, { status: 'cancelled', error: 'cancelled' });
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
    const { replies, more } = me.projectId ? replyInbox.read(me.agent.agentId, me.projectId) : { replies: [] };
    const { replies: handbacks } = me.projectId ? handbackInbox.read(me.agent.agentId, me.projectId) : { replies: [] };
    return { messages: store.pendingFor(spaceId(), me.agent.agentId)
      .filter(message => messageProject(message) === me.projectId).map(inboxItem),
      guidance: 'Answer each with reply_agent_message.',
      ...(replies.length ? { replies, repliesGuidance: `Answers to asks you sent, each returned once.${more
        ? ' More are waiting: call read_agent_messages again.' : ''}` } : {}),
      ...(handbacks.length ? { handbacks, handbacksGuidance: STAND_IN_HANDBACKS_GUIDANCE } : {}),
      ...(attentionReplies.length ? { attentionReplies, attentionRepliesGuidance: ATTENTION_REPLIES_GUIDANCE } : {}) };
  }

  async function replyMessage({ taskContextToken, sourceApplication, messageId, body }) {
    const me = await sender({ taskContextToken, sourceApplication });
    const ask = store.getMessage(messageId);
    // The session that stood in answers for the Agent it stood in for; the Agent
    // itself can still answer its own ask first.
    if (ask?.kind === 'ask' && ask.status === 'stand_in' && me.session && ask.from_session === me.session
        && (ask.from_agent ?? null) === (me.agent?.agentId ?? null) && ask.to_client === me.client && ask.to_session === me.session) {
      if (!standInInScope(ask, me)) throw validation('No such message for this Agent in the current project');
      return recordStandInReply({ store, ask, executor: { client: me.client, session: me.session }, body, idFactory });
    }
    // The conversation FULI handed the ask to answers for its recipient, whichever
    // FLA its task was entered as: a member's desktop conversation enters as the
    // project lead it reports to, and its answer was refused (rec#111).
    const handedHere = ask?.kind === 'ask' && Boolean(me.session) && ask.to_client === me.client && ask.to_session === me.session
      && ask.from_session !== me.session;
    // The store reads by ID only: an ask of another space is never this task's to answer.
    if (!ask || ask.kind !== 'ask' || !(handedHere || (me.agent && ask.to_agent === me.agent.agentId))
        || store.getThread(ask.thread_id)?.space_id !== spaceId()
        || !sameProject(messageProject(ask), me.projectId)) throw validation('No such message for this Agent');
    const answering = me.agent && ask.to_agent === me.agent.agentId
      ? { agentId: me.agent.agentId, name: label(me.agent) } : { agentId: ask.to_agent, name: ask.to_name };
    if (ask.target_project_id && ask.target_project_id !== store.getThread(ask.thread_id)?.project_id) {
      if (await host.projectLeadId(ask.target_project_id) !== answering.agentId) throw validation('The target project lead changed');
    }
    if (ask.status === 'answered') throw validation('This message was already answered');
    if (ask.from_agent?.startsWith('peer:')) throw validation('A remote device message is answered by its delivery, not from the inbox');
    store.updateMessage(ask.id, { status: 'answered', via: `${me.client}:inbox` });
    const to = { agentId: ask.from_agent, name: ask.from_name, client: ask.from_client, session: ask.from_session };
    store.appendMessage(ask.thread_id, { id: idFactory(), kind: 'reply', body, status: 'sent', inReplyTo: ask.id,
      via: `${me.client}:inbox`, from: { ...answering, client: me.client, session: me.session },
      to, delivery: replyInbox.pendingFor(to) });
    // asker: who this answer is for, so the turn's receipt can name them.
    return { status: 'sent', threadId: ask.thread_id,
      ...(ask.from_agent ? { asker: { agentId: ask.from_agent, name: ask.from_name } } : {}) };
  }

  // A stand-in answers only inside the space and project its ask was sent from,
  // and a stand-in is never cross-project (messageAgent), so the ask's target
  // project is that same project. A task outside every project matches only null.
  function standInInScope(ask, me) {
    const thread = store.getThread(ask.thread_id);
    if (!thread || thread.space_id !== spaceId()) return false;
    const project = thread.project_id ?? null;
    return project === (me.projectId ?? null) && (ask.target_project_id ?? project) === project;
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
        // The person's own conversation delivers by its subscribers' mode; a thread only Agents wrote has none.
        mode: store.subscriptions.subscribers(thread.id)[0]?.delivery ?? null,
        // An Agent is answering right now: a woken run of an ask in this thread has not ended.
        replying: open.some((message) => message.status === 'delivering'),
        waiting: open.length > 0,
        // Who the open asks are addressed to, so the list never shows a bare "waiting".
        waitingFor: [...new Set(open.map((message) => message.to_name).filter(Boolean))],
        last: last ? { from: last.from_name, body: last.body.slice(0, 160) } : null };
    }) };
  }

  // Whole message bodies, oldest first. after/limit page by seq; nextAfter says where the next page starts.
  function thread({ threadId, after = 0, limit = Infinity }) {
    const record = store.getThread(threadId);
    if (!record || record.space_id !== spaceId()) throw validation('Thread not found');
    const rest = store.messages(record.id).filter((message) => message.seq > after);
    const page = rest.slice(0, limit);
    return { id: record.id, subject: record.subject, projectId: record.project_id, createdAt: record.created_at,
      ...(rest.length > page.length ? { nextAfter: page.at(-1).seq } : {}),
      messages: page.map((message) => ({ id: message.id, seq: message.seq, kind: message.kind, status: message.status,
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

  // A task with no project (a global assistant) reaches the messages of no project.
  const sameProject = (left, right) => (left ?? null) === (right ?? null);
  const messageProject = message => message.target_project_id ?? store.getThread(message.thread_id)?.project_id ?? null;
  const attentionInbox = createAttentionInbox({ store, spaceId });
  const replyInbox = createReplyInbox({ store, spaceId });
  const handbackInbox = createReplyInbox({ store, spaceId, kind: 'handback' });
  // A reply returned to the asker directly is not delivered again from its inbox.
  const handedOver = (view, via) => {
    if (view.reply) replyInbox.handOver(store.messages(view.threadId).find(message => message.in_reply_to === view.messageId), via);
    return view;
  };
  // False when an earlier run of this Agent may still be running (a cleanup hold).
  const waitUntilIdle = async (agentId, signal) => {
    const state = await waitForChatChange(async () => {
      await wakeClaims.release(spaceId(), agentId);
      return store.executionState(spaceId(), agentId);
    },
      { store: store.chat, signal, ready: state => state.held || !state.busy });
    return !state.held;
  };
  const wakeClientsFor = agent => (agent.profile.allowedClients ?? []).filter(client => WAKE_CLIENTS.includes(client) && clientAvailable(client));
  const canWake = agent => wakeClientsFor(agent).length > 0;
  const { memberChat, ...chat } = createAgentChat({ host, peer, store, agents, idFactory, messageAgent, attentionInbox, waitUntilIdle, canWake,
    isThread: id => store.getThread(id)?.space_id === spaceId() });
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
    messageStatus, cancelMessage, answerRemote, visitSharedLead, wakeForVisit,
    // The folder a fresh wake of this lead would use: its latest session in the project, else the host's.
    knownProjectFolder: ({ agentId, projectId }) => projectFolder({ agentId }, projectId),
    discuss: discussions.discuss,
    ownerGroupDiscussion: discussions.ownerView,
    ownerStopGroupDiscussion: discussions.ownerStop,
    recordGroupChoice: discussions.ownerRecordChoice,
    requestGroupFollowUp: discussions.ownerFollowUp,
    groupDiscussionStatus: discussions.ownerStatus,
    joinGroupDiscussion: discussions.ownerJoin,
    groupDiscussionTurns: discussions.ownerSessionTurn,
    // The owner also sees each wake this computer started for the ask and why it failed.
    ownerMessageStatus: async ({ messageId }) => {
      const ask = ownedAsk(messageId);
      const wakeAttempts = store.wakeAttempts.forMessage(ask.id);
      return { ...await statusOf(ask), ...(wakeAttempts.length ? { wakeAttempts } : {}) };
    },
    // Cancelling is not evidence that a possibly running process exited; any cleanup hold stays.
    ownerCancelMessage: ({ messageId }) => cancelAsk(ownedAsk(messageId)),
    pending: (agentId, projectId = undefined) => store.pendingFor(spaceId(), agentId)
      .filter(message => projectId === undefined || messageProject(message) === projectId).map(inboxItem),
    deliverAttentionReply: attentionInbox.deliver,
    attentionReplies: attentionInbox.taskEntry,
    agentReplies: replyInbox.announce,
    standInHandbacks: handbackInbox.announce,
    ownerThread,
    ownerSend: async input => ownerThread({ threadId: await person.send(input) }),
    ownerSetMode: async input => ownerThread({ threadId: await person.setMode(input) }),
    close: () => {
      const pending = [chat.closeChatWakes(), discussions.close(), person.close()].filter(Boolean);
      return pending.length ? Promise.all(pending).then(() => opened?.close()) : opened?.close();
    } };
}

// A Provider refusal of the grant without a code of its own (403: the
// reporting lines do not connect these Agents) is the team rules saying no.
function attemptFailure(error) {
  if (error.status === 403 && (!error.code || error.code === 'provider_error')) return 'not_permitted';
  return error.code ?? 'wake_failed';
}

function remoteRowId(kind, parts) {
  return `peer-${kind}-${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40)}`;
}

function peerDepth(env) {
  const depth = Number(env.FULI_ROUNDTABLE_PEER_DEPTH);
  return Number.isSafeInteger(depth) && depth > 0 ? depth : 0;
}

// woken: what the wake recorded (blockedBy, toClient, toSession), when it ran.
function queued(thread, ask, target, reason, woken = {}) {
  return { status: 'queued', threadId: thread.id, messageId: ask.id, reason,
    recipient: { agentId: target.agentId, name: label(target) },
    ...deliveryState({ reason, name: label(target), clients: wakeClients(target), blockedBy: woken.blockedBy,
      toClient: woken.toClient, toSession: woken.toSession }) };
}

function wakeClients(agent) {
  return (agent?.profile.allowedClients ?? []).filter((client) => WAKE_CLIENTS.includes(client));
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

function wakePrompt({ thread, target, senderName, senderClient, ask, targetProjectId = null, replyInInbox = false }) {
  return `${flaAddress(target.agentId)} [FULI 圆桌 · ${thread.id}]\n`
    + (targetProjectId ? `在目标项目上下文执行：personalProjectId=${JSON.stringify(targetProjectId)}。原项目负责人保持不变，只回传本条限定需求的结果。\n` : '')
    + `${senderName}（${CLIENT_LABELS[senderClient] ?? senderClient}）发来消息：\n\n${ask.body}\n\n`
    + (replyInInbox
      ? `处理完后调用 reply_agent_message（messageId="${ask.id}"）回复对方，回复会原样转到圆桌。`
      : '请直接回答对方，你的最终回复会原样转达。')
    + `需要再问其他 Agent 时，调用 message_agent 并带上 threadId="${thread.id}"。`;
}

function inboxGreeting(target) {
  return `FULI 圆桌会把发给「${label(target)}」的消息排进这个对话。现在只需回复「好」。`;
}

const VISIT_ACTIONS = new Set(['card', 'search', 'request', 'request_status']);

// Exactly the fields each visit action carries across devices.
function visitQuestion({ action, queries, request, requestId }) {
  if (action === 'search') return { action, queries };
  if (action === 'request') {
    const { title, what, expectedAreas } = request;
    return { action, request: { title, what, ...(expectedAreas ? { expectedAreas } : {}) } };
  }
  return action === 'request_status' ? { action, requestId } : { action };
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
