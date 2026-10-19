import { randomUUID } from 'node:crypto';
import { createChatNotifications } from './chat-notifications.js';
// Shares the existing local/coordinator SQLite connection and transaction owner.
export function createChatStore(db, path = ':memory:') {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_chats (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
      owner TEXT NOT NULL, revision INTEGER NOT NULL, direct_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS agent_chats_direct ON agent_chats(scope, direct_key) WHERE direct_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS agent_chat_members (
      chat_id TEXT NOT NULL, address TEXT NOT NULL, profile_json TEXT NOT NULL, joined_seq INTEGER NOT NULL,
      active INTEGER NOT NULL, PRIMARY KEY(chat_id,address));
    CREATE TABLE IF NOT EXISTS agent_chat_messages (
      chat_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, sender TEXT NOT NULL, request_id TEXT NOT NULL,
      body TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(chat_id,seq), UNIQUE(chat_id,sender,request_id));
    CREATE TABLE IF NOT EXISTS agent_chat_waits (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, address TEXT NOT NULL, chat_id TEXT NOT NULL, deadline INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS agent_chat_waits_agent ON agent_chat_waits(scope,address,deadline);
    CREATE TABLE IF NOT EXISTS agent_chat_delivered (
      chat_id TEXT NOT NULL, address TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(chat_id,address,seq));
    CREATE TABLE IF NOT EXISTS agent_chat_reads (
      chat_id TEXT NOT NULL, address TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(chat_id,address));
    CREATE TABLE IF NOT EXISTS agent_chat_changes (
      cursor INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, seq INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_chat_requests (
      scope TEXT NOT NULL, sender TEXT NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL, chat_id TEXT NOT NULL,
      PRIMARY KEY(scope,sender,request_id));
  `);
  const notifications = createChatNotifications(path);
  let dirty = false;
  const waits = new Set();
  let closed = false;
  const changed = (id, seq) => db.prepare('INSERT INTO agent_chat_changes(chat_id,seq) VALUES(?,?)').run(id, seq);
  return {
    subscribe: notifications.subscribe,
    publishChanges: notifications.publish,
    close() {
      closed = true;
      for (const id of waits) db.prepare('DELETE FROM agent_chat_waits WHERE id=?').run(id);
      waits.clear(); notifications.close();
    },
    beginWait(scope, address, chatId, seconds) {
      const id = randomUUID();
      db.prepare('DELETE FROM agent_chat_waits WHERE deadline<=?').run(Date.now());
      db.prepare('INSERT INTO agent_chat_waits VALUES(?,?,?,?,?)').run(id, scope, address, chatId, Date.now() + seconds * 1000);
      waits.add(id);
      return () => { if (!closed) db.prepare('DELETE FROM agent_chat_waits WHERE id=?').run(id); waits.delete(id); };
    },
    waiting: (scope, address, chatId) => Boolean(db.prepare('SELECT 1 FROM agent_chat_waits WHERE scope=? AND address=? AND chat_id=? AND deadline>? LIMIT 1').get(scope,address,chatId,Date.now())),
    waitingAnywhere: (scope, address) => Boolean(db.prepare('SELECT 1 FROM agent_chat_waits WHERE scope=? AND address=? AND deadline>? LIMIT 1').get(scope,address,Date.now())),
    readCursor: (id, address) => db.prepare('SELECT seq FROM agent_chat_reads WHERE chat_id=? AND address=?').get(id,address)?.seq ?? 0,
    delivered: (id, address, seq) => Boolean(db.prepare('SELECT 1 FROM agent_chat_delivered WHERE chat_id=? AND address=? AND seq=?').get(id,address,seq)),
    unreadMessages: (id, address, after, limit) => db.prepare(`SELECT m.* FROM agent_chat_messages m
      WHERE m.chat_id=? AND m.seq>? AND m.sender!=? AND NOT EXISTS (SELECT 1 FROM agent_chat_delivered d
        WHERE d.chat_id=m.chat_id AND d.address=? AND d.seq=m.seq) ORDER BY m.seq LIMIT ?`).all(id,after,address,address,limit),
    markDelivered(id, address, sequences) {
      for (const seq of sequences) db.prepare('INSERT OR IGNORE INTO agent_chat_delivered VALUES(?,?,?)').run(id,address,seq);
      const member = this.members(id).find(m => m.address === address);
      if (!member) return;
      const base = Math.max(member.joinedSeq, this.readCursor(id,address));
      const first = this.unreadMessages(id,address,base,1)[0];
      this.markRead(id,address,first ? Math.max(base,first.seq-1) : this.lastSeq(id));
      db.prepare('DELETE FROM agent_chat_delivered WHERE chat_id=? AND address=? AND seq<=?').run(id,address,this.readCursor(id,address));
    },
    markRead(id, address, seq) {
      db.prepare(`INSERT INTO agent_chat_reads VALUES(?,?,?) ON CONFLICT(chat_id,address)
        DO UPDATE SET seq=max(seq,excluded.seq)`).run(id,address,seq);
    },
    flushChanges() { if (dirty) { dirty = false; notifications.publish(); } },
    rollbackChanges() { dirty = false; },
    changes: (scope, after, limit = 100) => db.prepare(`SELECT e.cursor,e.chat_id AS chatId,e.seq
      FROM agent_chat_changes e JOIN agent_chats c ON c.id=e.chat_id
      WHERE c.scope=? AND e.cursor>? ORDER BY e.cursor LIMIT ?`).all(scope, after, limit),
    heads: scope => db.prepare(`SELECT c.id AS chatId, c.revision, coalesce(max(m.seq),0) AS seq
      FROM agent_chats c LEFT JOIN agent_chat_messages m ON m.chat_id=c.id
      WHERE c.scope=? GROUP BY c.id`).all(scope),
    get: id => db.prepare('SELECT * FROM agent_chats WHERE id=?').get(id) ?? null,
    direct: (scope, key) => db.prepare('SELECT * FROM agent_chats WHERE scope=? AND direct_key=?').get(scope, key) ?? null,
    list: scope => db.prepare('SELECT * FROM agent_chats WHERE scope=? ORDER BY updated_at DESC,id').all(scope),
    create({ id, scope, kind, title, owner, directKey, at }) {
      dirty = true;
      db.prepare('INSERT INTO agent_chats VALUES(?,?,?,?,?,1,?,?,?)').run(id, scope, kind, title, owner, directKey, at, at);
      changed(id, 0);
    },
    members: id => db.prepare('SELECT * FROM agent_chat_members WHERE chat_id=? AND active=1 ORDER BY address').all(id)
      .map(r => ({ ...JSON.parse(r.profile_json), joinedSeq: r.joined_seq })),
    admit(id, member, joinedSeq) {
      dirty = true;
      db.prepare(`INSERT INTO agent_chat_members VALUES(?,?,?,?,1) ON CONFLICT(chat_id,address)
        DO UPDATE SET profile_json=excluded.profile_json,joined_seq=excluded.joined_seq,active=1`)
        .run(id, member.address, JSON.stringify(member), joinedSeq);
    },
    remove(id, address) { dirty = true; db.prepare('UPDATE agent_chat_members SET active=0 WHERE chat_id=? AND address=?').run(id, address); },
    update(id, owner, at) { dirty = true; db.prepare('UPDATE agent_chats SET owner=?,revision=revision+1,updated_at=? WHERE id=?').run(owner, at, id); changed(id, this.lastSeq(id)); },
    request: (scope, sender, id) => db.prepare('SELECT * FROM agent_chat_requests WHERE scope=? AND sender=? AND request_id=?').get(scope, sender, id),
    recordRequest: (scope, sender, id, payload, chatId) => db.prepare('INSERT INTO agent_chat_requests VALUES(?,?,?,?,?)').run(scope, sender, id, payload, chatId),
    message: (chatId, sender, id) => db.prepare('SELECT * FROM agent_chat_messages WHERE chat_id=? AND sender=? AND request_id=?').get(chatId, sender, id),
    lastSeq: id => db.prepare('SELECT coalesce(max(seq),0) AS seq FROM agent_chat_messages WHERE chat_id=?').get(id).seq,
    append({ chatId, seq, id, sender, requestId, body, at }) {
      dirty = true;
      db.prepare('INSERT INTO agent_chat_messages VALUES(?,?,?,?,?,?,?)').run(chatId, seq, id, sender, requestId, body, at);
      db.prepare('UPDATE agent_chats SET updated_at=? WHERE id=?').run(at, chatId);
      changed(chatId, seq);
      return this.message(chatId, sender, requestId);
    },
    messages: (id, after, limit) => db.prepare('SELECT * FROM agent_chat_messages WHERE chat_id=? AND seq>? ORDER BY seq LIMIT ?').all(id, after, limit)
  };
}
