import { chatSnapshot, chatWakePrompt } from './chat-snapshot.js';

// Reuse the read-only delegation, durable execution claim, reply path and
// cleanup hold. This module only supplies a bounded unread snapshot and queues
// subsequent arrivals after the owned wake ends; it grants no authority.
export function createChatWake({ store, scope, messageAgent, waitUntilIdle, transaction }) {
  const active = new Map();
  const controller = new AbortController();
  async function consume(address, chatId, { authorize, remoteSnapshot, ...context }) {
    while (!controller.signal.aborted && (!address.startsWith('local:') || !store.waiting(scope, address, chatId))) {
      const remote = address.startsWith('peer:');
      if (!await waitUntilIdle(remote ? address : address.slice(6), controller.signal)) return;
      await authorize();
      const unread = remote ? await remoteSnapshot(chatId, address, controller.signal) : chatSnapshot(store, chatId, address);
      if (!unread) return;
      let reply;
      try { reply = await messageAgent({ ...context, to: remote ? address : address.slice(6), chatWakeChatId: chatId,
        ...(remote ? { chatWake: unread } : {}), signal: controller.signal,
        body: chatWakePrompt(unread) }); }
      catch (error) { if (remote && error.code === 'chat_wake_stale') continue; throw error; }
      if (reply.reason === 'execution_claimed' || reply.reason === 'chat_wake_stale') continue;
      if (reply.status !== 'answered' || controller.signal.aborted) return;
      if (remote && unread.earlierUnshown) return;
      if (!remote) {
        if (!store.members(chatId).some(m => m.address === address)) return;
        transaction(() => store.markDelivered(chatId, address, unread.messages.map(message => message.seq)));
      }
    }
  }
  function dispatch({ chatId, targets }, context) {
    if (controller.signal.aborted) return;
    for (const address of targets) {
      if (!address.startsWith('local:') && !address.startsWith('peer:')) continue;
      const existing = active.get(address);
      if (existing) { existing.rooms.set(chatId, context); continue; }
      const rooms = new Map([[chatId, context]]);
      const run = async () => {
        while (rooms.size && !controller.signal.aborted) {
          const [id, source] = rooms.entries().next().value;
          rooms.delete(id);
          await consume(address, id, source);
        }
      };
      const work = run().catch(() => { /* A failed wake keeps chat unread; its existing ask retains the audit. */ });
      active.set(address, { rooms, work });
      void work.finally(() => active.delete(address));
    }
  }
  return { dispatch, close() {
    controller.abort();
    return active.size ? Promise.allSettled([...active.values()].map(item => item.work)) : null;
  } };
}
