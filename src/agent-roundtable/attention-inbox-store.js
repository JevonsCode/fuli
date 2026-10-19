// A person's answer to an Agent's attention request, waiting in that Agent's
// inbox. Shares the roundtable file so the console records it and every
// client's MCP process sees it; the chat signal wakes a waiting session.
export function createAttentionInboxStore(db, chat) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS attention_replies (
      space_id TEXT NOT NULL, request_id TEXT NOT NULL, revision INTEGER NOT NULL,
      project_id TEXT NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
      question TEXT NOT NULL, choice TEXT, note TEXT, replied_at TEXT NOT NULL,
      delivered_at TEXT, delivered_via TEXT, PRIMARY KEY(space_id, request_id, revision));
    CREATE INDEX IF NOT EXISTS attention_replies_inbox ON attention_replies(space_id, agent_id, project_id, delivered_at);
  `);
  const row = (spaceId, requestId, revision) => db.prepare(
    'SELECT * FROM attention_replies WHERE space_id=? AND request_id=? AND revision=?').get(spaceId, requestId, revision) ?? null;
  return {
    row,
    // A revision is answered once, so a retried delivery keeps the first row.
    record(reply) {
      db.prepare(`INSERT OR IGNORE INTO attention_replies(space_id, request_id, revision, project_id, agent_id, kind,
        title, question, choice, note, replied_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(reply.spaceId, reply.requestId,
        reply.revision, reply.projectId, reply.agentId, reply.kind, reply.title, reply.question, reply.choice,
        reply.note, reply.repliedAt);
      chat.publishChanges();
      return row(reply.spaceId, reply.requestId, reply.revision);
    },
    pending: (spaceId, agentId, projectId, limit) => db.prepare(`SELECT * FROM attention_replies
      WHERE space_id=? AND agent_id=? AND project_id=? AND delivered_at IS NULL ORDER BY replied_at, request_id LIMIT ?`)
      .all(spaceId, agentId, projectId, limit),
    markDelivered(spaceId, replies, via) {
      const at = new Date().toISOString();
      for (const { requestId, revision } of replies) db.prepare(`UPDATE attention_replies SET delivered_at=?, delivered_via=?
        WHERE space_id=? AND request_id=? AND revision=? AND delivered_at IS NULL`)
        .run(at, via, spaceId, requestId, revision);
      if (replies.length) chat.publishChanges();
    }
  };
}
