// A group discussion (#FLG, rec#55) over one group chat. The row is written
// when the person confirms the members at task entry, keyed by that
// confirmation's request ID: the members, the question, the moderator and
// project, then how far the rounds have come and the follow-up the person
// asked for. Each member's turn in each round keeps its real outcome. The
// chat keeps what was said. Part of the roundtable store format
// (roundtable/3-group-discussions), so the console and every client's MCP
// process see the same state.
export const GROUP_DISCUSSION_TABLES = `
    CREATE TABLE IF NOT EXISTS group_discussions (
      scope TEXT NOT NULL, request_id TEXT NOT NULL, chat_id TEXT UNIQUE, owner TEXT NOT NULL,
      project_id TEXT NOT NULL, question TEXT NOT NULL, members TEXT NOT NULL, status TEXT NOT NULL,
      response_rounds INTEGER NOT NULL, round INTEGER NOT NULL, follow_ups INTEGER NOT NULL,
      pending_follow_up TEXT, pending_to TEXT, summary_seq INTEGER, heartbeat_at INTEGER, end_reason TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(scope, request_id));
    CREATE TABLE IF NOT EXISTS group_discussion_turns (
      chat_id TEXT NOT NULL, round INTEGER NOT NULL, agent_id TEXT NOT NULL, kind TEXT NOT NULL,
      status TEXT NOT NULL, reason TEXT, ask_id TEXT, reply_seq INTEGER, via TEXT, deadline INTEGER NOT NULL,
      updated_at TEXT NOT NULL, PRIMARY KEY(chat_id, round, agent_id));
`;

// rec#129: how a discussion can be joined and how far its host may take it.
// join_code: the short code `#FLG 加入 <code>` names, unique among live
// discussions of a scope and cleared when the discussion ends; lifetime:
// short (the code dies with the discussion) or long (a standing group whose
// host starts new topics); round_limit: host-led rounds per topic, 0 for no
// limit (null: a discussion from before rec#129, read as the default);
// host_rounds: rounds the host started in the current topic; topic: 1-based.
export const GROUP_DISCUSSION_JOIN_COLUMNS = Object.freeze({ join_code: 'TEXT', lifetime: 'TEXT',
  round_limit: 'INTEGER', host_rounds: 'INTEGER', topic: 'INTEGER' });

// rec#129: the members who joined by code from a session of any connected
// client (never woken), and who said each message with what: the speaker's
// member key (an Agent ID for a woken member, join:<id> for a joined one,
// host for the moderator), its client and the model as that client reported
// it (unknown when it did not), and the session that wrote it. A joined
// session's model is the one its client's prompt hook reported at the join,
// when it reports one (Codex). A live join code is unique in its scope, and
// unknown codes typed are counted per session to bound guessing.
export const GROUP_DISCUSSION_JOIN_TABLES = `
    CREATE TABLE IF NOT EXISTS group_discussion_joins (
      id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, agent_id TEXT NOT NULL, name TEXT NOT NULL,
      project_id TEXT, client TEXT NOT NULL, session TEXT NOT NULL, model TEXT, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(chat_id, agent_id, client, session));
    CREATE TABLE IF NOT EXISTS group_discussion_posts (
      chat_id TEXT NOT NULL, seq INTEGER NOT NULL, speaker TEXT NOT NULL, client TEXT, model TEXT NOT NULL,
      session TEXT, PRIMARY KEY(chat_id, seq));
    CREATE TABLE IF NOT EXISTS group_discussion_join_misses (
      scope TEXT NOT NULL, client TEXT NOT NULL, session TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS group_discussions_join_code ON group_discussions(scope, join_code)
      WHERE join_code IS NOT NULL;
`;

