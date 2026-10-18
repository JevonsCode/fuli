// Shares the existing local/coordinator SQLite connection and transaction owner.
export function createChatStore(db) {
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
    CREATE TABLE IF NOT EXISTS agent_chat_requests (
      scope TEXT NOT NULL, sender TEXT NOT NULL, request_id TEXT NOT NULL, payload TEXT NOT NULL, chat_id TEXT NOT NULL,
      PRIMARY KEY(scope,sender,request_id));
  `);
  return {
    get: id => db.prepare('SELECT * FROM agent_chats WHERE id=?').get(id) ?? null,
    direct: (scope, key) => db.prepare('SELECT * FROM agent_chats WHERE scope=? AND direct_key=?').get(scope, key) ?? null,
    list: scope => db.prepare('SELECT * FROM agent_chats WHERE scope=? ORDER BY updated_at DESC,id').all(scope),
    create({ id, scope, kind, title, owner, directKey, at }) {
      db.prepare('INSERT INTO agent_chats VALUES(?,?,?,?,?,1,?,?,?)').run(id, scope, kind, title, owner, directKey, at, at);
    },
    members: id => db.prepare('SELECT * FROM agent_chat_members WHERE chat_id=? AND active=1 ORDER BY address').all(id)
      .map(r => ({ ...JSON.parse(r.profile_json), joinedSeq: r.joined_seq })),
    admit(id, member, joinedSeq) {
      db.prepare(`INSERT INTO agent_chat_members VALUES(?,?,?,?,1) ON CONFLICT(chat_id,address)
        DO UPDATE SET profile_json=excluded.profile_json,joined_seq=excluded.joined_seq,active=1`)
        .run(id, member.address, JSON.stringify(member), joinedSeq);
    },
    remove: (id, address) => db.prepare('UPDATE agent_chat_members SET active=0 WHERE chat_id=? AND address=?').run(id, address),
    update: (id, owner, at) => db.prepare('UPDATE agent_chats SET owner=?,revision=revision+1,updated_at=? WHERE id=?').run(owner, at, id),
    request: (scope, sender, id) => db.prepare('SELECT * FROM agent_chat_requests WHERE scope=? AND sender=? AND request_id=?').get(scope, sender, id),
    recordRequest: (scope, sender, id, payload, chatId) => db.prepare('INSERT INTO agent_chat_requests VALUES(?,?,?,?,?)').run(scope, sender, id, payload, chatId),
    message: (chatId, sender, id) => db.prepare('SELECT * FROM agent_chat_messages WHERE chat_id=? AND sender=? AND request_id=?').get(chatId, sender, id),
    lastSeq: id => db.prepare('SELECT coalesce(max(seq),0) AS seq FROM agent_chat_messages WHERE chat_id=?').get(id).seq,
    append({ chatId, seq, id, sender, requestId, body, at }) {
      db.prepare('INSERT INTO agent_chat_messages VALUES(?,?,?,?,?,?,?)').run(chatId, seq, id, sender, requestId, body, at);
      db.prepare('UPDATE agent_chats SET updated_at=? WHERE id=?').run(at, chatId);
      return this.message(chatId, sender, requestId);
    },
    messages: (id, after, limit) => db.prepare('SELECT * FROM agent_chat_messages WHERE chat_id=? AND seq>? ORDER BY seq LIMIT ?').all(id, after, limit)
  };
}
