import { existsSync } from 'node:fs';

import { immediateTransaction, openFormattedDatabase } from '../../packages/roundtable/src/storage/database-format.js';
import { randomUUID } from 'node:crypto';

import { projectOwnership } from './project-ownership.js';
import { bindLegacyGrants, installGrants, invitationScopes, runnerGrants } from './scope-grants.js';
import { RUNNER_HOST_FORMAT } from './host-format.js';
export { RUNNER_HOST_FORMAT };
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

export class RunnerHostStore {
  constructor(path = ':memory:', { now = Date.now, spaceId = () => null, onProjectConflict } = {}) {
    this.path = path;
    this.now = now;
    this.spaceId = spaceId;
    this.onProjectConflict = onProjectConflict;
    this.closed = false;
    // This store's process: an id pending under another holder was left by a process that stopped.
    this.holder = randomUUID();
  }

  // Closed for good: a call that arrives after close() (a request still in
  // flight at shutdown) fails instead of opening the file again, which would
  // keep it locked on Windows (updates, uninstall).
  get db() {
    if (this.closed) throw new Error('The runner host store is closed');
    if (!this.database) {
      const db = openFormattedDatabase(this.path, RUNNER_HOST_FORMAT);
      try { bindLegacyGrants(db, this.spaceId(), this.now, randomUUID); } catch (error) { db.close(); throw error; }
      this.database = db;
    }
    return this.database;
  }

  invite({ code, name, scopes }) {
    const created = this.now();
    const expiresAt = new Date(created + INVITATION_TTL_MS).toISOString();
    const allowed = invitationScopes(scopes);
    const space = this.spaceId();
    if (scopes !== undefined && !space) throw new TypeError('A limited invitation needs a configured personal space');
    this.db.prepare('INSERT INTO invitations(code_hash, name, created_at, expires_at, grant_space, grant_scopes) VALUES(?,?,?,?,?,?)')
      .run(invitationCodeHash(code), name, new Date(created).toISOString(), expiresAt, space, JSON.stringify(allowed));
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
      if (!invitation || invitation.grant_space !== this.spaceId()) return null;
      if (invitation.grant_space && this.db.prepare(`SELECT 1 FROM owner_inventory
        WHERE space=? AND fingerprint=? AND retired_at IS NOT NULL`).get(invitation.grant_space, fingerprint)) return null;
      const pairing = randomUUID();
      this.db.prepare('UPDATE invitations SET used_by = ? WHERE code_hash = ?').run(fingerprint, invitation.code_hash);
      this.db.prepare(`INSERT INTO runners(fingerprint, name, device_name, paired_at, grant_space, grant_pairing) VALUES(?,?,?,?,?,?)
        ON CONFLICT(fingerprint) DO UPDATE SET name = excluded.name, device_name = excluded.device_name,
        paired_at = excluded.paired_at, revoked_at = NULL,
        grant_pairing = excluded.grant_pairing, grant_space = excluded.grant_space`).run(fingerprint, invitation.name, deviceName || null, at, invitation.grant_space, pairing);
      if (invitation.grant_space) {
        installGrants(this.db, invitation.grant_space, fingerprint, pairing, JSON.parse(invitation.grant_scopes), at);
        this.ownership().expect(fingerprint);
        // Re-pairing preserves claims but requires a fresh owner inventory.
        this.db.prepare('UPDATE owner_inventory SET checked_at=NULL WHERE space=? AND fingerprint=?')
          .run(invitation.grant_space, fingerprint);
      }
      return { fingerprint, name: invitation.name, deviceName: deviceName || null, pairedAt: at };
    });
  }

  // An installation without a personal space cannot issue a limited invitation.
  // Recognize its active full pairing only while the host still has no space.
  fullAccess(fingerprint) {
    if (this.spaceId()) return this.grants(fingerprint).unrestricted();
    return Boolean(this.db.prepare(`SELECT 1 FROM runners r JOIN invitations i ON i.used_by=r.fingerprint
      WHERE r.fingerprint=? AND r.revoked_at IS NULL AND r.grant_space IS NULL
      AND i.grant_space IS NULL AND (i.grant_scopes IS NULL OR i.grant_scopes='["*"]')`).get(fingerprint));
  }

  ownership() {
    return projectOwnership(this, this.spaceId());
  }

  grants(fingerprint) {
    return runnerGrants(this, this.spaceId(), fingerprint);
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
