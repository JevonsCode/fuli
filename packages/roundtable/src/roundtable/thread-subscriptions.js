// Who is subscribed to a roundtable thread and how each one receives what is
// posted there. "instant" pushes: a post starts or wakes the member at once.
// "board" waits: the member picks the post up when it next works. Part of the
// roundtable store format (roundtable/3-thread-subscriptions), so the console
// and every client's MCP process read the same subscriptions.
export const DELIVERY_MODES = Object.freeze(['board', 'instant']);

export const THREAD_SUBSCRIPTION_TABLES = `
    CREATE TABLE IF NOT EXISTS thread_subscriptions (
      thread_id TEXT NOT NULL, agent_id TEXT NOT NULL, project_id TEXT NOT NULL, delivery TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(thread_id, agent_id));
`;

export function createThreadSubscriptionStore(db, chat) {
  const now = () => new Date().toISOString();
  return {
    subscribers: threadId => db.prepare(`SELECT agent_id AS agentId, project_id AS projectId, delivery
      FROM thread_subscriptions WHERE thread_id = ? ORDER BY created_at, agent_id`).all(threadId),
    // A member joins once; a later post keeps how it already receives the thread.
    subscribe(threadId, { agentId, projectId, delivery }) {
      const at = now();
      db.prepare(`INSERT INTO thread_subscriptions(thread_id, agent_id, project_id, delivery, created_at, updated_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(thread_id, agent_id) DO NOTHING`).run(threadId, agentId, projectId, delivery, at, at);
      chat.publishChanges();
    },
    setDelivery(threadId, delivery) {
      db.prepare('UPDATE thread_subscriptions SET delivery = ?, updated_at = ? WHERE thread_id = ?').run(delivery, now(), threadId);
      chat.publishChanges();
    }
  };
}
