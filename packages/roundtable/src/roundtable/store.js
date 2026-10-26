import { openFormattedDatabase, sqliteFormat } from '../storage/database-format.js';
import { CHAT_SCHEMA, createChatStore } from './chat-store.js';
import { ATTENTION_INBOX_SCHEMA, createAttentionInboxStore } from './attention-inbox-store.js';
import { THREAD_SUBSCRIPTION_TABLES, createThreadSubscriptionStore } from './thread-subscriptions.js';

export const ROUNDTABLE_FORMAT = sqliteFormat({
  store: 'roundtable',
  schema: `
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
    ${CHAT_SCHEMA}
    ${ATTENTION_INBOX_SCHEMA}`,
  migrations: [{
    // A woken process whose exit could not be confirmed may still be running.
    // Evidence and release audit are append-only; an execution claim outlives the
    // ask's status, because a reply or cancel says nothing about a process exiting.
    id: 'roundtable/2-message-execution-evidence', to: 2, kind: 'add-columns', table: 'messages',
    summary: 'cleanup evidence, execution claims and memory usage of each message',
    columns: Object.fromEntries(['cleanup_status', 'cleanup_code', 'cleanup_recorded_at', 'cleanup_evidence_version',
      'cleanup_machine_hash', 'cleanup_anchor_pid', 'cleanup_anchor_critical', 'cleanup_released_at',
      'cleanup_release_proof', 'cleanup_release_observation', 'execution_claim', 'execution_claimed_at',
      'target_project_id', 'source_context_hash', 'memory_usage_recorded', 'memory_result_count']
      .map((name) => [name, 'TEXT']))
  }, {
    id: 'roundtable/3-thread-subscriptions', to: 3, kind: 'add-table', table: 'thread_subscriptions',
    summary: 'who is subscribed to each thread and whether a post wakes them at once', create: THREAD_SUBSCRIPTION_TABLES
  }],
  pragmas: 'PRAGMA journal_mode = WAL;'
});

