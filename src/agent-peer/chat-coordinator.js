import { createChatService } from '../agent-roundtable/chat-service.js';
import { verifyDeviceSignature } from './device-identity.js';
import { verifyOriginProof } from './origin-proof.js';
import { canonicalTime, PeerError } from './protocol.js';

// Separate protocol: a chat operation is never placed in the execution queue.
export function createCoordinatorChat({ store, identity, clock }) {
  const directory = () => store.nodes().filter(n => n.status === 'active').flatMap(node =>
    JSON.parse(node.directory_json).map(entry => ({ ...entry, node: node.id,
      address: `peer:${node.id.slice(0, 16)}:${entry.bindingId}` })));
  const chat = createChatService({ store: store.chat, transaction: store.transaction,
    scope: 'paired-chat', transport: 'peer', directory, clock });
  return {
    async execute(nodeId, { assertion, signature }) {
      const source = store.node(nodeId);
      if (!source || source.status !== 'active' || assertion?.protocol !== 'agent-chat/1' || assertion.from?.node !== nodeId
        || assertion.to?.node !== identity.fingerprint || assertion.to?.bindingId !== 'chat'
        || typeof assertion.messageId !== 'string' || assertion.messageId.length > 128) {
        throw new PeerError('chat_origin_rejected', 'Invalid chat origin', 403);
      }
      const issued = canonicalTime(assertion.issuedAt), expires = canonicalTime(assertion.expiresAt);
      if (issued === null || expires === null || issued > clock() + 60_000 || expires <= clock() || expires - issued > 120_000) {
        throw new PeerError('chat_origin_expired', 'The chat proof has expired', 410);
      }
      if (!verifyDeviceSignature(source.cert_pem, assertion, signature)) throw new PeerError('chat_origin_rejected', 'Invalid chat device signature', 403);
      const origin = verifyOriginProof(assertion, source.authority_json ? JSON.parse(source.authority_json) : null,
        { now: clock(), purpose: 'chat' });
      const sender = directory().find(m => m.node === nodeId && m.bindingId === assertion.from.bindingId
        && m.agentId === origin.agentId && m.projectId === origin.projectId);
      if (!sender) throw new PeerError('agent_not_shared', 'The current Agent is not actively shared for chat', 403);
      return chat({ address: sender.address }, assertion.request);
    },
    ownerRead: (nodeId, request) => chat({ owner: true, owns: m => m.node === nodeId }, request)
  };
}
