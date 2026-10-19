import { createHash, createPrivateKey, sign } from 'node:crypto';
import { resolve, sep } from 'node:path';

import { assertRoundtableHost } from '../host.js';
import { RoundtableError } from '../errors.js';

const MAX_ORIGIN_MS = 30 * 60 * 1000;
const sameFolder = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (folder, path) => sameFolder(folder, path)
  || (process.platform === 'win32' ? path.toLowerCase() : path).startsWith(
    (process.platform === 'win32' ? folder.toLowerCase() : folder).replace(/[\\/]?$/, sep));

// A standalone Roundtable without FULI: each registered Agent is the lead of
// the one folder it was registered with. There is no memory to restore, so a
// woken session is verified by answering from the session its grant was bound to.
export function createStandaloneHost({ store, now = () => Date.now() }) {
  let space = null;
  const spaceId = () => (space ??= store.spaceId());
  const active = () => store.agents().filter(agent => agent.profile.status === 'active');
  const agent = agentId => active().find(item => item.agentId === agentId) ?? null;
  const project = item => ({ projectId: item.agentId, name: item.profile.name, temporary: false,
    archived: item.profile.status !== 'active' });
  const person = item => ({ agentId: item.agentId, name: item.profile.name, employeeNumber: item.employeeNumber,
    responsibility: item.profile.responsibility });
  const task = (token, client = null) => {
    const row = store.task(token);
    if (!row || (client && client !== row.client)) throw new RoundtableError('validation', 'Task context not found for this client');
    return row;
  };
  const denied = (message, status = 403) => new RoundtableError('roundtable_denied', message, { status });

  return assertRoundtableHost({
    spaceId,
    listAgents: async () => store.agents(),
    // Client sessions are not indexed yet; every wake starts fresh in the Agent's folder.
    recentSessions: async () => [],
    async taskContext(token, client) {
      const row = task(token, client);
      return { projectAgentId: row.agent_id, personalProjectId: row.agent_id, sourceApplication: row.client, sessionId: row.session_id };
    },
    listProjects: async () => store.agents().map(project),
    async getProject(projectId) {
      const item = store.agents().find(entry => entry.agentId === projectId);
      if (!item) throw new RoundtableError('not_found', 'No Agent is registered for that project');
      return project(item);
    },
    projectLeadId: async projectId => agent(projectId)?.agentId ?? null,
    staffProjectLead: async () => ({ status: 'unavailable', reason: 'register_agent' }),
    async projectTeam(projectId) {
      const lead = agent(projectId);
      return { lead: lead ? person(lead) : null, people: lead ? [person(lead)] : [] };
    },
    projectFolder: async projectId => agent(projectId)?.folder ?? null,
    async projectForPath(path) {
      const target = resolve(path);
      const matches = active().filter(item => inside(item.folder, target)).sort((a, b) => b.folder.length - a.folder.length);
      return matches[0]?.agentId ?? null;
    },

    async issueDelegation({ taskContextToken, client, agentId, targetClient, targetSessionId = null, lifetimeSeconds }) {
      task(taskContextToken, client);
      const target = agent(agentId);
      if (!target || !target.profile.allowedClients.includes(targetClient)) throw denied('The receiving Agent is unavailable in this client');
      return { token: store.issueDelegation({ agentId, client: targetClient, sessionId: targetSessionId, lifetimeSeconds }) };
    },
    async issueRemoteDelegation({ projectId, agentId, targetClient, targetSessionId = null, lifetimeSeconds, originNode, originMessageId, originAttemptId }) {
      const target = agent(agentId);
      if (!target || projectId !== agentId) throw denied('Remote devices can only ask the project lead');
      if (!target.profile.allowedClients.includes(targetClient)) throw denied('The receiving Agent is unavailable in this client');
      const token = store.issueDelegation({ agentId, client: targetClient, sessionId: targetSessionId, lifetimeSeconds,
        originKey: `${originNode}:${originMessageId}:${originAttemptId}` });
      if (!token) throw new RoundtableError('attempt_already_granted', 'This remote delivery attempt already received authority', { status: 409 });
      return { token };
    },
    async sealDelegation({ token, sessionId }) {
      if (!store.sealDelegation(token, sessionId)) {
        throw new RoundtableError('delegation_unavailable', 'Delegation expired or another session is already bound', { status: 409 });
      }
      return { sealed: true };
    },
    async verifyDelegation({ token, sessionId }) {
      const grant = store.delegation(token);
      return { redeemed: Boolean(grant?.sealed && grant.session_id === sessionId), memoryResultCount: 0 };
    },
    revokeDelegation: async ({ token }) => store.revokeDelegation(token),

    async issueRemoteOrigin({ taskContextToken, client, messageId, digest, targetNode, bindingId, expiresAt, purpose = 'execution' }) {
      const row = task(taskContextToken, client);
      const sender = agent(row.agent_id);
      if (!sender) throw denied('The sending Agent is not active');
      const expires = Date.parse(expiresAt);
      if (!(expires > now()) || expires - now() > MAX_ORIGIN_MS) {
        throw new RoundtableError('validation', 'A remote ask needs a lifetime of at most 30 minutes');
      }
      if (!store.recordOrigin({ messageId, digest, agentId: sender.agentId, purpose })) {
        throw new RoundtableError('origin_conflict', 'This message ID already belongs to a different remote ask', { status: 409 });
      }
      const key = store.originKey();
      const claims = { version: purpose === 'chat' ? 'fuli-chat-origin/1' : 'fuli-remote-origin/1', key_id: key.keyId,
        space_id: spaceId(), project_id: sender.agentId, agent_id: sender.agentId,
        task_hash: createHash('sha256').update(taskContextToken).digest('hex'), message_id: messageId, digest,
        target_node: targetNode, binding_id: bindingId, issued_at: new Date(now()).toISOString(), expires_at: expiresAt,
        ...(purpose === 'chat' ? { purpose: 'chat' } : {}) };
      const payload = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(claims).sort(([a], [b]) => a < b ? -1 : 1))));
      const privateKey = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', d: key.privateKey, x: key.publicKey }, format: 'jwk' });
      return { agent_id: sender.agentId, agent_name: sender.profile.name,
        proof: { payload: payload.toString('base64url'), signature: sign(null, payload, privateKey).toString('base64url') } };
    },
    async remoteOriginAuthority() {
      const key = store.originKey();
      return { algorithm: 'Ed25519', key_id: key.keyId, public_key: key.publicKey };
    }
  });
}
