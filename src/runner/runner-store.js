import { existsSync } from 'node:fs';

import { immediateTransaction, openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';
import { DIAGNOSTIC_EVENTS_TOOL } from '../diagnostics/agent-access.js';
import { isReachableHostAddress } from '../server/lan-access.js';
import { REPLAY_WAIT_MS } from './protocol.js';

// A runner's own record (docs/runner.md): the host it paired with, the last
// answer it read for each read-only call (shown, marked offline, while the host
// is away), the task tokens it gave out while offline, and its outbox:
// checkpoints made while the host was away, or whose online delivery has no
// known outcome, replayed oldest first, each applied once; a delivered one is
// deleted. Nothing here is the person's knowledge of record; the host holds
// that. A host that says this runner is revoked or unknown ends what was read
// from it and holds the waiting checkpoints refused; a pairing with another
// host, and `fuli runner leave`, end everything kept for the old pairing.
//
// Nothing here expires with time. What was read stays until the host answers
// that call again (which replaces it), until the host revokes this computer
// (which deletes it at once), or until `fuli runner leave`. A follower that
// was away from its host for a season still has the preferences it last read,
// and a checkpoint the host refused stays listed until the person has seen it.
// How many of the host's addresses a runner keeps: enough for every network it is used on.
const KNOWN_ADDRESSES = 16;

export const RUNNER_FILE = 'runner/runner.sqlite';
// An outbox entry a process claimed is its own for this long: past its wait for the host.
const CLAIM_MS = REPLAY_WAIT_MS + 60 * 1000;
// The cache of answers has a size, not an age (rec#144: nothing is deleted
// because it is old). Past either bound, the answers used longest ago go first;
// whatever was used lately stays however old it is.
export const ANSWERS_KEPT = 5000;
export const ANSWER_BYTES_KEPT = 64 * 1024 * 1024;
// An offline task token is not cached content: it names a task in progress that
// the host never saw. A task not continued for this long (counted from the
// token's last use) is not one anyone continues, and a checkpoint under it would
// be replayed into a task context long gone, so the token stops being one and a
// checkpoint under it is refused before it is queued (offline-calls.js). A
// checkpoint queued while it was valid keeps its folder in the outbox and is
// delivered as before.
export const OFFLINE_TOKEN_DAYS = 30;
const OFFLINE_TOKEN_MS = OFFLINE_TOKEN_DAYS * 24 * 60 * 60 * 1000;
// Why a checkpoint waits refused: the host did not know this runner (revoked).
const REVOKED = 'runner_revoked';

export const RUNNER_FORMAT = sqliteFormat({
  store: 'runner',
  schema: `
    CREATE TABLE IF NOT EXISTS host(
      id INTEGER PRIMARY KEY CHECK(id = 1), name TEXT NOT NULL, fingerprint TEXT NOT NULL, cert_pem TEXT NOT NULL,
      port INTEGER NOT NULL, addresses TEXT NOT NULL, last_address TEXT, paired_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS answers(
      key TEXT PRIMARY KEY, tool TEXT NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS offline_tasks(
      token TEXT PRIMARY KEY, project_path TEXT, source_application TEXT NOT NULL, started_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, tool TEXT NOT NULL, input TEXT NOT NULL,
      source_application TEXT NOT NULL, session_id TEXT, offline_project_path TEXT, queued_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued', 'delivered', 'failed')), attempts INTEGER NOT NULL DEFAULT 0,
      claimed_until TEXT, last_error TEXT, settled_at TEXT);`,
  // Version 1 is what 0.29.0-beta.1 shipped.
  migrations: [{
    id: 'runner/2-host-revoked', to: 2, kind: 'add-columns', table: 'host',
    summary: 'when the host answered that it does not know this runner (revoked), so nothing kept is shown again',
    columns: { revoked_at: 'TEXT' }
  }, {
    id: 'runner/3-host-last-seen', to: 3, kind: 'add-columns', table: 'host',
    summary: 'when this computer last reached its host, so the console and `fuli status` can say when it last reached it',
    columns: { last_seen_at: 'TEXT' }
  }, {
    id: 'runner/4-answer-used', to: 4, kind: 'add-columns', table: 'answers',
    summary: 'when each kept answer was last used, so the cache keeps what is used and lets go of what is not',
    columns: { used_at: 'TEXT' }
  }, {
    id: 'runner/5-offline-task-used', to: 5, kind: 'add-columns', table: 'offline_tasks',
    summary: 'when an offline task token was last used, so its 30 days count from its last use, not its start',
    columns: { used_at: 'TEXT' }
  }]
});

export class RunnerStore {
  constructor(path = ':memory:', { now = Date.now } = {}) {
    this.path = path;
    this.now = now;
    this.closed = false;
  }

  // Closed for good: a call that arrives after close() (a request still in
  // flight at shutdown) fails instead of opening the file again, which would
  // keep it locked on Windows (updates, uninstall).
  get db() {
    if (this.closed) throw new Error('The runner store is closed');
    if (!this.database) {
      const db = openFormattedDatabase(this.path, RUNNER_FORMAT);
      try {
        // Older runners kept these private host answers among ordinary offline reads.
        const legacy = db.prepare('SELECT 1 FROM answers WHERE tool = ? LIMIT 1').get(DIAGNOSTIC_EVENTS_TOOL);
        if (legacy) db.prepare('DELETE FROM answers WHERE tool = ?').run(DIAGNOSTIC_EVENTS_TOOL);
        this.database = db;
      } catch (error) {
        db.close();
        throw error;
      }
    }
    return this.database;
  }

  // The paired host, or null before `fuli runner join`; revokedAt is set once it refused this runner.
  host() {
    if (this.#missing()) return null;
    const row = this.db.prepare('SELECT * FROM host WHERE id = 1').get();
    return row ? { name: row.name, fingerprint: row.fingerprint, certPem: row.cert_pem, port: row.port,
      addresses: JSON.parse(row.addresses), lastAddress: row.last_address, pairedAt: row.paired_at,
      revokedAt: row.revoked_at, lastSeenAt: row.last_seen_at ?? null } : null;
  }

  // A pairing. Joining the same host again queues again the checkpoints its
  // refusal held (requeued); with another host, everything kept for the old one
  // goes, its checkpoints included (dropped: how many were waiting or refused).
  saveHost({ name, fingerprint, certPem, port, addresses, lastAddress = null }) {
    return immediateTransaction(this.db, () => {
      const earlier = this.db.prepare('SELECT fingerprint FROM host WHERE id = 1').get();
      let dropped = 0;
      let requeued = 0;
      if (earlier && earlier.fingerprint !== fingerprint) {
        dropped = this.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE state <> 'delivered'").get().count;
        this.#forget();
        this.db.prepare('DELETE FROM outbox').run();
      } else if (earlier) {
        requeued = this.db.prepare(`UPDATE outbox SET state = 'queued', last_error = NULL, settled_at = NULL,
          claimed_until = NULL WHERE state = 'failed' AND last_error = ?`).run(REVOKED).changes;
      }
      this.db.prepare(`INSERT INTO host(id, name, fingerprint, cert_pem, port, addresses, last_address, paired_at)
        VALUES(1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name,
        fingerprint = excluded.fingerprint, cert_pem = excluded.cert_pem, port = excluded.port,
        addresses = excluded.addresses, last_address = excluded.last_address, paired_at = excluded.paired_at,
        revoked_at = NULL`)
        .run(name, fingerprint, certPem, port, JSON.stringify(addresses), lastAddress, this.#nowIso());
      return { dropped, requeued };
    });
  }

  // The host said this runner is not paired (revoked, or a host that lost its
  // records): nothing kept for it is shown again and nothing is sent. Waiting
  // checkpoints stay, refused with REVOKED and never retried, until a join to
  // the same host queues them again or a join elsewhere (or leave) drops them.
  // The host stays named, so the runner can say why.
  revoked() {
    immediateTransaction(this.db, () => {
      const at = this.#nowIso();
      this.db.prepare('UPDATE host SET revoked_at = coalesce(revoked_at, ?) WHERE id = 1').run(at);
      this.#forget();
      this.db.prepare(`UPDATE outbox SET state = 'failed', last_error = ?, settled_at = ?, claimed_until = NULL
        WHERE state = 'queued'`).run(REVOKED, at);
    });
  }

  // `fuli runner leave`: the pairing, the answers, the offline tokens and the outbox.
  leave() {
    if (this.#missing()) return;
    immediateTransaction(this.db, () => {
      this.db.prepare('DELETE FROM host').run();
      this.#forget();
      this.db.prepare('DELETE FROM outbox').run();
    });
  }

  // The address the host last answered on, first in line next time, and when it
  // answered: what the console and `fuli status` show as the last sync.
  hostAnsweredAt(address) {
    const host = this.host();
    if (!host) return;
    const addresses = [address, ...host.addresses.filter((known) => known !== address)].slice(0, KNOWN_ADDRESSES);
    this.db.prepare('UPDATE host SET last_address = ?, addresses = ?, last_seen_at = ? WHERE id = 1')
      .run(address, JSON.stringify(addresses), this.#nowIso());
  }

  // The host answered a request: when this computer last reached it.
  hostSeen() {
    if (this.#missing()) return;
    this.db.prepare('UPDATE host SET last_seen_at = ? WHERE id = 1').run(this.#nowIso());
  }

  // Addresses the host says it has, or the person names (`fuli runner
  // add-address`), so each network the two computers meet on (home, office, a
  // VPN) is tried next time without being told again. The newest come first
  // and the list makes room by dropping the one learned longest ago, instead
  // of staying full for ever once a host has moved networks KNOWN_ADDRESSES
  // times. The address that last answered is kept apart (last_address) and
  // tried whatever this list holds. Only an address a runner may reach a host
  // at is written, whichever way it was learned.
  learnHostAddresses(addresses) {
    const host = this.host();
    if (!host) return;
    const learned = addresses.filter((address) => isReachableHostAddress(address));
    if (!learned.length) return;
    const merged = [...new Set([...learned, ...host.addresses])].slice(0, KNOWN_ADDRESSES);
    this.db.prepare('UPDATE host SET addresses = ? WHERE id = 1').run(JSON.stringify(merged));
  }

  rememberAnswer(key, tool, body) {
    if (tool === DIAGNOSTIC_EVENTS_TOOL) return;
    immediateTransaction(this.db, () => {
      const at = this.#nowIso();
      this.db.prepare(`INSERT INTO answers(key, tool, at, body, used_at) VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET at = excluded.at, body = excluded.body, used_at = excluded.used_at`)
        .run(key, tool, at, JSON.stringify(body), at);
      this.#keepAnswersWithinBounds();
    });
  }

  // Least recently used first, until both bounds hold again.
  #keepAnswersWithinBounds() {
    const { count, bytes } = this.db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(body)), 0) AS bytes FROM answers').get();
    if (count <= ANSWERS_KEPT && bytes <= ANSWER_BYTES_KEPT) return;
    let over = { count: count - ANSWERS_KEPT, bytes: bytes - ANSWER_BYTES_KEPT };
    const remove = this.db.prepare('DELETE FROM answers WHERE key = ?');
    for (const row of this.db.prepare(`SELECT key, LENGTH(body) AS size FROM answers
      ORDER BY COALESCE(used_at, at) ASC`).iterate()) {
      if (over.count <= 0 && over.bytes <= 0) break;
      remove.run(row.key);
      over = { count: over.count - 1, bytes: over.bytes - row.size };
    }
  }

  // { at, body } of the last answer to this call, or null.
  answer(key) {
    if (this.#missing()) return null;
    const row = this.db.prepare('SELECT at, body FROM answers WHERE key = ? AND tool <> ?')
      .get(key, DIAGNOSTIC_EVENTS_TOOL);
    if (!row) return null;
    this.db.prepare('UPDATE answers SET used_at = ? WHERE key = ?').run(this.#nowIso(), key);
    return { at: row.at, body: JSON.parse(row.body) };
  }

  // What the cache holds now against its bounds, for the console and `fuli runner status`.
  answerUsage() {
    if (this.#missing()) return { count: 0, bytes: 0, maxCount: ANSWERS_KEPT, maxBytes: ANSWER_BYTES_KEPT };
    const { count, bytes } = this.db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(body)), 0) AS bytes FROM answers').get();
    return { count, bytes, maxCount: ANSWERS_KEPT, maxBytes: ANSWER_BYTES_KEPT };
  }

  // Every kept task entry, newest first, as { key, at, body }: what the host last gave for each folder.
  taskEntries() {
    if (this.#missing()) return [];
    return this.db.prepare(`SELECT key, at, body FROM answers WHERE key LIKE 'entry:%' ORDER BY at DESC`)
      .all().map((row) => ({ key: row.key, at: row.at, body: JSON.parse(row.body) }));
  }

  // When the host last answered anything this computer kept, or null.
  answeredAt() {
    if (this.#missing()) return null;
    return this.db.prepare('SELECT MAX(at) AS at FROM answers').get()?.at ?? null;
  }

  beginOfflineTask({ token, projectPath, sourceApplication }) {
    immediateTransaction(this.db, () => {
      const at = this.#nowIso();
      this.db.prepare(`INSERT INTO offline_tasks(token, project_path, source_application, started_at, used_at)
        VALUES(?, ?, ?, ?, ?)`).run(token, projectPath ?? null, sourceApplication, at, at);
      this.db.prepare('DELETE FROM offline_tasks WHERE COALESCE(used_at, started_at) <= ?').run(this.#tokensSince());
    });
  }

  // A token this computer gave out offline and used within OFFLINE_TOKEN_DAYS,
  // or null. Reading it counts as using it: the days count from its last use.
  offlineTask(token) {
    if (this.#missing()) return null;
    const row = this.db.prepare('SELECT * FROM offline_tasks WHERE token = ? AND COALESCE(used_at, started_at) > ?')
      .get(token, this.#tokensSince());
    if (!row) return null;
    this.db.prepare('UPDATE offline_tasks SET used_at = ? WHERE token = ?').run(this.#nowIso(), token);
    return { token: row.token, projectPath: row.project_path, sourceApplication: row.source_application,
      startedAt: row.started_at };
  }

  // offlineProjectPath: the folder of the task an offline token entered; the host enters it again at replay.
  // heldFor: kept here instead of queued, listed with this reason (an entry no host could take, or one
  // held until the host can: global-writes-outbox.js); queued again only as that reason says.
  // An id already here is left as it is (two processes queueing the same writes at once):
  // answers whether this queued it.
  enqueue({ id, tool, input, sourceApplication, sessionId = null, offlineProjectPath = null, heldFor = null }) {
    // The store is gone (`fuli runner leave`) while a process still served this
    // computer: queueing would make the file again, holding an entry no host
    // will ever take. Every caller checks the pairing first, so this is a race.
    if (this.#missing()) throw new Error('This computer is no longer paired with a FULI host; nothing was queued');
    const at = this.#nowIso();
    return this.db.prepare(`INSERT OR IGNORE INTO outbox(id, tool, input, source_application, session_id, offline_project_path,
      queued_at, state, last_error, settled_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, tool, JSON.stringify(input),
      sourceApplication, sessionId, offlineProjectPath, at, heldFor ? 'failed' : 'queued', heldFor, heldFor ? at : null).changes === 1;
  }

  // One entry as it stands: { id, tool, state, input, reason }, or null when there is none.
  entry(id) {
    if (this.#missing()) return null;
    const row = this.db.prepare('SELECT id, tool, state, input, last_error FROM outbox WHERE id = ?').get(id);
    return row ? { id: row.id, tool: row.tool, state: row.state, input: JSON.parse(row.input), reason: row.last_error ?? null }
      : null;
  }

  // A follower's writes to global the host answered op by op (outbox-delivery.js):
  // the entry is kept as delivered with the host's answer for each op, so a
  // checkpoint retried under the same key reads what became of them instead of
  // sending them again. refused: { id, input, reason } of an entry listing the
  // ops the host refused for good; again: { id, input, reason } of the ops the
  // host could not take yet, held until it can. Delivered entries go after
  // OFFLINE_TOKEN_DAYS, when no checkpoint of theirs can be retried any more.
  settleWrites(id, { input, refused = null, again = null }) {
    immediateTransaction(this.db, () => {
      const at = this.#nowIso();
      const row = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(id);
      if (!row) return;
      this.db.prepare(`UPDATE outbox SET state = 'delivered', input = ?, claimed_until = NULL, last_error = NULL,
        settled_at = ? WHERE id = ?`).run(JSON.stringify(input), at, id);
      for (const held of [refused, again].filter(Boolean)) {
        this.enqueue({ id: held.id, tool: row.tool, input: held.input, sourceApplication: row.source_application,
          sessionId: row.session_id, heldFor: held.reason });
      }
      this.db.prepare(`DELETE FROM outbox WHERE state = 'delivered' AND settled_at <= ?`).run(this.#tokensSince());
    });
  }

  // Entries held with a reason that begins `prefix` and is not `prefix + current`
  // queued again (a host that could not take them, now on another version); every
  // one held so when current is null.
  requeueHeld(prefix, current = null) {
    if (this.#missing()) return 0;
    return this.db.prepare(`UPDATE outbox SET state = 'queued', last_error = NULL, settled_at = NULL, claimed_until = NULL
      WHERE state = 'failed' AND substr(last_error, 1, ?) = ? AND (? IS NULL OR last_error <> ?)`)
      .run(prefix.length, prefix, current, `${prefix}${current}`).changes;
  }

  // The oldest queued entry, now held by this process; null when there is none
  // or another process holds it, so entries reach the host in the order queued.
  claimNext() {
    if (this.#missing()) return null;
    return immediateTransaction(this.db, () => {
      const row = this.db.prepare(`SELECT * FROM outbox WHERE state = 'queued' ORDER BY seq LIMIT 1`).get();
      if (!row || (row.claimed_until && row.claimed_until >= this.#nowIso())) return null;
      this.db.prepare('UPDATE outbox SET claimed_until = ?, attempts = attempts + 1 WHERE id = ?')
        .run(new Date(this.now() + CLAIM_MS).toISOString(), row.id);
      return { id: row.id, tool: row.tool, input: JSON.parse(row.input), sourceApplication: row.source_application,
        sessionId: row.session_id, offlineProjectPath: row.offline_project_path, queuedAt: row.queued_at,
        attempts: row.attempts + 1, lastError: row.last_error ?? null };
    });
  }

  // Delivered: the host holds it now, so nothing of it is kept here.
  delivered(id) {
    this.db.prepare('DELETE FROM outbox WHERE id = ?').run(id);
  }

  // A host that refused the entry for good: it stays listed with the reason
  // until the pairing ends or a join to the same host queues it again.
  failed(id, reason) {
    this.db.prepare(`UPDATE outbox SET state = 'failed', claimed_until = NULL, settled_at = ?, last_error = ?
      WHERE id = ?`).run(this.#nowIso(), reason, id);
  }

  // Where one entry stands: 'queued', 'failed', or null once delivered (or never queued here);
  // writes to global the host answered are kept a while as 'delivered' (settleWrites).
  entryState(id) {
    if (this.#missing()) return null;
    return this.db.prepare('SELECT state FROM outbox WHERE id = ?').get(id)?.state ?? null;
  }

  // The host could not be reached, or is still applying it: the entry waits for the next attempt.
  release(id, reason) {
    this.db.prepare('UPDATE outbox SET claimed_until = NULL, last_error = ? WHERE id = ?').run(reason, id);
  }

  // The newest checkpoints still waiting for the host: the work done on this
  // computer that the host has not seen, which an offline resume carries over
  // (offline-calls.js).
  queuedCheckpoints(limit = 3) {
    if (this.#missing()) return [];
    return this.db.prepare(`SELECT id, input, queued_at, offline_project_path FROM outbox WHERE state = 'queued'
      AND tool = 'checkpoint_task_knowledge' ORDER BY seq DESC LIMIT ?`).all(limit)
      .map((row) => ({ id: row.id, queuedAt: row.queued_at, input: JSON.parse(row.input),
        offlineProjectPath: row.offline_project_path ?? null }));
  }

  outbox() {
    if (this.#missing()) return { queued: 0, failedCount: 0, failed: [], entries: [] };
    const queued = this.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE state = 'queued'").get().count;
    const failedCount = this.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE state = 'failed'").get().count;
    const failed = this.db.prepare(`SELECT id, tool, queued_at, last_error FROM outbox WHERE state = 'failed'
      ORDER BY seq DESC LIMIT 20`).all().map((row) => ({ id: row.id, tool: row.tool, queuedAt: row.queued_at,
      reason: row.last_error }));
    return { queued, failedCount, failed, entries: this.entries() };
  }

  // Everything still waiting or refused, oldest first: what the console lists
  // one by one (what it is, when it was made, where it stands, why).
  entries(limit = 200) {
    if (this.#missing()) return [];
    return this.db.prepare(`SELECT id, tool, state, queued_at, attempts, last_error, settled_at FROM outbox
      WHERE state <> 'delivered' ORDER BY seq LIMIT ?`).all(limit).map((row) => ({ id: row.id, tool: row.tool,
      state: row.state, queuedAt: row.queued_at, attempts: row.attempts, settledAt: row.settled_at ?? null,
      reason: row.last_error ?? null }));
  }

  // What was read from the host: its answers and the offline task tokens.
  #forget() {
    for (const table of ['answers', 'offline_tasks']) this.db.prepare(`DELETE FROM ${table}`).run();
  }

  #tokensSince() {
    return new Date(this.now() - OFFLINE_TOKEN_MS).toISOString();
  }

  #nowIso() {
    return new Date(this.now()).toISOString();
  }

  #missing() {
    return !this.database && this.path !== ':memory:' && !existsSync(this.path);
  }

  close() {
    this.closed = true;
    this.database?.close();
    this.database = null;
  }
}