// Every Agent-to-Agent exchange is kept as a thread of messages so people can
// see who talked to whom, through which client, and what was said. The file
// is shared by the console and every client's MCP process.
export function createRoundtableStore(path = ':memory:') {
  const database = openFormattedDatabase(path, ROUNDTABLE_FORMAT);
  const now = () => new Date().toISOString();
  const chat = createChatStore(database, path);
  const attention = createAttentionInboxStore(database, chat);
  const subscriptions = createThreadSubscriptionStore(database, chat);
  const transaction = (work) => {
    database.exec('BEGIN IMMEDIATE');
    let result;
    try { result = work(); database.exec('COMMIT'); }
    catch (error) { database.exec('ROLLBACK'); chat.rollbackChanges(); throw error; }
    chat.flushChanges();
    return result;
  };

  return {
    chat,
    attention,
    subscriptions,
    transaction,
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
          via, error, created_at, updated_at, target_project_id, source_context_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          message.id, threadId, seq, message.kind, message.body, message.status, message.inReplyTo ?? null,
          message.from?.agentId ?? null, message.from?.name ?? null, message.from?.client ?? null, message.from?.session ?? null,
          message.to?.agentId ?? null, message.to?.name ?? null, message.to?.client ?? null, message.to?.session ?? null,
          message.via ?? null, null, at, at, message.targetProjectId ?? null, message.sourceContextHash ?? null);
        database.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(at, threadId);
        return this.getMessage(message.id);
      });
    },
    markMemoryObserved(id) {
      database.prepare('UPDATE messages SET memory_usage_recorded = ? WHERE id = ?').run('1', id);
    },
    recordMemoryResult(id, count) {
      database.prepare('UPDATE messages SET memory_result_count = ? WHERE id = ?').run(String(count), id);
    },
    // A delivery attempt names its client and session together; a fresh session
    // must not keep the previous attempt's session ID.
    updateMessage(id, { status, via, error, toClient, toSession }) {
      database.prepare(`UPDATE messages SET status = coalesce(?, status), via = coalesce(?, via), error = ?,
        to_client = coalesce(?, to_client), to_session = CASE WHEN ? IS NULL THEN to_session ELSE ? END,
        updated_at = ? WHERE id = ?`)
        .run(status ?? null, via ?? null, error ?? null, toClient ?? null, toClient ?? null, toSession ?? null, now(), id);
      return this.getMessage(id);
    },
    // Kept apart from updateMessage so later status changes never erase it. Boot
    // evidence is recorded once, with the hold; null evidence can never be released.
    setCleanup(id, { status, code = null }, evidence = null) {
      const anchor = evidence?.version === 1 ? evidence : null;
      database.prepare(`UPDATE messages SET cleanup_status = ?, cleanup_code = coalesce(?, cleanup_code),
        cleanup_recorded_at = coalesce(cleanup_recorded_at, ?),
        cleanup_evidence_version = CASE WHEN cleanup_recorded_at IS NULL THEN ? ELSE cleanup_evidence_version END,
        cleanup_machine_hash = CASE WHEN cleanup_recorded_at IS NULL THEN ? ELSE cleanup_machine_hash END,
        cleanup_anchor_pid = CASE WHEN cleanup_recorded_at IS NULL THEN ? ELSE cleanup_anchor_pid END,
        cleanup_anchor_critical = CASE WHEN cleanup_recorded_at IS NULL THEN ? ELSE cleanup_anchor_critical END,
        updated_at = ? WHERE id = ?`)
        .run(status, code, now(), anchor ? '1' : null, anchor?.machineHash ?? null,
          anchor?.anchor?.pid == null ? null : String(anchor.anchor.pid), anchor?.anchor?.critical === true ? '1' : null, now(), id);
      chat.publishChanges();
      return this.getMessage(id);
    },
    // Asks to this Agent whose woken process may still be running.
    unconfirmedCleanupFor(spaceId, agentId) {
      return database.prepare(`SELECT m.* FROM messages m JOIN threads t ON t.id = m.thread_id
        WHERE t.space_id = ? AND m.to_agent = ? AND m.kind = 'ask' AND m.cleanup_status = 'unconfirmed'
          AND m.cleanup_released_at IS NULL
        ORDER BY m.updated_at`).all(spaceId, agentId);
    },
    // One durable decision: no unreleased hold and no other active execution of
    // this Agent in this space, then this ask owns the next process. Parallel
    // coordinators and restarts share the file, so the check and claim are atomic.
    claimExecution(spaceId, agentId, askId, { chatWakeChatId = null } = {}) {
      return transaction(() => {
        if (chatWakeChatId && chat.waiting(spaceId, `local:${agentId}`, chatWakeChatId)) return { claimed: false, reason: 'chat_waiting' };
        const state = this.executionState(spaceId, agentId, askId);
        if (state.held) return { claimed: false, reason: 'cleanup_unconfirmed' };
        if (state.busy) return { claimed: false, reason: 'execution_claimed' };
        const claimed = database.prepare(`UPDATE messages SET execution_claim = 'active', execution_claimed_at = ?
          WHERE id = ? AND execution_claim IS NULL`).run(now(), askId).changes === 1;
        return claimed ? { claimed: true } : { claimed: false, reason: 'execution_claimed' };
      });
    },
    executionState(spaceId, agentId, exceptAskId = '') {
      const blocking = database.prepare(`SELECT m.cleanup_status,m.cleanup_released_at,m.execution_claim
        FROM messages m JOIN threads t ON t.id=m.thread_id
        WHERE t.space_id=? AND m.to_agent=? AND m.kind='ask' AND m.id!=? AND
          (m.execution_claim='active' OR (m.cleanup_status='unconfirmed' AND m.cleanup_released_at IS NULL))`)
        .all(spaceId, agentId, exceptAskId);
      return { busy: blocking.some(row => row.execution_claim === 'active'),
        held: blocking.some(row => row.cleanup_status === 'unconfirmed' && row.cleanup_released_at === null) };
    },
    // Only after the owned process was observed to end, or never started. An
    // unconfirmed cleanup leaves the claim active until a proof releases it.
    finishExecution(askId) {
      database.prepare(`UPDATE messages SET execution_claim = 'finished' WHERE id = ? AND execution_claim = 'active'
        AND (cleanup_status IS NULL OR cleanup_status != 'unconfirmed')`).run(askId);
      chat.publishChanges();
      return this.getMessage(askId);
    },
    // Compare-and-set bound to the recorded evidence: it succeeds at most once and
    // never for null, legacy, non-critical or other-machine evidence.
    releaseProvenCleanup(id, { machineHash, anchorPid, proof, observation }) {
      return database.prepare(`UPDATE messages SET cleanup_released_at = ?, cleanup_release_proof = ?,
        cleanup_release_observation = ?, execution_claim = CASE WHEN execution_claim = 'active' THEN 'released' ELSE execution_claim END
        WHERE id = ? AND cleanup_status = 'unconfirmed' AND cleanup_released_at IS NULL AND cleanup_evidence_version = '1'
          AND cleanup_anchor_critical = '1' AND cleanup_machine_hash = ? AND cleanup_anchor_pid = ?`)
        .run(now(), proof, observation, id, machineHash, String(anchorPid)).changes === 1;
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
    close() { chat.close(); database.close(); }
  };
}
