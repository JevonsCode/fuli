import { z } from 'zod';
import { parseChatSnapshot } from '../agent-roundtable/chat-snapshot.js';
import { setTimeout as delay } from 'node:timers/promises';
import { parseChatUpdates } from '../agent-roundtable/chat-updates.js';
import { randomUUID } from 'node:crypto';
import { assertionDigest } from './origin-proof.js';
import { PeerError } from './protocol.js';
import { parseChatRequest, parseChatResult } from '../agent-roundtable/chat-contract.js';

export function createPeerChatPort({ connection, post, nodeStore, provider, spaceId, clock }) {
  async function chat({ request: raw, taskContextToken, sourceApplication, agentId, projectId, name, signal, onMessage }, { snapshot = false } = {}) {
      let request = snapshot ? raw : parseChatRequest(raw);
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
      const response = await post('/peer/1/chat', { assertion, signature: identity.sign(assertion) },
        { signal, ...(request.action === 'wait' ? { timeoutMs: (request.timeoutSeconds + 15) * 1000 } : {}) });
      if (!nodeStore().shares().some(s => s.spaceId === spaceId() && s.agentId === agentId && s.projectId === projectId)) {
        throw new PeerError('agent_not_shared', 'The current chat sharing was revoked', 403);
      }
      if (snapshot) return response.snapshot === null ? null : parseChatSnapshot(response.snapshot);
      const { wakeTargets, ...value } = response;
      const result = parseChatResult(value);
      if (wakeTargets !== undefined) {
        const targets = z.array(z.string().min(1).max(300)).max(31).safeParse(wakeTargets);
        if (!targets.success) throw new PeerError('invalid_chat_response', 'Invalid chat wake recipients', 502);
        onMessage?.({ chatId: request.chatId, targets: targets.data });
      }
      return result;
  }
  return { chat, chatWakeSnapshot: input => chat(input, { snapshot: true }),
    subscribeChatUpdates(listener) {
      const controller = new AbortController();
      const run = async () => {
        let after = 0, retryMs = 1000, connected = false;
        while (!controller.signal.aborted) {
          try {
            const page = parseChatUpdates(await post('/peer/1/chat/updates', { after },
              { signal: controller.signal, timeoutMs: 75_000 }));
            if (!connected) listener(null, null, 'ready');
            connected = true; retryMs = 1000; after = page.nextAfter;
            for (const update of page.updates) listener(update);
          } catch (error) {
            if (controller.signal.aborted) break;
            listener(null, error); connected = false;
            // Transport reconnection only. Message arrival still blocks on a
            // native commit notification; there is no periodic inbox scan.
            await delay(retryMs, undefined, { signal: controller.signal });
            retryMs = Math.min(retryMs * 2, 30_000);
          }
        }
      };
      void run().catch(error => { if (!controller.signal.aborted) listener(null, error); });
      return () => controller.abort();
    },
    chatOwner: async request => parseChatResult(await post('/peer/1/chat/read', request))
  };
}