// Shares the roundtable connection; every change signals waiting readers
// through the chat notifications, as chat messages do. A discussion is
// addressed by its scope and request ID; its turns by its chat.
export function createGroupDiscussionStore(db, chat) {
  const now = () => new Date().toISOString();
  const changed = result => { chat.publishChanges(); return result; };
  const get = (scope, requestId) => db.prepare('SELECT * FROM group_discussions WHERE scope=? AND request_id=?')
    .get(scope, requestId) ?? null;
  return {
    get,
    byChat: chatId => db.prepare('SELECT * FROM group_discussions WHERE chat_id=?').get(chatId) ?? null,
    // The person's confirmation (status confirmed): the only way a discussion begins.
    confirm({ scope, requestId, owner, projectId, question, members, lifetime, roundLimit }) {
      const at = now();
      db.prepare(`INSERT OR IGNORE INTO group_discussions(scope, request_id, owner, project_id, question, members,
        status, response_rounds, round, follow_ups, lifetime, round_limit, host_rounds, topic, created_at, updated_at)
        VALUES(?,?,?,?,?,?,'confirmed',0,0,0,?,?,0,1,?,?)`)
        .run(scope, requestId, owner, projectId, question, JSON.stringify(members), lifetime, roundLimit, at, at);
      return changed(get(scope, requestId));
    },
    // The live discussion a join code names in this scope, or null.
    byCode: (scope, code) => db.prepare('SELECT * FROM group_discussions WHERE scope=? AND join_code=?').get(scope, code) ?? null,
    // Gives a started discussion its code once, atomically: false when a live
    // discussion of the scope already holds that code (the unique index says so).
    assignCode(scope, requestId, code) {
      try {
        return db.prepare(`UPDATE group_discussions SET join_code=?, updated_at=? WHERE scope=? AND request_id=?
          AND join_code IS NULL AND status!='ended'`).run(code, now(), scope, requestId).changes === 1;
      } catch (error) {
        if (/UNIQUE constraint failed/u.test(error.message)) return false;
        throw error;
      }
    },
    // A code that stopped working (an idle short discussion) is gone for every process.
    dropCode(scope, requestId) {
      db.prepare('UPDATE group_discussions SET join_code=NULL WHERE scope=? AND request_id=?').run(scope, requestId);
    },
    // Unknown codes this session typed since a time (ms), and the space as a whole; older ones are forgotten.
    misses(scope, client, session, since) {
      db.prepare('DELETE FROM group_discussion_join_misses WHERE at<?').run(since);
      return { session: db.prepare(`SELECT count(*) AS n FROM group_discussion_join_misses WHERE scope=? AND client=?
        AND session=?`).get(scope, client, session).n,
      scope: db.prepare('SELECT count(*) AS n FROM group_discussion_join_misses WHERE scope=?').get(scope).n };
    },
    miss(scope, client, session, at) {
      db.prepare('INSERT INTO group_discussion_join_misses VALUES(?,?,?,?)').run(scope, client, session, at);
    },
    // The host's next round of this topic, once per expected count: true for the one call that took it.
    takeHostRound(scope, requestId, expected) {
      return changed(db.prepare(`UPDATE group_discussions SET host_rounds=coalesce(host_rounds,0)+1, updated_at=?
        WHERE scope=? AND request_id=? AND coalesce(host_rounds,0)=?`).run(now(), scope, requestId, expected).changes === 1);
    },
    // A taken round whose questions could not be posted is given back.
    restoreHostRound(scope, requestId, taken) {
      db.prepare(`UPDATE group_discussions SET host_rounds=?, updated_at=? WHERE scope=? AND request_id=?
        AND host_rounds=?`).run(taken - 1, now(), scope, requestId, taken);
      chat.publishChanges();
    },
    // A long group's next topic after its summary: the question, rounds and follow-ups start again.
    takeTopic(scope, requestId, topic, question) {
      return changed(db.prepare(`UPDATE group_discussions SET question=?, topic=coalesce(topic,1)+1, host_rounds=0,
        follow_ups=0, summary_seq=NULL, pending_follow_up=NULL, pending_to=NULL, updated_at=?
        WHERE scope=? AND request_id=? AND coalesce(topic,1)=? AND summary_seq IS NOT NULL AND status!='ended'`)
        .run(question, now(), scope, requestId, topic).changes === 1);
    },
    // A taken topic whose opening could not be posted: the row it replaced comes back, the person's text waits again.
    restoreTopic(previous) {
      db.prepare(`UPDATE group_discussions SET question=?, topic=?, host_rounds=?, follow_ups=?, summary_seq=?,
        pending_follow_up=?, pending_to=?, updated_at=? WHERE scope=? AND request_id=? AND topic=?`)
        .run(previous.question, previous.topic, previous.host_rounds, previous.follow_ups, previous.summary_seq,
          previous.pending_follow_up, previous.pending_to, now(), previous.scope, previous.request_id,
          (previous.topic ?? 1) + 1);
      chat.publishChanges();
    },
    setMembers(scope, requestId, members) {
      db.prepare('UPDATE group_discussions SET members=?, updated_at=? WHERE scope=? AND request_id=?')
        .run(JSON.stringify(members), now(), scope, requestId);
      return changed(get(scope, requestId));
    },
    // A session of any client joins as its current FLA; joining again restores a removed join.
    // { join, fresh }: fresh when this session was not a member before.
    join({ chatId, agentId, name, projectId, client, session, model = null }) {
      const before = db.prepare(`SELECT * FROM group_discussion_joins WHERE chat_id=? AND agent_id=? AND client=?
        AND session=?`).get(chatId, agentId, client, session);
      const at = now();
      db.prepare(`INSERT INTO group_discussion_joins(chat_id, agent_id, name, project_id, client, session, model, status,
        created_at, updated_at) VALUES(?,?,?,?,?,?,?,'joined',?,?) ON CONFLICT(chat_id, agent_id, client, session)
        DO UPDATE SET status='joined', name=excluded.name, model=coalesce(excluded.model, model),
        updated_at=excluded.updated_at`)
        .run(chatId, agentId, name, projectId, client, session, model, at, at);
      const join = db.prepare(`SELECT * FROM group_discussion_joins WHERE chat_id=? AND agent_id=? AND client=?
        AND session=?`).get(chatId, agentId, client, session);
      return changed({ join, fresh: before?.status !== 'joined' });
    },
    joins: chatId => db.prepare('SELECT * FROM group_discussion_joins WHERE chat_id=? ORDER BY id').all(chatId),
    // The discussions this session of a client joined and is still a member of.
    sessionJoins: (client, session) => db.prepare(`SELECT * FROM group_discussion_joins WHERE client=? AND session=?
      AND status='joined' ORDER BY id`).all(client, session),
    leave(chatId, id) {
      db.prepare(`UPDATE group_discussion_joins SET status='removed', updated_at=? WHERE chat_id=? AND id=?`)
        .run(now(), chatId, id);
      chat.publishChanges();
    },
    // Who said one message with what (see GROUP_DISCUSSION_JOIN_TABLES).
    recordPost(chatId, seq, { speaker, client = null, model, session = null }) {
      db.prepare('INSERT OR IGNORE INTO group_discussion_posts VALUES(?,?,?,?,?,?)')
        .run(chatId, seq, speaker, client, model, session);
    },
    posts: chatId => db.prepare('SELECT * FROM group_discussion_posts WHERE chat_id=? ORDER BY seq').all(chatId),
    // confirmed -> running, once: whoever wins starts the rounds.
    claim(scope, requestId, responseRounds) {
      return db.prepare(`UPDATE group_discussions SET status='running', response_rounds=?, updated_at=?
        WHERE scope=? AND request_id=? AND status='confirmed'`).run(responseRounds, now(), scope, requestId).changes === 1;
    },
    // A claim whose chat could not be created goes back to the person's confirmation.
    unclaim(scope, requestId) {
      db.prepare(`UPDATE group_discussions SET status='confirmed', updated_at=? WHERE scope=? AND request_id=?
        AND status='running' AND chat_id IS NULL`).run(now(), scope, requestId);
    },
    attach(scope, requestId, chatId) {
      db.prepare(`UPDATE group_discussions SET chat_id=?, updated_at=? WHERE scope=? AND request_id=? AND chat_id IS NULL`)
        .run(chatId, now(), scope, requestId);
      return changed(get(scope, requestId));
    },
    // status: confirmed | running | concluded | ended. A round number only grows.
    // An ended discussion's join code stops working at once.
    update(scope, requestId, { status = null, round = null, summarySeq = null, endReason = null }) {
      db.prepare(`UPDATE group_discussions SET status=coalesce(?, status), round=max(round, coalesce(?, round)),
        summary_seq=coalesce(?, summary_seq), end_reason=coalesce(?, end_reason),
        join_code=CASE WHEN coalesce(?, status)='ended' THEN NULL ELSE join_code END, updated_at=?
        WHERE scope=? AND request_id=?`)
        .run(status, round, summarySeq, endReason, status, now(), scope, requestId);
      return changed(get(scope, requestId));
    },
    // The runner of the rounds is alive (ms since epoch).
    heartbeat(scope, requestId, at) {
      db.prepare('UPDATE group_discussions SET heartbeat_at=? WHERE scope=? AND request_id=?').run(at, scope, requestId);
    },
    // The person's own `#FLG …` follow-up, waiting for the moderator; a newer one replaces it.
    requestFollowUp(scope, requestId, body, to) {
      db.prepare(`UPDATE group_discussions SET pending_follow_up=?, pending_to=?, updated_at=? WHERE scope=? AND request_id=?`)
        .run(body, to, now(), scope, requestId);
      return changed(get(scope, requestId));
    },
    // Consumes the waiting follow-up, at most limit per discussion: { body, to, number } or null.
    takeFollowUp(scope, requestId, limit) {
      const row = get(scope, requestId);
      if (!row?.pending_follow_up || row.follow_ups >= limit) return null;
      const taken = db.prepare(`UPDATE group_discussions SET pending_follow_up=NULL, pending_to=NULL,
        follow_ups=follow_ups+1, updated_at=? WHERE scope=? AND request_id=? AND pending_follow_up=? AND follow_ups=?`)
        .run(now(), scope, requestId, row.pending_follow_up, row.follow_ups).changes === 1;
      return taken ? changed({ body: row.pending_follow_up, to: row.pending_to, number: row.follow_ups + 1 }) : null;
    },
    // A taken follow-up whose post failed waits again, unless the person wrote a newer one.
    restoreFollowUp(scope, requestId, { body, to, number }) {
      db.prepare(`UPDATE group_discussions SET pending_follow_up=?, pending_to=?, follow_ups=follow_ups-1, updated_at=?
        WHERE scope=? AND request_id=? AND follow_ups=? AND pending_follow_up IS NULL`)
        .run(body, to, now(), scope, requestId, number);
      return changed(get(scope, requestId));
    },
    // Each member's turn starts invited (or failed with its reason); deadline (ms) bounds its wait.
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
    // turn changes, so a late result never overwrites a stop or a failure.
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
