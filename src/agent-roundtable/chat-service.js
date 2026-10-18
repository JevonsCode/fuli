import { waitForChatChange } from './chat-wait.js';
import { randomUUID } from 'node:crypto';
import { canonicalJson } from '../publication/canonical-json.js';
import { PeerError } from '../agent-peer/protocol.js';
import { CHAT_LIMITS, parseChatRequest } from './chat-contract.js';

// Only message membership is granted here. No execution, knowledge or weight ports.
export function createChatService({ store, transaction, scope, transport, directory, idFactory = randomUUID, clock = Date.now }) {
  const error = (code, message, status = 403) => { throw new PeerError(code, message, status); };
  const member = (chatId, actor) => store.members(chatId).find(m => m.address === actor.address);
  const visible = (room, actor) => actor.owner ? store.members(room.id).some(m => actor.owns(m)) : Boolean(member(room.id, actor));
  const view = room => ({ chatId: room.id, kind: room.kind, title: room.title, owner: room.owner, revision: room.revision,
    members: store.members(room.id).map(({ address, agentId, name, node, joinedSeq }) => ({ address, agentId, name,
      ...(node ? { node } : {}), joinedSeq })), transport, createdAt: room.created_at, updatedAt: room.updated_at });
  function get(id, actor) {
    const room = store.get(id);
    if (!room || room.scope !== scope || !visible(room, actor)) error('chat_not_found', 'Chat not found for this member', 404);
    return room;
  }
  async function execute(actor, raw, { signal, authorize, onMessage } = {}) {
    signal?.throwIfAborted();
    await authorize?.();
    signal?.throwIfAborted();
    const request = parseChatRequest(raw);
    if (request.action === 'wait') {
      if (actor.owner) error('chat_owner_read_only', 'The owner view is read only');
      const { timeoutSeconds, ...page } = request;
      const release = store.beginWait(scope, actor.address, request.chatId, timeoutSeconds);
      try { return await waitForChatChange(() => execute(actor, { ...page, action: 'read' }, { authorize, signal }),
        { store, timeoutSeconds, signal, ready: page => page.messages.length > 0 }); }
      finally { release(); }
    }
    if (actor.owner && !['list', 'read'].includes(request.action)) error('chat_owner_read_only', 'The owner view is read only');
    const known = ['create', 'members'].includes(request.action) ? await directory() : [];
    const resolve = address => known.find(m => m.address === address) ?? error('chat_member_unavailable', `No active shared Agent at ${address}`, 404);
    let delivered;
    const result = transaction(() => {
      const at = new Date(clock()).toISOString();
      if (request.action === 'list') {
        const all = store.list(scope).filter(room => visible(room, actor));
        const cursor = request.afterChat ? all.findIndex(room => room.id === request.afterChat) : -1;
        if (request.afterChat && cursor < 0) error('chat_not_found', 'List cursor not found for this member; restart the list', 404);
        const rows = all.slice(cursor + 1), chats = []; let bytes = 0;
        for (const room of rows.slice(0, request.limit)) {
          const item = view(room), size = Buffer.byteLength(JSON.stringify(item));
          if (chats.length && bytes + size > CHAT_LIMITS.readBytes) break;
          chats.push(item); bytes += size;
        }
        return { chats, hasMore: rows.length > chats.length, nextChat: chats.at(-1)?.chatId ?? null };
      }
      if (request.action === 'create') {
        const addresses = [...new Set([actor.address, ...request.members])].sort();
        if (addresses.length < 2 || addresses.length > CHAT_LIMITS.members || (request.kind === 'direct' && addresses.length !== 2)) {
          error('invalid_chat', 'A direct chat needs exactly two members; groups need 2–32', 422);
        }
        const payload = canonicalJson({ ...request, members: addresses });
        const saved = store.request(scope, actor.address, request.requestId);
        if (saved) {
          if (saved.payload !== payload) error('chat_conflict', 'This request ID belongs to a different chat', 409);
          return view(get(saved.chat_id, actor));
        }
        const profiles = addresses.map(resolve);
        const directKey = request.kind === 'direct' ? canonicalJson(addresses) : null;
        const existing = directKey ? store.direct(scope, directKey) : null;
        const id = existing?.id ?? `${transport}:${idFactory()}`;
        if (!existing) {
          store.create({ id, scope, kind: request.kind, title: request.title ?? profiles.map(m => m.name).join(', ').slice(0, 160),
            owner: actor.address, directKey, at });
          for (const profile of profiles) store.admit(id, profile, 0);
        }
        store.recordRequest(scope, actor.address, request.requestId, payload, id);
        return view(get(id, actor));
      }
      const room = get(request.chatId, actor);
      if (request.action === 'read') {
        const after = Math.max(request.after, actor.owner ? 0 : member(room.id, actor).joinedSeq);
        const rows = store.messages(room.id, after, request.limit + 1);
        const messages = []; let bytes = 0;
        for (const row of rows.slice(0, request.limit)) {
          const item = messageView(row); const size = Buffer.byteLength(JSON.stringify(item));
          if (messages.length && bytes + size > CHAT_LIMITS.readBytes) break;
          bytes += size; messages.push(item);
        }
        const nextAfter = messages.at(-1)?.seq ?? after;
        if (!actor.owner) store.markRead(room.id, actor.address, nextAfter);
        return { ...view(room), messages, nextAfter, hasMore: rows.length > messages.length };
      }
      if (request.action === 'send') {
        const saved = store.message(room.id, actor.address, request.requestId);
        if (saved && saved.body !== request.body) error('chat_conflict', 'This request ID belongs to a different message', 409);
        if (!saved) delivered = { chatId: room.id, targets: store.members(room.id).filter(m => m.address !== actor.address
          && (room.kind === 'direct' || request.body.includes(`@{${m.address}}`))
          && !store.waiting(scope, m.address, room.id)).map(m => m.address) };
        return messageView(saved ?? store.append({ chatId: room.id, seq: store.lastSeq(room.id) + 1,
          id: idFactory(), sender: actor.address, requestId: request.requestId, body: request.body, at }));
      }
      if (room.kind === 'direct') error('chat_direct_fixed', 'Direct chat membership is fixed', 409);
      if (room.revision !== request.expectedRevision) error('chat_conflict', 'Chat revision changed; reload before editing', 409);
      const leave = request.remove.length === 1 && request.remove[0] === actor.address && !request.add.length && !request.owner;
      if (room.owner !== actor.address && !leave) error('chat_owner_required', 'Only the group owner can manage membership');
      const current = store.members(room.id);
      const remove = new Set(request.remove);
      const additions = [...new Set(request.add)].filter(a => !current.some(m => m.address === a)).map(resolve);
      const next = [...current.filter(m => !remove.has(m.address)), ...additions];
      const owner = request.owner ?? room.owner;
      if (!next.some(m => m.address === owner)) error('chat_owner_required', 'Transfer the owner role before the owner leaves', 409);
      if (next.length > CHAT_LIMITS.members) error('invalid_chat', 'A group supports at most 32 members', 422);
      if (request.add.some(a => remove.has(a))) error('invalid_chat', 'Cannot add and remove the same member', 422);
      for (const address of remove) store.remove(room.id, address);
      for (const profile of additions) store.admit(room.id, profile, store.lastSeq(room.id));
      store.update(room.id, owner, at);
      // The leaving member receives only the new header, never remaining history.
      return { ...view(store.get(room.id)), ...(leave ? { left: true } : {}) };
    });
    if (delivered) onMessage?.(delivered);
    return result;
  }
  return execute;
}

function messageView(row) {
  return { messageId: row.id, seq: row.seq, from: row.sender, body: row.body, createdAt: row.created_at };
}
