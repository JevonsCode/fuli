import { existsSync } from 'node:fs';

import { immediateTransaction, openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';
import { randomUUID } from 'node:crypto';

import { CALL_TIMEOUT_MS, INVITATION_TTL_MS, invitationCodeHash } from './protocol.js';

// The host's record of its runners (docs/runner.md): who was invited under
// which name the person typed, which device certificates paired and what each
// device calls itself, when each was last seen and from where, and every
// checkpoint a runner sent under an id (queued or online) with what it
// answered, so an entry that arrives twice is applied once. A revoked runner
// stays listed as revoked.
export const RUNNER_HOST_FILE = 'runner/host.sqlite';
// Replayed ids are kept this long; an outbox entry older than that was delivered long ago.
const REPLAY_KEEP_MS = 90 * 24 * 60 * 60 * 1000;
// An id being applied is held by the process applying it, for longer than the
// longest call a runner waits for, so a second delivery meanwhile is told to
// wait. Only a host that stopped in the middle of an entry leaves one held: the
// next process applies it again at once, and an id held past this is too.
const REPLAY_PENDING_MS = CALL_TIMEOUT_MS + 5 * 60_000;

export const RUNNER_HOST_FORMAT = sqliteFormat({
  store: 'runner-host',
  schema: `
    CREATE TABLE IF NOT EXISTS runners(
      fingerprint TEXT PRIMARY KEY, name TEXT NOT NULL, paired_at TEXT NOT NULL,
      last_seen_at TEXT, last_address TEXT, revoked_at TEXT);
    CREATE TABLE IF NOT EXISTS invitations(
      code_hash TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      used_by TEXT);
    CREATE TABLE IF NOT EXISTS replays(
      id TEXT PRIMARY KEY, runner TEXT NOT NULL, tool TEXT NOT NULL, at TEXT NOT NULL, result TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS replays_at ON replays(at);`,
  // Version 1 is what 0.29.0-beta.1 shipped; every beta.1 host has it.
  migrations: [{
    id: 'runner-host/2-runner-device-name', to: 2, kind: 'add-columns', table: 'runners',
    summary: 'the name each runner gives itself, shown beside the name the person typed at its invitation',
    columns: { device_name: 'TEXT' }
  }, {
    // An id is a runner's own (key runner, id), held pending while it is applied.
    id: 'runner-host/3-replays-per-runner', to: 3, kind: 'replace-table', table: 'replays',
    summary: 'checkpoint ids kept per runner and held while applied; the replays table is made again and the '
      + 'beta.1 replay records are not kept',
    discardsRows: 'a replay record only answers a runner that delivers the same entry again; an entry still waiting '
      + 'is delivered again and applied once more at most, which beta.1 already allowed',
    create: `CREATE TABLE replays(
      runner TEXT NOT NULL, id TEXT NOT NULL, tool TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'done')), at TEXT NOT NULL, result TEXT, holder TEXT,
      PRIMARY KEY(runner, id));
    CREATE INDEX IF NOT EXISTS replays_at ON replays(at);`
  }]
});

export class RunnerHostStore {
  constructor(path = ':memory:', { now = Date.now } = {}) {
    this.path = path;
    this.now = now;
    this.closed = false;
    // This store's process: an id pending under another holder was left by a process that stopped.
    this.holder = randomUUID();
  }

  // Closed for good: a call that arrives after close() (a request still in
  // flight at shutdown) fails instead of opening the file again, which would
  // keep it locked on Windows (updates, uninstall).
  get db() {
    if (this.closed) throw new Error('The runner host store is closed');
    this.database ??= openFormattedDatabase(this.path, RUNNER_HOST_FORMAT);
    return this.database;
  }

  invite({ code, name }) {
    const created = this.now();
    const expiresAt = new Date(created + INVITATION_TTL_MS).toISOString();
    this.db.prepare('INSERT INTO invitations(code_hash, name, created_at, expires_at) VALUES(?, ?, ?, ?)')
      .run(invitationCodeHash(code), name, new Date(created).toISOString(), expiresAt);
    return { expiresAt };
  }

  // True while an invitation can still be used: the listener must run for it.
  hasLiveInvitation() {
    if (this.#missing()) return false;
    return Boolean(this.db.prepare('SELECT 1 FROM invitations WHERE used_by IS NULL AND expires_at > ? LIMIT 1')
      .get(this.#nowIso()));
  }

  nextInvitationExpiry() {
    if (this.#missing()) return null;
    return this.db.prepare('SELECT MIN(expires_at) AS at FROM invitations WHERE used_by IS NULL AND expires_at > ?')
      .get(this.#nowIso()).at ?? null;
  }

  // Uses the invitation the code names, once, for this device. The runner is
  // listed under the name the person typed at the invitation; deviceName is
  // what the joining device calls itself, shown beside it. Answers the runner
  // or null when the code is unknown, used or expired.
  pair({ code, fingerprint, deviceName = null }) {
    return immediateTransaction(this.db, () => {
      const at = this.#nowIso();
      const invitation = this.db.prepare(`SELECT * FROM invitations WHERE code_hash = ? AND used_by IS NULL
        AND expires_at > ?`).get(invitationCodeHash(code), at);
      if (!invitation) return null;
      this.db.prepare('UPDATE invitations SET used_by = ? WHERE code_hash = ?').run(fingerprint, invitation.code_hash);
      this.db.prepare(`INSERT INTO runners(fingerprint, name, device_name, paired_at) VALUES(?, ?, ?, ?)
        ON CONFLICT(fingerprint) DO UPDATE SET name = excluded.name, device_name = excluded.device_name,
        paired_at = excluded.paired_at, revoked_at = NULL`).run(fingerprint, invitation.name, deviceName || null, at);
      return { fingerprint, name: invitation.name, deviceName: deviceName || null, pairedAt: at };
    });
  }

  isPaired(fingerprint) {
    if (this.#missing()) return false;
    return Boolean(this.db.prepare('SELECT 1 FROM runners WHERE fingerprint = ? AND revoked_at IS NULL')
      .get(fingerprint));
  }

  hasRunners() {
    if (this.#missing()) return false;
    return Boolean(this.db.prepare('SELECT 1 FROM runners WHERE revoked_at IS NULL LIMIT 1').get());
  }

  seen(fingerprint, address) {
    this.db.prepare('UPDATE runners SET last_seen_at = ?, last_address = ? WHERE fingerprint = ?')
      .run(this.#nowIso(), address ?? null, fingerprint);
  }

  runners() {
    if (this.#missing()) return [];
    return this.db.prepare('SELECT * FROM runners ORDER BY paired_at').all().map((row) => ({
      fingerprint: row.fingerprint, name: row.name, deviceName: row.device_name, pairedAt: row.paired_at,
      lastSeenAt: row.last_seen_at, lastAddress: row.last_address, revokedAt: row.revoked_at
    }));
  }

  // Answers whether a paired runner was revoked now.
  revoke(fingerprint) {
    return this.db.prepare('UPDATE runners SET revoked_at = ? WHERE fingerprint = ? AND revoked_at IS NULL')
      .run(this.#nowIso(), fingerprint).changes > 0;
  }

  // Takes one runner's entry id for applying it, in one transaction with the
  // check: { state: 'claimed' } (apply it, then finishReplay or releaseReplay),
  // { state: 'pending' } while another delivery of it is being applied, or
  // { state: 'done', result } with what it answered then. Ids are the runner's
  // own: another runner's same id is another entry.
  claimReplay({ runner, id, tool }) {
    return immediateTransaction(this.db, () => {
      const at = this.#nowIso();
      const row = this.db.prepare('SELECT state, at, result, holder FROM replays WHERE runner = ? AND id = ?').get(runner, id);
      if (row?.state === 'done') return { state: 'done', result: JSON.parse(row.result) };
      if (row && row.holder === this.holder && Date.parse(row.at) > this.now() - REPLAY_PENDING_MS) return { state: 'pending' };
      this.db.prepare(`INSERT INTO replays(runner, id, tool, state, at, holder) VALUES(?, ?, ?, 'pending', ?, ?)
        ON CONFLICT(runner, id) DO UPDATE SET tool = excluded.tool, state = 'pending', at = excluded.at, result = NULL,
        holder = excluded.holder`)
        .run(runner, id, tool, at, this.holder);
      return { state: 'claimed' };
    });
  }

  finishReplay({ runner, id, result }) {
    immediateTransaction(this.db, () => {
      this.db.prepare(`UPDATE replays SET state = 'done', at = ?, result = ? WHERE runner = ? AND id = ?`)
        .run(this.#nowIso(), JSON.stringify(result ?? null), runner, id);
      this.db.prepare('DELETE FROM replays WHERE at < ?').run(new Date(this.now() - REPLAY_KEEP_MS).toISOString());
    });
  }

  // The entry was not applied (the host refused or failed it): its id is free again.
  releaseReplay({ runner, id }) {
    this.db.prepare(`DELETE FROM replays WHERE runner = ? AND id = ? AND state = 'pending'`).run(runner, id);
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
