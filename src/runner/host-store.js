import { existsSync } from 'node:fs';

import { immediateTransaction, openFormattedDatabase, sqliteFormat } from '../../packages/roundtable/src/storage/database-format.js';
import { INVITATION_TTL_MS, invitationCodeHash } from './protocol.js';

// The host's record of its runners (docs/runner.md): who was invited, which
// device certificates paired, when each was last seen and from where, and every
// outbox entry a runner replayed with what it answered, so an entry that
// arrives twice is applied once. A revoked runner stays listed as revoked.
export const RUNNER_HOST_FILE = 'runner/host.sqlite';
// Replayed ids are kept this long; an outbox entry older than that was delivered long ago.
const REPLAY_KEEP_MS = 90 * 24 * 60 * 60 * 1000;

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
    CREATE INDEX IF NOT EXISTS replays_at ON replays(at);`
});

export class RunnerHostStore {
  constructor(path = ':memory:', { now = Date.now } = {}) {
    this.path = path;
    this.now = now;
    this.closed = false;
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

  // Uses the invitation the code names, once, for this device. Answers the
  // runner or null when the code is unknown, used or expired.
  pair({ code, fingerprint, name }) {
    return immediateTransaction(this.db, () => {
      const at = this.#nowIso();
      const invitation = this.db.prepare(`SELECT * FROM invitations WHERE code_hash = ? AND used_by IS NULL
        AND expires_at > ?`).get(invitationCodeHash(code), at);
      if (!invitation) return null;
      this.db.prepare('UPDATE invitations SET used_by = ? WHERE code_hash = ?').run(fingerprint, invitation.code_hash);
      const runnerName = name || invitation.name;
      this.db.prepare(`INSERT INTO runners(fingerprint, name, paired_at) VALUES(?, ?, ?)
        ON CONFLICT(fingerprint) DO UPDATE SET name = excluded.name, paired_at = excluded.paired_at,
        revoked_at = NULL`).run(fingerprint, runnerName, at);
      return { fingerprint, name: runnerName, pairedAt: at };
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
      fingerprint: row.fingerprint, name: row.name, pairedAt: row.paired_at, lastSeenAt: row.last_seen_at,
      lastAddress: row.last_address, revokedAt: row.revoked_at
    }));
  }

  // Answers whether a paired runner was revoked now.
  revoke(fingerprint) {
    return this.db.prepare('UPDATE runners SET revoked_at = ? WHERE fingerprint = ? AND revoked_at IS NULL')
      .run(this.#nowIso(), fingerprint).changes > 0;
  }

  // What an earlier replay of this id answered, or null.
  replayed(id) {
    const row = this.db.prepare('SELECT result FROM replays WHERE id = ?').get(id);
    return row ? JSON.parse(row.result) : null;
  }

  recordReplay({ id, runner, tool, result }) {
    immediateTransaction(this.db, () => {
      this.db.prepare('INSERT OR IGNORE INTO replays(id, runner, tool, at, result) VALUES(?, ?, ?, ?, ?)')
        .run(id, runner, tool, this.#nowIso(), JSON.stringify(result));
      this.db.prepare('DELETE FROM replays WHERE at < ?').run(new Date(this.now() - REPLAY_KEEP_MS).toISOString());
    });
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
