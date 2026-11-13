import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { loadDeviceIdentity } from './device-identity.js';
import { createNodeStore } from './node-store.js';
import { assertionDigest, authorityFromProvider } from './origin-proof.js';
import { createPeerClient } from './peer-transport.js';
import { PEER_LIMITS, PEER_PROTOCOL, PEER_QUERY_PROTOCOL, PeerError, peerCleanup, peerLook, TERMINAL_STATUSES } from './protocol.js';
import { createPeerChatPort } from './chat-port.js';
import { parseQueryAnswer, queryCode } from './query-answer.js';
import { matchesAgentDiscovery } from '../roundtable/discovery.js';

const ADDRESS = /^peer:([0-9a-f]{16}):([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;
const STATUS_POLL_MS = 2_000;
const PROOF_MARGIN_MS = 60_000;
// A query is answered within a claim tick and one search: poll briefly, give up soon.
const QUERY_POLL_MS = 300;
const QUERY_WAIT_MS = 20_000;
const refused = (code) => ({ ok: false, code: queryCode(code) });

// The coordinator's answer is untrusted here: only a bounded cleanup report passes.
function boundedState(state) {
  if (!state || typeof state !== 'object') return state;
  const { cleanup, ...rest } = state;
  const unconfirmed = peerCleanup(cleanup);
  return unconfirmed ? { ...rest, cleanup: unconfirmed } : rest;
}

export function peerDirectory(dataDir) {
  return join(dataDir, 'peer');
}

// What Agents on this device use to reach shared project leads on other paired
// devices. It never pairs, shares or listens: those stay with the local owner.
export function createPeerPort({ dataDir, host, clock = Date.now, idFactory = randomUUID,
  statusPollMs = STATUS_POLL_MS, createClient = createPeerClient }) {
  const directory = peerDirectory(dataDir);
  let store = null;
  let session = null;

  const databasePath = join(directory, 'node.sqlite');
  const nodeStore = () => (store ??= createNodeStore(databasePath));
  // Nothing is created on disk until the owner configures the LAN roundtable.
  const configured = () => Boolean(store) || existsSync(databasePath);
  const membership = () => (configured() ? nodeStore().setting('membership') : null);

  async function connection() {
    const current = membership();
    if (!current?.coordinator) throw new PeerError('peer_not_paired', 'This device is not paired with a coordinator; the owner pairs devices in Settings', 409);
    if (session?.fingerprint === current.coordinator.fingerprint && session.url === current.coordinator.url) return session;
    session?.client.close();
    const identity = await loadDeviceIdentity(directory);
    session = { fingerprint: current.coordinator.fingerprint, url: current.coordinator.url, identity,
      client: createClient({ identity, coordinator: current.coordinator }) };
    return session;
  }

  async function post(path, body, options) {
    return (await connection()).client.post(path, body, options);
  }

  function isRemoteAddress(to) {
    return typeof to === 'string' && to.trim().startsWith('peer:');
  }

  async function remoteDirectory() {
    if (!membership()?.coordinator) return null;
    const { devices } = await post('/peer/1/directory', {});
    const self = (await connection()).identity.fingerprint;
    return devices.filter((device) => device.nodeId !== self);
  }

  async function remoteAgents({ query = null, occupation = null, capability = null, projectId = null } = {}) {
    let devices;
    try { devices = await remoteDirectory(); }
    catch (error) { return { agents: [], unavailable: error.code ?? 'coordinator_unreachable' }; }
    if (!devices) return null;
    const needle = query?.trim().toLowerCase();
    const agents = devices.flatMap((device) => device.agents.map((agent) => ({
      address: `peer:${device.nodeId.slice(0, 16)}:${agent.bindingId}`, name: agent.name,
      role: agent.communicationOnly ? 'shared_agent' : 'shared_project_lead', agentId: agent.agentId,
      occupation: agent.occupation ?? null, capabilities: agent.capabilities ?? [], projectId: agent.projectId ?? null,
      communicationOnly: agent.communicationOnly === true, ...(peerLook(agent.look) ? { look: peerLook(agent.look) } : {}),
      employeeNumber: agent.employeeNumber, responsibility: agent.responsibility, projectName: agent.projectName,
      device: { name: device.name, online: device.online } })))
      .filter((agent) => matchesAgentDiscovery(agent, { occupation, capability }) && (!projectId || agent.projectId === projectId)
        && (!needle || [agent.name, agent.occupation, ...agent.capabilities, agent.projectName, agent.responsibility, agent.device.name]
        .some((value) => value?.toLowerCase().includes(needle))));
    return { agents: agents.slice(0, 50) };
  }

  async function resolveRemote(to) {
    const match = ADDRESS.exec(String(to ?? '').trim());
    if (!match) throw new PeerError('invalid_address', 'Remote Agents are addressed as peer:<device>:<binding> from find_agents');
    const device = (await remoteDirectory() ?? []).find((entry) => entry.nodeId.startsWith(match[1]));
    const agent = device?.agents.find((entry) => entry.bindingId === match[2]);
    if (!agent) throw new PeerError('agent_not_shared', 'That remote Agent is not shared any more; call find_agents again', 404);
    if (agent.communicationOnly) throw new PeerError('chat_only', 'This Agent is shared for communication only; use agent_chat', 403);
    return { address: match[0], node: device.nodeId, bindingId: agent.bindingId, agentId: agent.agentId,
      name: agent.name, deviceName: device.name };
  }

  // The task token is only used with this device's own authority; the remote
  // device receives the authority's signed statement, never the token.
  async function send({ messageId, threadId, target, body, conversation, depth, from, taskContextToken, sourceApplication, chatWake }) {
    const { identity } = await connection();
    const now = clock();
    const assertion = { protocol: PEER_PROTOCOL, messageId, threadId,
      from: { node: identity.fingerprint, agentId: from.agentId, name: from.name, client: from.client },
      to: { node: target.node, bindingId: target.bindingId, agentId: target.agentId },
      body, conversation, depth, ...(chatWake ? { chatWake } : {}),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PEER_LIMITS.defaultTtlSeconds * 1000 - PROOF_MARGIN_MS).toISOString() };
    const issued = await host.issueRemoteOrigin({ taskContextToken, client: sourceApplication, messageId,
      digest: assertionDigest(assertion), targetNode: target.node, bindingId: target.bindingId, expiresAt: assertion.expiresAt });
    if (issued.agent_id !== from.agentId) throw new PeerError('origin_mismatch', 'The local authority attributed this task to another Agent', 409);
    assertion.origin = issued.proof;
    nodeStore().recordSent({ messageId, targetNode: target.node, bindingId: target.bindingId });
    return post('/peer/1/messages', { assertion, signature: identity.sign(assertion) });
  }

  // A visitor's read-only question to a shared lead's project on another
  // device, for one verified local task: answered there from its shared
  // knowledge without waking anything. Returns { ok: true, remote } with the
  // reply's validated fields only, or { ok: false, code } with a plain code.
  async function query(target, question, { taskContextToken, sourceApplication, from, signal }) {
    const { identity } = await connection();
    const now = clock();
    const assertion = { protocol: PEER_QUERY_PROTOCOL, messageId: idFactory(),
      from: { node: identity.fingerprint, agentId: from.agentId, name: from.name },
      to: { node: target.node, bindingId: target.bindingId, agentId: target.agentId }, query: question,
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + PEER_LIMITS.queryTtlSeconds * 1000).toISOString() };
    const issued = await host.issueRemoteOrigin({ taskContextToken, client: sourceApplication, messageId: assertion.messageId,
      digest: assertionDigest(assertion), targetNode: target.node, bindingId: target.bindingId, expiresAt: assertion.expiresAt,
      purpose: 'query' });
    if (issued.agent_id !== from.agentId) throw new PeerError('origin_mismatch', 'The local authority attributed this task to another Agent', 409);
    assertion.origin = issued.proof;
    let state;
    try {
      await post('/peer/1/messages', { assertion, signature: identity.sign(assertion) }, { signal });
      state = await waitFor(assertion.messageId, QUERY_WAIT_MS, { signal, pollMs: QUERY_POLL_MS });
    } catch (error) {
      if (signal?.aborted) throw error;
      return refused(error.code);
    }
    if (!TERMINAL_STATUSES.has(state.status)) {
      await cancel(assertion.messageId).catch(() => {});
      return refused('query_timeout');
    }
    if (state.status !== 'answered') return refused(state.error ?? state.status);
    const remote = parseQueryAnswer(state.reply, question.action);
    return remote ? { ok: true, remote } : refused('invalid_answer');
  }

  async function status(messageId, options) {
    return boundedState(await post('/peer/1/status', { messageId }, options));
  }

  async function cancel(messageId) {
    return boundedState(await post('/peer/1/cancel', { messageId }));
  }

  async function waitFor(messageId, timeoutMs, { signal, pollMs = statusPollMs } = {}) {
    const deadline = clock() + timeoutMs;
    let last = null;
    for (;;) {
      signal?.throwIfAborted();
      try { last = await status(messageId, { signal }); } catch (error) { if (!last) last = { status: 'queued', error: error.code }; }
      if (TERMINAL_STATUSES.has(last.status) || clock() >= deadline) return last;
      await delay(Math.min(pollMs, Math.max(0, deadline - clock())), undefined, { signal });
    }
  }

  function hasSent(messageId) {
    return configured() && Boolean(nodeStore().sent(messageId));
  }

  async function localAuthority() {
    return authorityFromProvider(await host.remoteOriginAuthority());
  }

  function close() {
    session?.client.close();
    session = null;
    store?.close();
    store = null;
  }

  return { ...createPeerChatPort({ connection, post, nodeStore, host, clock }),
    configured, isRemoteAddress, remoteAgents, resolveRemote, send, query, status, cancel, waitFor, hasSent, localAuthority,
    nodeStore, directory, idFactory, close };
}
