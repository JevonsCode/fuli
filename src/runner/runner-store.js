import { existsSync } from 'node:fs';

import { immediateTransaction, openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';
import { REPLAY_WAIT_MS } from './protocol.js';

// A runner's own record (docs/runner.md): the host it paired with, the last
// answer it read for each read-only call (shown, marked offline, while the host
// is away, for at most ANSWER_KEEP_MS), the task tokens it gave out while
// offline, and its outbox: checkpoints made while the host was away, or whose
// online delivery has no known outcome, replayed oldest first, each applied
// once. Nothing here is the person's knowledge of record; the host holds that.
// A host that says this runner is revoked or unknown, a pairing with another
// host, and `fuli runner leave` end what was kept for the old pairing.
export const RUNNER_FILE = 'runner/runner.sqlite';
// An outbox entry a process claimed is its own for this long: past its wait for the host.
const CLAIM_MS = REPLAY_WAIT_MS + 60 * 1000;
// Answers and offline task tokens older than this are deleted.
const ANSWER_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export const RUNNER_FORMAT = sqliteFormat({
  store: 'runner',
  schema: `
    CREATE TABLE IF NOT EXISTS host(
      id INTEGER PRIMARY KEY CHECK(id = 1), name TEXT NOT NULL, fingerprint TEXT NOT NULL, cert_pem TEXT NOT NULL,
      port INTEGER NOT NULL, addresses TEXT NOT NULL, last_address TEXT, paired_at TEXT NOT NULL, revoked_at TEXT);
    CREATE TABLE IF NOT EXISTS answers(
      key TEXT PRIMARY KEY, tool TEXT NOT NULL, at TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS offline_tasks(
      token TEXT PRIMARY KEY, project_path TEXT, source_application TEXT NOT NULL, started_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, tool TEXT NOT NULL, input TEXT NOT NULL,
      source_application TEXT NOT NULL, session_id TEXT, offline_project_path TEXT, queued_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued', 'delivered', 'failed')), attempts INTEGER NOT NULL DEFAULT 0,
      claimed_until TEXT, last_error TEXT, settled_at TEXT);`
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

  // A pairing. With another host, what was kept of the old one (answers, offline task tokens) goes.
  saveHost({ name, fingerprint, certPem, port, addresses, lastAddress = null }) {
    immediateTransaction(this.db, () => {
      const earlier = this.db.prepare('SELECT fingerprint FROM host WHERE id = 1').get();
      if (earlier && earlier.fingerprint !== fingerprint) {
        this.db.prepare('DELETE FROM answers').run();
        this.db.prepare('DELETE FROM offline_tasks').run();
      }
      this.db.prepare(`INSERT INTO host(id, name, fingerprint, cert_pem, port, addresses, last_address, paired_at)
        VALUES(1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name,
        fingerprint = excluded.fingerprint, cert_pem = excluded.cert_pem, port = excluded.port,
        addresses = excluded.addresses, last_address = excluded.last_address, paired_at = excluded.paired_at,
        revoked_at = NULL`)
        .run(name, fingerprint, certPem, port, JSON.stringify(addresses), lastAddress, this.#nowIso());
    });
  }

  // The host said this runner is not paired (revoked, or never known there):
  // nothing kept for it is shown or sent again. The host stays named, so
  // the runner can say why, until it joins again or leaves.
  revoked() {
    immediateTransaction(this.db, () => {
      this.db.prepare('UPDATE host SET revoked_at = coalesce(revoked_at, ?) WHERE id = 1').run(this.#nowIso());
      this.#forget();
    });
  }

  // `fuli runner leave`: the pairing, the answers, the offline tokens and the outbox.
  leave() {
    if (this.#missing()) return;
    immediateTransaction(this.db, () => {
      this.db.prepare('DELETE FROM host').run();
      this.#forget();
    });
  }

  // The address the host last answered on, first in line next time.
  hostAnsweredAt(address) {
    const host = this.host();
    if (!host) return;
    const addresses = [address, ...host.addresses.filter((known) => known !== address)].slice(0, 8);
    this.db.prepare('UPDATE host SET last_address = ?, addresses = ? WHERE id = 1').run(address, JSON.stringify(addresses));
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

  delivered(id) {
    this.db.prepare(`UPDATE outbox SET state = 'delivered', claimed_until = NULL, settled_at = ?, last_error = NULL
      WHERE id = ?`).run(this.#nowIso(), id);
  }

  // A host that refused the entry for good: it stays listed with the reason.
  failed(id, reason) {
    this.db.prepare(`UPDATE outbox SET state = 'failed', claimed_until = NULL, settled_at = ?, last_error = ?
      WHERE id = ?`).run(this.#nowIso(), reason, id);
  }

  // The host could not be reached, or is still applying it: the entry waits for the next attempt.
  release(id, reason) {
    this.db.prepare('UPDATE outbox SET claimed_until = NULL, last_error = ? WHERE id = ?').run(reason, id);
  }

  outbox() {
    if (this.#missing()) return { queued: 0, failed: [] };
    const queued = this.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE state = 'queued'").get().count;
    const failed = this.db.prepare(`SELECT id, tool, queued_at, last_error FROM outbox WHERE state = 'failed'
      ORDER BY seq DESC LIMIT 20`).all().map((row) => ({ id: row.id, tool: row.tool, queuedAt: row.queued_at,
      reason: row.last_error }));
    return { queued, failed };
  }

  #forget() {
    for (const table of ['answers', 'offline_tasks', 'outbox']) this.db.prepare(`DELETE FROM ${table}`).run();
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
