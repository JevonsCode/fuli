import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Every Agent-to-Agent exchange is kept as a thread of messages so people can
// see who talked to whom, through which client, and what was said. The file
// is shared by the console and every client's MCP process.
export function createRoundtableStore(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL, project_id TEXT, subject TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), seq INTEGER NOT NULL,
      kind TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, in_reply_to TEXT,
      from_agent TEXT, from_name TEXT, from_client TEXT, from_session TEXT,
      to_agent TEXT, to_name TEXT, to_client TEXT, to_session TEXT,
      via TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(thread_id, seq)
    );
    CREATE INDEX IF NOT EXISTS messages_inbox ON messages(to_agent, status);
    CREATE INDEX IF NOT EXISTS threads_recent ON threads(space_id, updated_at);
  `);
  const now = () => new Date().toISOString();
  const transaction = (work) => {
    database.exec('BEGIN IMMEDIATE');
    try { const result = work(); database.exec('COMMIT'); return result; }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  };

  return {
    createThread({ id, spaceId, projectId = null, subject }) {
      const at = now();
      database.prepare('INSERT INTO threads(id, space_id, project_id, subject, created_at, updated_at) VALUES(?,?,?,?,?,?)')
        .run(id, spaceId, projectId, subject, at, at);
      return this.getThread(id);
    },
    getThread(id) {
      return database.prepare('SELECT * FROM threads WHERE id = ?').get(id) ?? null;
    },
    listThreads(spaceId, { projectId = null, limit = 50 } = {}) {
      return database.prepare(`SELECT t.*, (SELECT count(*) FROM messages m WHERE m.thread_id = t.id) AS message_count
        FROM threads t WHERE t.space_id = ? AND (? IS NULL OR t.project_id = ?)
        ORDER BY t.updated_at DESC LIMIT ?`).all(spaceId, projectId, projectId, limit);
    },
    appendMessage(threadId, message) {
      return transaction(() => {
        const at = now();
        const seq = (database.prepare('SELECT coalesce(max(seq), 0) AS seq FROM messages WHERE thread_id = ?').get(threadId).seq) + 1;
        database.prepare(`INSERT INTO messages(id, thread_id, seq, kind, body, status, in_reply_to,
          from_agent, from_name, from_client, from_session, to_agent, to_name, to_client, to_session,
          via, error, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          message.id, threadId, seq, message.kind, message.body, message.status, message.inReplyTo ?? null,
          message.from?.agentId ?? null, message.from?.name ?? null, message.from?.client ?? null, message.from?.session ?? null,
          message.to?.agentId ?? null, message.to?.name ?? null, message.to?.client ?? null, message.to?.session ?? null,
          message.via ?? null, null, at, at);
        database.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(at, threadId);
        return this.getMessage(message.id);
      });
    },
    updateMessage(id, { status, via, error, toClient, toSession }) {
      database.prepare(`UPDATE messages SET status = coalesce(?, status), via = coalesce(?, via), error = ?,
        to_client = coalesce(?, to_client), to_session = coalesce(?, to_session), updated_at = ? WHERE id = ?`)
        .run(status ?? null, via ?? null, error ?? null, toClient ?? null, toSession ?? null, now(), id);
      return this.getMessage(id);
    },
    getMessage(id) {
      return database.prepare('SELECT * FROM messages WHERE id = ?').get(id) ?? null;
    },
    messages(threadId) {
      return database.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY seq').all(threadId);
    },
    // Questions waiting for this Agent that no delivery is currently answering.
    pendingFor(spaceId, agentId, limit = 5) {
      return database.prepare(`SELECT m.* FROM messages m JOIN threads t ON t.id = m.thread_id
        WHERE t.space_id = ? AND m.to_agent = ? AND m.kind = 'ask' AND m.status = 'queued'
        ORDER BY m.created_at LIMIT ?`).all(spaceId, agentId, limit);
    },
    close() { database.close(); }
  };
}
