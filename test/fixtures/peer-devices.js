import { generateKeyPairSync, sign } from 'node:crypto';
import { rmSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadDeviceIdentity } from '../../packages/roundtable/src/peer/device-identity.js';
import { createPeerPort, peerDirectory } from '../../packages/roundtable/src/peer/peer-port.js';
import { createPeerRuntime } from '../../packages/roundtable/src/peer/peer-runtime.js';
import { canonicalJson, sha256Hex } from '../../packages/roundtable/src/peer/protocol.js';
import { createAgentRoundtable } from '../../packages/roundtable/src/roundtable/service.js';
import { createRoundtableStore } from '../../packages/roundtable/src/roundtable/store.js';
import { createFuliRoundtableHost } from '../../src/graphiti/roundtable-host.js';

// Signs exactly like the FULI Provider does: the private key stays in here.
export function signingAuthority() {
  const key = generateKeyPairSync('ed25519');
  const publicKey = key.publicKey.export({ format: 'jwk' }).x;
  return { keyId: sha256Hex(Buffer.from(publicKey, 'base64url')).slice(0, 32), publicKey, privateKey: key.privateKey };
}

// Every device of every test used to generate its own certificate, and no test
// depends on a fresh one. Each label's identity is made once per process and
// copied in, as on a device that already has one.
const identities = new Map();
let identityRoot = null;

function identityDirectory(label) {
  if (!identities.has(label)) identities.set(label, (async () => {
    identityRoot ??= mkdtemp(join(tmpdir(), 'fuli-peer-identities-')).then((root) => {
      process.once('exit', () => rmSync(root, { recursive: true, force: true }));
      return root;
    });
    const directory = join(await identityRoot, label);
    await loadDeviceIdentity(directory);
    return directory;
  })());
  return identities.get(label);
}

