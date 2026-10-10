import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { loadDeviceIdentity } from './device-identity.js';
import { createNodeStore } from './node-store.js';
import { assertionDigest, authorityFromProvider } from './origin-proof.js';
import { createPeerClient } from './peer-transport.js';
import { PEER_LIMITS, PEER_PROTOCOL, PeerError, TERMINAL_STATUSES } from './protocol.js';

const ADDRESS = /^peer:([0-9a-f]{16}):([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;
const STATUS_POLL_MS = 2_000;
const PROOF_MARGIN_MS = 60_000;

export function peerDirectory(dataDir) {
  return join(dataDir, 'peer');
}

// What Agents on this device use to reach shared project leads on other paired
// devices. It never pairs, shares or listens: those stay with the local owner.
export function createPeerPort({ dataDir, provider, spaceId, clock = Date.now, idFactory = randomUUID,
  statusPollMs = STATUS_POLL_MS }) {
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
      client: createPeerClient({ identity, coordinator: current.coordinator }) };
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

  async function remoteAgents({ query = null } = {}) {
    let devices;
    try { devices = await remoteDirectory(); }
    catch (error) { return { agents: [], unavailable: error.code ?? 'coordinator_unreachable' }; }
    if (!devices) return null;
    const needle = query?.trim().toLowerCase();
    const agents = devices.flatMap((device) => device.agents.map((agent) => ({
      address: `peer:${device.nodeId.slice(0, 16)}:${agent.bindingId}`, name: agent.name, role: 'shared_project_lead',
      employeeNumber: agent.employeeNumber, responsibility: agent.responsibility, projectName: agent.projectName,
      device: { name: device.name, online: device.online } })))
      .filter((agent) => !needle || [agent.name, agent.projectName, agent.responsibility, agent.device.name]
        .some((value) => value?.toLowerCase().includes(needle)));
    return { agents: agents.slice(0, 50) };
  }

  async function resolveRemote(to) {
    const match = ADDRESS.exec(String(to ?? '').trim());
    if (!match) throw new PeerError('invalid_address', 'Remote Agents are addressed as peer:<device>:<binding> from find_agents');
    const device = (await remoteDirectory() ?? []).find((entry) => entry.nodeId.startsWith(match[1]));
    const agent = device?.agents.find((entry) => entry.bindingId === match[2]);
    if (!agent) throw new PeerError('agent_not_shared', 'That remote Agent is not shared any more; call find_agents again', 404);
    return { address: match[0], node: device.nodeId, bindingId: agent.bindingId, agentId: agent.agentId,
      name: agent.name, deviceName: device.name };
  }

  // The task token is only used with this device's own authority; the remote
  // device receives the authority's signed statement, never the token.
  async function send({ messageId, threadId, target, body, conversation, depth, from, taskContextToken, sourceApplication }) {
    const { identity } = await connection();
    const now = clock();
    const assertion = { protocol: PEER_PROTOCOL, messageId, threadId,
      from: { node: identity.fingerprint, agentId: from.agentId, name: from.name, client: from.client },
      to: { node: target.node, bindingId: target.bindingId, agentId: target.agentId },
      body, conversation, depth,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + PEER_LIMITS.defaultTtlSeconds * 1000 - PROOF_MARGIN_MS).toISOString() };
    const issued = await provider.issueRemoteAgentOrigin({ personal_space_id: spaceId(), task_context_token: taskContextToken,
      source_application: sourceApplication, message_id: messageId, digest: assertionDigest(assertion),
      target_node: target.node, binding_id: target.bindingId, expires_at: assertion.expiresAt });
    if (issued.agent_id !== from.agentId) throw new PeerError('origin_mismatch', 'The local authority attributed this task to another Agent', 409);
    assertion.origin = issued.proof;
    nodeStore().recordSent({ messageId, targetNode: target.node, bindingId: target.bindingId });
    return post('/peer/1/messages', { assertion, signature: identity.sign(assertion) });
  }

  async function status(messageId, options) {
    return post('/peer/1/status', { messageId }, options);
  }

  async function cancel(messageId) {
    return post('/peer/1/cancel', { messageId });
  }

  async function waitFor(messageId, timeoutMs) {
    const deadline = clock() + timeoutMs;
    let last = null;
    for (;;) {
      try { last = await status(messageId); } catch (error) { if (!last) last = { status: 'queued', error: error.code }; }
      if (TERMINAL_STATUSES.has(last.status) || clock() >= deadline) return last;
      await delay(Math.min(statusPollMs, Math.max(0, deadline - clock())));
    }
  }

  function hasSent(messageId) {
    return configured() && Boolean(nodeStore().sent(messageId));
  }

  async function localAuthority() {
    return authorityFromProvider(await provider.getRemoteOriginAuthority(spaceId()));
  }

  function close() {
    session?.client.close();
    session = null;
    store?.close();
    store = null;
  }

  return { configured, isRemoteAddress, remoteAgents, resolveRemote, send, status, cancel, waitFor, hasSent, localAuthority,
    nodeStore, directory, idFactory, close };
}
