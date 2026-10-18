import { randomUUID } from 'node:crypto';
import { assertionDigest } from './origin-proof.js';
import { PeerError } from './protocol.js';
import { parseChatRequest, parseChatResult } from '../agent-roundtable/chat-contract.js';

export function createPeerChatPort({ connection, post, nodeStore, provider, spaceId, clock }) {
  return {
    async chat({ request: raw, taskContextToken, sourceApplication, agentId, projectId, name }) {
      let request = parseChatRequest(raw);
      const { identity, fingerprint } = await connection();
      const shares = nodeStore().shares().filter(s => s.spaceId === spaceId());
      const source = shares.find(s => s.agentId === agentId && s.projectId === projectId);
      if (!source) throw new PeerError('agent_not_shared', 'The owner must explicitly share this Agent before cross-device chat', 403);
      const address = value => {
        if (!value.startsWith('local:')) return value;
        const share = shares.find(s => s.agentId === value.slice(6) && s.projectId === projectId);
        if (!share) throw new PeerError('agent_not_shared', 'A local group member must be explicitly shared for cross-device chat', 403);
        return `peer:${identity.fingerprint.slice(0, 16)}:${share.bindingId}`;
      };
      if (request.members) request = { ...request, members: request.members.map(address) };
      if (request.add) request = { ...request, add: request.add.map(address), remove: request.remove.map(address),
        ...(request.owner ? { owner: address(request.owner) } : {}) };
      const now = clock();
      const assertion = { protocol: 'agent-chat/1', messageId: randomUUID(),
        from: { node: identity.fingerprint, agentId, bindingId: source.bindingId, name },
        to: { node: fingerprint, bindingId: 'chat' }, request,
        issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() };
      const issued = await provider.issueRemoteAgentOrigin({ personal_space_id: spaceId(), task_context_token: taskContextToken,
        source_application: sourceApplication, message_id: assertion.messageId, digest: assertionDigest(assertion),
        target_node: fingerprint, binding_id: 'chat', expires_at: assertion.expiresAt, purpose: 'chat' });
      if (issued.agent_id !== agentId) throw new PeerError('origin_mismatch', 'The local authority attributed this chat to another Agent', 409);
      assertion.origin = issued.proof;
      return parseChatResult(await post('/peer/1/chat', { assertion, signature: identity.sign(assertion) }));
    },
    chatOwner: async request => parseChatResult(await post('/peer/1/chat/read', request))
  };
}
