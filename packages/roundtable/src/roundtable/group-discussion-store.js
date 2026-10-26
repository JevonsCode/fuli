// A group discussion (@FLG, rec#55) over one group chat: the question, its
// moderator, how far its rounds have come, and every member's turn in each
// round with its real outcome. The chat keeps what was said; these rows keep
// who was asked and what happened. Part of the roundtable store format
// (roundtable/3-group-discussions), so the console and every client's MCP
// process see the same state.
export const GROUP_DISCUSSION_TABLES = `
    CREATE TABLE IF NOT EXISTS group_discussions (
      chat_id TEXT PRIMARY KEY, scope TEXT NOT NULL, request_id TEXT NOT NULL, owner TEXT NOT NULL,
      project_id TEXT NOT NULL, question TEXT NOT NULL, status TEXT NOT NULL, response_rounds INTEGER NOT NULL,
      round INTEGER NOT NULL, summary_seq INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(scope, request_id));
    CREATE TABLE IF NOT EXISTS group_discussion_turns (
      chat_id TEXT NOT NULL, round INTEGER NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL, reason TEXT, ask_id TEXT, reply_seq INTEGER, via TEXT, deadline INTEGER NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY(chat_id, round, agent_id));
`;

// Shares the roundtable connection; every change signals waiting readers
// through the chat notifications, as chat messages do.
export function createGroupDiscussionStore(db, chat) {
  const now = () => new Date().toISOString();
  const changed = result => { chat.publishChanges(); return result; };
  return {
    get: chatId => db.prepare('SELECT * FROM group_discussions WHERE chat_id=?').get(chatId) ?? null,
    byRequest: (scope, requestId) => db.prepare('SELECT * FROM group_discussions WHERE scope=? AND request_id=?')
      .get(scope, requestId) ?? null,
    create({ chatId, scope, requestId, owner, projectId, question, responseRounds }) {
      const at = now();
      db.prepare(`INSERT INTO group_discussions(chat_id, scope, request_id, owner, project_id, question, status,
        response_rounds, round, created_at, updated_at) VALUES(?,?,?,?,?,?,'running',?,0,?,?)`)
        .run(chatId, scope, requestId, owner, projectId, question, responseRounds, at, at);
    },
    // status: running | concluded | ended. A round number only grows.
    update(chatId, { status = null, round = null, summarySeq = null }) {
      db.prepare(`UPDATE group_discussions SET status=coalesce(?, status), round=max(round, coalesce(?, round)),
        summary_seq=coalesce(?, summary_seq), updated_at=? WHERE chat_id=?`)
        .run(status, round, summarySeq, now(), chatId);
      return changed(this.get(chatId));
    },
    // Each member's turn starts invited; deadline (ms) bounds how long it may wait.
    invite(chatId, round, kind, agentIds, deadline, settled = {}) {
      for (const agentId of agentIds) {
        const outcome = settled[agentId];
        db.prepare(`INSERT OR IGNORE INTO group_discussion_turns(chat_id, round, agent_id, kind, status, reason,
          deadline, updated_at) VALUES(?,?,?,?,?,?,?,?)`)
          .run(chatId, round, agentId, kind, outcome ? 'failed' : 'invited', outcome ?? null, deadline, now());
      }
      return changed(this.turns(chatId));
    },
    // status: invited | waiting | replied | failed | ended. Only an unsettled
    // turn changes, so a late result never overwrites a stop.
    settle(chatId, round, agentId, { status, reason = null, askId = null, replySeq = null, via = null }) {
      const updated = db.prepare(`UPDATE group_discussion_turns SET status=?, reason=?, ask_id=coalesce(?, ask_id),
        reply_seq=?, via=?, updated_at=? WHERE chat_id=? AND round=? AND agent_id=? AND status IN ('invited','waiting')`)
        .run(status, reason, askId, replySeq, via, now(), chatId, round, agentId).changes === 1;
      chat.publishChanges();
      return updated;
    },
    turns: chatId => db.prepare('SELECT * FROM group_discussion_turns WHERE chat_id=? ORDER BY round, agent_id').all(chatId)
  };
}
