import { z } from 'zod';
import { chatSnapshot, chatWakePrompt, parseChatSnapshot } from '../roundtable/chat-snapshot.js';
import { waitForChatUpdates } from '../roundtable/chat-updates.js';
import { createChatService } from '../roundtable/chat-service.js';
import { verifyDeviceSignature } from './device-identity.js';
import { verifyOriginProof } from './origin-proof.js';
import { canonicalTime, PeerError } from './protocol.js';

// Chat itself grants no execution. A separate, signed execution assertion is
// required to deliver a snapshot to an already executable shared lead.
export function createCoordinatorChat({ store, identity, clock }) {
  const directory = () => store.nodes().filter(n => n.status === 'active').flatMap(node =>
    JSON.parse(node.directory_json).map(entry => ({ ...entry, node: node.id,
      address: `peer:${node.id.slice(0, 16)}:${entry.bindingId}` })));
  const chat = createChatService({ store: store.chat, transaction: store.transaction,
    scope: 'paired-chat', transport: 'peer', directory, clock });
  return {
    async execute(nodeId, { assertion, signature }, options = {}) {
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
      const authorize = () => {
        if (store.node(nodeId)?.status !== 'active' || !directory().some(m => m.address === sender.address
          && m.agentId === sender.agentId && m.projectId === sender.projectId)) {
          throw new PeerError('agent_not_shared', 'The current chat sharing was revoked', 403);
        }
      };
      if (assertion.request?.action === 'wake_snapshot') {
        const request = z.object({ action: z.literal('wake_snapshot'), chatId: z.string().min(1).max(160),
          to: z.string().min(1).max(300) }).strict().safeParse(assertion.request);
        if (!request.success) throw new PeerError('invalid_chat', 'Invalid chat snapshot request', 422);
        authorize();
        const room = store.chat.get(request.data.chatId), members = store.chat.members(request.data.chatId);
        if (!room || room.scope !== 'paired-chat' || !members.some(m => m.address === sender.address)) {
          throw new PeerError('chat_not_found', 'Chat not found for this member', 404);
        }
        const target = directory().find(m => m.address === request.data.to && !m.communicationOnly);
        if (!target || target.node === nodeId || !members.some(m => m.address === target.address)
          || store.chat.waiting('paired-chat', target.address, room.id)) return { snapshot: null };
        return { snapshot: chatSnapshot(store.chat, room.id, target.address, members.find(m => m.address === sender.address).joinedSeq) };
      }
      let delivery;
      const result = await chat({ address: sender.address }, assertion.request, { ...options, authorize,
        onMessage: value => { delivery = value; } });
      return delivery ? { ...result, wakeTargets: delivery.targets.filter(address => directory().some(m =>
        m.address === address && m.node !== nodeId && !m.communicationOnly)) } : result;
    },
    validateWake(assertion) {
      if (!assertion.chatWake) return;
      const snapshot = parseChatSnapshot(assertion.chatWake);
      const senderNode = store.node(assertion.from.node);
      const origin = verifyOriginProof(assertion, JSON.parse(senderNode.authority_json), { now: clock() });
      const sender = directory().find(m => m.node === assertion.from.node && m.agentId === origin.agentId && m.projectId === origin.projectId);
      const address = `peer:${assertion.to.node.slice(0,16)}:${assertion.to.bindingId}`;
      const target = directory().find(m => m.address === address && !m.communicationOnly);
      const room = store.chat.get(snapshot.chatId), members = store.chat.members(snapshot.chatId);
      const member = members.find(m => m.address === address);
      if (!sender || !target || !room || room.scope !== 'paired-chat' || !member || !members.some(m => m.address === sender.address)
        || snapshot.after < member.joinedSeq || snapshot.after < members.find(m => m.address === sender.address)?.joinedSeq || snapshot.nextAfter !== snapshot.messages.at(-1).seq
        || store.chat.waiting('paired-chat', address, room.id) || assertion.body !== chatWakePrompt(snapshot)) {
        throw new PeerError('chat_wake_rejected', 'The chat snapshot cannot authorize this execution', 403);
      }
      if (snapshot.after < Math.max(member.joinedSeq, store.chat.readCursor(room.id, address))
        || snapshot.messages.some(message => store.chat.delivered(room.id,address,message.seq))) {
        throw new PeerError('chat_wake_stale', 'The chat snapshot was already consumed; read a fresh snapshot', 409);
      }
      // Validate the shown immutable rows, not newly arriving messages. The
      // ordinary execution origin/delegation remains required and separate.
      const expected = store.chat.unreadMessages(room.id, address, snapshot.after, 101)
        .filter(row => row.seq <= snapshot.nextAfter);
      if (expected.length !== snapshot.messages.length || expected.some((row, i) => {
        const item = snapshot.messages[i];
        return row.seq !== item.seq || row.sender !== item.from || !row.body.startsWith(item.body)
          || (row.body.length > item.body.length) !== Boolean(item.bodyTruncated);
      })) throw new PeerError('chat_wake_rejected', 'The unread snapshot does not match stored chat', 403);
    },
    acknowledgeWake(assertion) {
      if (!assertion.chatWake) return;
      const address = `peer:${assertion.to.node.slice(0,16)}:${assertion.to.bindingId}`;
      const member = store.chat.members(assertion.chatWake.chatId).find(m => m.address === address);
      if (member && member.joinedSeq <= assertion.chatWake.after) {
        store.chat.markDelivered(assertion.chatWake.chatId, address, assertion.chatWake.messages.map(message => message.seq));
      }
    },
    ownerUpdates: (nodeId, request, { signal } = {}) => waitForChatUpdates({ store: store.chat, scope: 'paired-chat',
      owns: m => m.node === nodeId, request, signal, authorize: () => {
        if (store.node(nodeId)?.status !== 'active') throw new PeerError('device_not_trusted', 'This device is not paired', 403);
      } }),
    ownerRead: (nodeId, request) => chat({ owner: true, owns: m => m.node === nodeId }, request)
  };
}