export async function device(label, { tamper = null, wake = null } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), `fuli-peer-${label}-`));
  await cp(await identityDirectory(label), peerDirectory(dataDir), { recursive: true });
  const spaceId = `${label}-space`;
  const projectId = `${label}-project`;
  const leadId = `${label}-lead`;
  const authority = signingAuthority();
  const calls = { grants: [], wakes: [], origins: [], snapshots: [], settled: [] };
  const memberId = `${label}-member`;
  const actorId = token => token?.includes('member-task') ? memberId : leadId;
  const personal = {
    getRemoteOriginAuthority: async () => ({ algorithm: 'Ed25519', key_id: authority.keyId, public_key: authority.publicKey }),
    issueRemoteAgentOrigin: async (input) => {
      calls.origins.push(input);
      const claims = { version: input.purpose === 'chat' ? 'fuli-chat-origin/1' : 'fuli-remote-origin/1', key_id: authority.keyId, space_id: spaceId, project_id: projectId,
        agent_id: actorId(input.task_context_token), task_hash: sha256Hex(input.task_context_token), message_id: input.message_id, digest: input.digest,
        target_node: input.target_node, binding_id: input.binding_id, issued_at: new Date().toISOString(),
        expires_at: input.expires_at, ...(input.purpose === 'chat' ? { purpose: 'chat' } : {}) };
      const payload = Buffer.from(canonicalJson(claims));
      let proof = { payload: payload.toString('base64url'), signature: sign(null, payload, authority.privateKey).toString('base64url') };
      if (tamper) proof = tamper(proof, claims, authority);
      return { agent_id: actorId(input.task_context_token), agent_name: 'Agent', proof };
    },
    issueRemoteAgentDelegation: async (input) => { calls.grants.push(input); return { token: `grant-${calls.grants.length}` }; },
    verifyAgentDelegation: async () => ({ redeemed: true }),
    revokeAgentDelegation: async () => ({}),
    recentAgentSessions: async () => [],
    getProjectAgentCoordinationPolicy: async () => ({ team_lead_agent_id: leadId, team_member_agent_ids: [] }),
    listProjectAgents: async () => [{ agent_id: leadId, profile: { status: 'active', name: `${label} lead` },
      assignments: [{ personal_project_id: projectId, status: 'active' }] },
      { agent_id: memberId, occupation: { role: 'tester' }, profile: { status: 'active', name: `${label} tester`, capabilities: ['testing'] },
        assignments: [{ personal_project_id: projectId, status: 'active' }] }],
    listPersonalProjects: async () => [{ project_id: projectId, name: `${label} project` }],
  };
  const app = {
    config: { personal: { spaceId } },
    personal,
    listProjectAgents: async () => [{ agentId: leadId, occupation: { role: 'engineer' },
      profile: { name: `${label} lead`, status: 'active', allowedClients: ['codex'], capabilities: ['build'] },
      assignments: [{ personalProjectId: projectId, status: 'active' }] },
      { agentId: memberId, occupation: { role: 'tester' },
        profile: { name: `${label} tester`, status: 'active', allowedClients: ['codex'], capabilities: ['testing'] },
        assignments: [{ personalProjectId: projectId, status: 'active' }] }],
    taskContextRegistry: { context: async token => ({ projectAgentId: actorId(token), personalProjectId: projectId,
      sourceApplication: 'codex', sessionId: `${label}-session` }) },
  };
  app.peer = createPeerPort({ dataDir, host: createFuliRoundtableHost(app), statusPollMs: 50 });
  const until = recordSteps(app.peer, calls, { chatWakeSnapshot: 'snapshots', waitFor: 'settled' });
  app.roundtable = createAgentRoundtable({ host: createFuliRoundtableHost(app), peer: app.peer, openStore: () => createRoundtableStore(), clientAvailable: () => true,
    wake: async (input) => { calls.wakes.push(input);
      return wake ? wake(input) : { body: `${label} answers`, sessionId: `${label}-woken` }; } });
  const folder = join(dataDir, 'project-folder');
  app.projectPathResolver = (path) => path === folder
    ? { status: 'matched', personalProjectId: projectId } : { status: 'unmatched', personalProjectId: null };
  const runtime = createPeerRuntime({ host: createFuliRoundtableHost(app), roundtable: app.roundtable, port: app.peer, allowLoopback: true, claimWaitMs: 300, interfaces: () => ({}) });
  return { app, runtime, calls, until, projectId, folder, close: async () => {
    await runtime.close(); await app.roundtable.close(); app.peer.close(); await rm(dataDir, { recursive: true, force: true });
  } };
}

// Records what the named peer port calls returned, so a test awaits the step it
// depends on instead of sleeping. A chat wake loop reads a snapshot before each
// wake and waits for that wake to settle, so these are its observable steps.
function recordSteps(port, calls, methods) {
  const waiting = [];
  for (const [method, kind] of Object.entries(methods)) {
    const original = port[method];
    port[method] = async (...args) => {
      const value = await original(...args);
      calls[kind].push(value);
      for (const waiter of waiting.filter((entry) => entry.kind === kind && entry.matches(value))) {
        waiting.splice(waiting.indexOf(waiter), 1);
        waiter.resolve(value);
      }
      return value;
    };
  }
  return (kind, matches) => {
    const index = calls[kind].findIndex(matches);
    if (index >= 0) return Promise.resolve(calls[kind][index]);
    const waiter = { kind, matches, ...Promise.withResolvers() };
    waiting.push(waiter);
    return waiter.promise;
  };
}

export async function pair(coordinator, member, { folder = true } = {}) {
  await coordinator.runtime.enableCoordinator({ host: '127.0.0.1', port: 0, name: 'Coordinator' });
  const { invitation } = coordinator.runtime.createInvitation();
  await member.runtime.join({ invitation, name: 'Member' });
  await member.runtime.setShares({ shares: [{ projectId: member.projectId, clients: ['codex'],
    ...(folder ? { workingDirectory: member.folder } : {}) }] });
}

export async function remoteAddress(app) {
  for (let index = 0; index < 50; index += 1) {
    const found = await app.roundtable.findAgents({});
    if (found.remoteAgents?.length) return found.remoteAgents[0].address;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('No remote Agent appeared');
}
