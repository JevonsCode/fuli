import { PeerError } from '../agent-peer/protocol.js';
import { createChatService } from './chat-service.js';

// The current task supplies the sender. Neither MCP nor HTTP accepts a from ID.
export function createAgentChat({ app, store, agents, idFactory }) {
  const scope = app.config.personal.spaceId;
  const local = createChatService({ store: new Proxy({}, { get: (_, key) => store.chat[key] }),
    transaction: work => store.transaction(work), scope, transport: 'local', idFactory,
    directory: async () => (await agents()).map(a => ({ address: `local:${a.agentId}`, agentId: a.agentId,
      name: a.profile.displayName || a.profile.name || a.agentId })) });
  return {
    async chat(input) {
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
      if (task.agentMemoryScope || task.roundtableDelegation) throw new PeerError('chat_task_restricted', 'A restricted worker cannot open other Agent communications', 403);
      const sender = (await agents()).find(a => a.agentId === task.projectAgentId);
      if (!sender) throw new PeerError('chat_agent_inactive', 'The current Agent must be active', 403);
      const remote = transport === 'peer' || request.chatId?.startsWith('peer:') || request.members?.some(a => a.startsWith('peer:'));
      if (remote) {
        if (!app.peer?.chat) throw new PeerError('chat_peer_unavailable', 'Cross-device chat requires paired devices', 409);
        return app.peer.chat({ request, taskContextToken, sourceApplication, agentId: sender.agentId,
          projectId: task.personalProjectId, name: sender.profile.displayName || sender.profile.name || sender.agentId });
      }
      const result = await local({ address: `local:${sender.agentId}` }, request);
      if (request.action === 'list' && !transport && app.peer?.chat && app.peer.configured()) {
        try {
          const peer = await app.peer.chat({ request, taskContextToken, sourceApplication, agentId: sender.agentId,
            projectId: task.personalProjectId, name: sender.profile.displayName || sender.profile.name || sender.agentId });
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
