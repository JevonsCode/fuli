import { existsSync } from 'node:fs';

import { immediateTransaction, openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';
import { REPLAY_WAIT_MS } from './protocol.js';

// A runner's own record (docs/runner.md): the host it paired with, the last
// answer it read for each read-only call (shown, marked offline, while the host
// is away, for at most ANSWER_KEEP_MS), the task tokens it gave out while
// offline, and its outbox: checkpoints made while the host was away, or whose
// online delivery has no known outcome, replayed oldest first, each applied
// once; a delivered one is deleted, a refused one after 30 days. Nothing here
// is the person's knowledge of record; the host holds that. A host that says
// this runner is revoked or unknown ends what was read from it and holds the
// waiting checkpoints refused; a pairing with another host, and `fuli runner
// leave`, end everything kept for the old pairing.
// How many of the host's addresses a runner keeps: enough for every network it is used on.
const KNOWN_ADDRESSES = 16;

export const RUNNER_FILE = 'runner/runner.sqlite';
// An outbox entry a process claimed is its own for this long: past its wait for the host.
const CLAIM_MS = REPLAY_WAIT_MS + 60 * 1000;
// Answers and offline task tokens older than this are deleted, and so are refused outbox entries.
const ANSWER_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const FAILED_KEEP_MS = ANSWER_KEEP_MS;
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
    this.database ??= openFormattedDatabase(this.path, RUNNER_FORMAT);
    return this.database;
  }

  // The paired host, or null before `fuli runner join`; revokedAt is set once it refused this runner.
  host() {
    if (this.#missing()) return null;
    const row = this.db.prepare('SELECT * FROM host WHERE id = 1').get();
    return row ? { name: row.name, fingerprint: row.fingerprint, certPem: row.cert_pem, port: row.port,
      addresses: JSON.parse(row.addresses), lastAddress: row.last_address, pairedAt: row.paired_at,
      revokedAt: row.revoked_at } : null;
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
      this.#pruneRefused();
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

  // The address the host last answered on, first in line next time.
  hostAnsweredAt(address) {
    const host = this.host();
    if (!host) return;
    const addresses = [address, ...host.addresses.filter((known) => known !== address)].slice(0, KNOWN_ADDRESSES);
    this.db.prepare('UPDATE host SET last_address = ?, addresses = ? WHERE id = 1').run(address, JSON.stringify(addresses));
  }

  // Addresses the host says it has, or the person names (`fuli runner add-address`):
  // kept after the ones known already, so each network the two computers meet on
  // is remembered (home, office) and tried next time without being told again.
  // first: put them ahead of the others, for an address the person just named.
  learnHostAddresses(addresses, { first = false } = {}) {
    const host = this.host();
    if (!host) return;
    const fresh = addresses.filter((address) => typeof address === 'string' && address && !host.addresses.includes(address));
    const merged = first ? [...new Set([...addresses, ...host.addresses])] : [...host.addresses, ...fresh];
    this.db.prepare('UPDATE host SET addresses = ? WHERE id = 1').run(JSON.stringify(merged.slice(0, KNOWN_ADDRESSES)));
  }

  rememberAnswer(key, tool, body) {
    immediateTransaction(this.db, () => {
      this.db.prepare(`INSERT INTO answers(key, tool, at, body) VALUES(?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET at = excluded.at, body = excluded.body`)
        .run(key, tool, this.#nowIso(), JSON.stringify(body));
      this.db.prepare('DELETE FROM answers WHERE at <= ?').run(this.#keptSince());
    });
  }

  // { at, body } of the last answer to this call, or null.
  answer(key) {
    if (this.#missing()) return null;
    const row = this.db.prepare('SELECT at, body FROM answers WHERE key = ? AND at > ?').get(key, this.#keptSince());
    return row ? { at: row.at, body: JSON.parse(row.body) } : null;
  }

  beginOfflineTask({ token, projectPath, sourceApplication }) {
    immediateTransaction(this.db, () => {
      this.db.prepare(`INSERT INTO offline_tasks(token, project_path, source_application, started_at)
        VALUES(?, ?, ?, ?)`).run(token, projectPath ?? null, sourceApplication, this.#nowIso());
      this.db.prepare('DELETE FROM offline_tasks WHERE started_at <= ?').run(this.#keptSince());
    });
  }

  offlineTask(token) {
    if (this.#missing()) return null;
    const row = this.db.prepare('SELECT * FROM offline_tasks WHERE token = ?').get(token);
    return row ? { token: row.token, projectPath: row.project_path, sourceApplication: row.source_application,
      startedAt: row.started_at } : null;
  }

  // offlineProjectPath: the folder of the task an offline token entered; the host enters it again at replay.
  enqueue({ id, tool, input, sourceApplication, sessionId = null, offlineProjectPath = null }) {
    this.db.prepare(`INSERT INTO outbox(id, tool, input, source_application, session_id, offline_project_path,
      queued_at, state) VALUES(?, ?, ?, ?, ?, ?, ?, 'queued')`).run(id, tool, JSON.stringify(input), sourceApplication,
      sessionId, offlineProjectPath, this.#nowIso());
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
        attempts: row.attempts + 1 };
    });
  }

  // Delivered: the host holds it now, so nothing of it is kept here.
  delivered(id) {
    this.db.prepare('DELETE FROM outbox WHERE id = ?').run(id);
  }

  // A host that refused the entry for good: it stays listed with the reason for FAILED_KEEP_MS.
  failed(id, reason) {
    immediateTransaction(this.db, () => {
      this.db.prepare(`UPDATE outbox SET state = 'failed', claimed_until = NULL, settled_at = ?, last_error = ?
        WHERE id = ?`).run(this.#nowIso(), reason, id);
      this.#pruneRefused();
    });
  }

  // Deletes refused entries past FAILED_KEEP_MS; the runner's MCP process calls it at start too.
  pruneRefused() {
    if (this.#missing()) return;
    this.#pruneRefused();
  }

  #pruneRefused() {
    this.db.prepare(`DELETE FROM outbox WHERE state <> 'queued' AND settled_at <= ?`)
      .run(new Date(this.now() - FAILED_KEEP_MS).toISOString());
  }

  // Where one entry stands: 'queued', 'failed', or null once delivered (or never queued here).
  entryState(id) {
    if (this.#missing()) return null;
    return this.db.prepare('SELECT state FROM outbox WHERE id = ?').get(id)?.state ?? null;
  }

  // The host could not be reached, or is still applying it: the entry waits for the next attempt.
  release(id, reason) {
    this.db.prepare('UPDATE outbox SET claimed_until = NULL, last_error = ? WHERE id = ?').run(reason, id);
  }

  outbox() {
    if (this.#missing()) return { queued: 0, failedCount: 0, failed: [] };
    const queued = this.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE state = 'queued'").get().count;
    const failedCount = this.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE state = 'failed'").get().count;
    const failed = this.db.prepare(`SELECT id, tool, queued_at, last_error FROM outbox WHERE state = 'failed'
      ORDER BY seq DESC LIMIT 20`).all().map((row) => ({ id: row.id, tool: row.tool, queuedAt: row.queued_at,
      reason: row.last_error }));
    return { queued, failedCount, failed };
  }

  // What was read from the host: its answers and the offline task tokens.
  #forget() {
    for (const table of ['answers', 'offline_tasks']) this.db.prepare(`DELETE FROM ${table}`).run();
  }

  #keptSince() {
    return new Date(this.now() - ANSWER_KEEP_MS).toISOString();
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
