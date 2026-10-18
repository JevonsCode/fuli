import { createChatWake } from './chat-wake.js';
import { PeerError } from '../agent-peer/protocol.js';
import { createChatService } from './chat-service.js';
import { activeAgentRequestSignal, activeSealedWorkerRequest } from '../app/agent-request-context.js';

// The current task supplies the sender. Neither MCP nor HTTP accepts a from ID.
export function createAgentChat({ app, store, agents, idFactory, messageAgent, canWake, waitUntilIdle }) {
  const scope = app.config.personal.spaceId;
  const local = createChatService({ store: new Proxy({}, { get: (_, key) => store.chat[key] }),
    transaction: work => store.transaction(work), scope, transport: 'local', idFactory,
    directory: async () => (await agents()).map(a => ({ address: `local:${a.agentId}`, agentId: a.agentId,
      name: a.profile.displayName || a.profile.name || a.agentId })) });
  const wakes = createChatWake({ store: new Proxy({}, { get: (_, key) => store.chat[key] }), scope, messageAgent, waitUntilIdle, transaction: work => store.transaction(work) });
  return {
    closeChatWakes: wakes.close,
    subscribeChatUpdates(listener) {
      let known = new Map(store.chat.heads(scope).map(head => [head.chatId, `${head.revision}:${head.seq}`]));
      const stopPeer = app.peer?.configured() ? app.peer.subscribeChatUpdates?.(listener) : null;
      const stopLocal = store.chat.subscribe(error => {
        if (error) return listener(null, error);
        const next = new Map();
        for (const head of store.chat.heads(scope)) {
          const version = `${head.revision}:${head.seq}`;
          next.set(head.chatId, version);
          if (known.get(head.chatId) !== version) listener({ chatId: head.chatId, seq: head.seq });
        }
        known = next;
      });
      return () => { stopLocal(); stopPeer?.(); };
    },
    async chat(input, options = {}) {
      options = { ...options, signal: options.signal ?? activeAgentRequestSignal() };
      options.signal?.throwIfAborted();
      const { taskContextToken, sourceApplication = 'other' } = input;
      const transport = input.transport;
      if (transport !== undefined && !['local', 'peer'].includes(transport)) throw new PeerError('invalid_chat', 'Unknown chat transport', 422);
      const request = { ...input };
      delete request.taskContextToken; delete request.sourceApplication; delete request.sourceSessionId;
      delete request.transport;
      const task = await app.taskContextRegistry.context(taskContextToken, sourceApplication);
      if (!task?.projectAgentId || !task.personalProjectId || task.completed || task.checkpoint?.phase === 'complete') {
        throw new PeerError('chat_task_required', 'Chat requires an active current Agent project task', 409);
      }
      if (activeSealedWorkerRequest() || task.agentMemoryScope === 'task_only' || task.turnId?.startsWith('worker-run:')) {
        throw new PeerError('chat_task_restricted', 'A restricted worker cannot open other Agent communications', 403);
      }
      const currentAgents = await agents();
      const sender = currentAgents.find(a => a.agentId === task.projectAgentId);
      if (!sender) throw new PeerError('chat_agent_inactive', 'The current Agent must be active', 403);
      const authorize = async () => {
        const current = await app.taskContextRegistry.context(taskContextToken, sourceApplication);
        if (!current || current.completed || current.checkpoint?.phase === 'complete' || current.projectAgentId !== sender.agentId
          || current.personalProjectId !== task.personalProjectId || !(await agents()).some(a => a.agentId === sender.agentId)) {
          throw new PeerError('chat_task_required', 'Chat requires an active current Agent project task', 409);
        }
      };
      const remote = transport === 'peer' || request.chatId?.startsWith('peer:') || request.members?.some(a => a.startsWith('peer:'));
      if (remote) {
        if (!app.peer?.chat) throw new PeerError('chat_peer_unavailable', 'Cross-device chat requires paired devices', 409);
        const identity = { taskContextToken, sourceApplication, agentId: sender.agentId,
          projectId: task.personalProjectId, name: sender.profile.displayName || sender.profile.name || sender.agentId };
        const result = await app.peer.chat({ request, ...identity, ...options,
          onMessage: delivery => wakes.dispatch(delivery, { taskContextToken, sourceApplication, authorize,
            remoteSnapshot: (chatId, to, signal) => app.peer.chatWakeSnapshot({ ...identity, signal,
              request: { action: 'wake_snapshot', chatId, to } }) }) });
        await authorize();
        return result;
      }
      const result = await local({ address: `local:${sender.agentId}` }, request, { ...options, authorize,
        onMessage: delivery => wakes.dispatch({ ...delivery, targets: delivery.targets.filter(address =>
          currentAgents.some(agent => address === `local:${agent.agentId}` && canWake(agent))) }, { taskContextToken, sourceApplication, authorize }) });
      if (request.action === 'list' && !transport && app.peer?.chat && app.peer.configured()) {
        try {
          const peer = await app.peer.chat({ request, taskContextToken, sourceApplication, agentId: sender.agentId,
            projectId: task.personalProjectId, name: sender.profile.displayName || sender.profile.name || sender.agentId, ...options });
          result.chats.push(...peer.chats);
          result.remotePage = { hasMore: peer.hasMore, nextChat: peer.nextChat };
        } catch (error) { result.remoteUnavailable = error.code ?? 'coordinator_unreachable'; }
      }
      return result;
    },
    async chatOwner({ transport, ...request }) {
      if (transport !== undefined && !['local', 'peer'].includes(transport)) throw new PeerError('invalid_chat', 'Unknown chat transport', 422);
      if (transport === 'peer' || request.chatId?.startsWith('peer:')) {
        if (!app.peer?.chatOwner) throw new PeerError('chat_peer_unavailable', 'Cross-device chat requires paired devices', 409);
        return app.peer.chatOwner(request);
      }
      const result = await local({ owner: true, owns: () => true }, request);
      if (request.action === 'list' && !transport && app.peer?.chatOwner && app.peer.configured()) {
        try { const peer = await app.peer.chatOwner(request);
          result.chats.push(...peer.chats); result.remotePage = { hasMore: peer.hasMore, nextChat: peer.nextChat }; }
        catch (error) { result.remoteUnavailable = error.code ?? 'coordinator_unreachable'; }
      }
      return result;
    }
  };
}
