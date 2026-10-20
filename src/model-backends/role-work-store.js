import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// D-04 §2 role work packages, shared by every console and MCP process on one
// data directory, so a pending package survives restarts. A package is never
// deleted; each change of status is appended to its event history.
//
// pending -> claimed (one session holds a lease) -> applying (an answer
// passed the contract and one execution of the role's operation holds it)
// -> completed (the role used it; its result is stored in the same write)
// | stale (its evidence or policy changed before it was used, or a newer
// package of the same evidence superseded it). applying -> submitted when
// the execution stopped without a result (the operation was busy or failed):
// the answer waits for the next submit, which reruns the operation. An
// applying package whose execution window passed (its process died) is taken
// over the same way. pending/claimed -> expired; claimed -> failed after too
// many invalid answers.
//
// The same work is one role, operation, space and project with the same
// evidence and policy versions. Of the same work at most one package can
// still be answered: a new one supersedes the others (C16).

const OPEN = Object.freeze(['pending', 'claimed']);
const SAME_WORK = `role = :role AND operation = :operation AND space = :space AND project IS :project
  AND evidence_version = :evidence AND policy_version = :policy`;
const COLUMNS = 'package_id, role, operation, request_id, space, project, session_ref, evidence_version, policy_version, '
  + 'status, reason, created_at, expires_at, invalid_submissions, request, resume, fallback_receipt';

export class RoleWorkStore {
  constructor(path = ':memory:') {
    this.path = path;
  }

  // Opened on first use, so a process that never hands off work creates no file.
  get db() {
    if (this.database) return this.database;
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    const db = new DatabaseSync(this.path);
    db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS role_work(
        package_id TEXT PRIMARY KEY, role TEXT NOT NULL, operation TEXT NOT NULL, request_id TEXT NOT NULL,
        space TEXT NOT NULL, project TEXT, session_ref TEXT, evidence_version TEXT NOT NULL, policy_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'submitted', 'applying', 'completed', 'stale', 'expired', 'failed')),
        reason TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, invalid_submissions INTEGER NOT NULL DEFAULT 0,
        lease_token TEXT, lease_session TEXT, lease_source TEXT, lease_claimed_at TEXT, lease_expires_at TEXT,
        request TEXT NOT NULL, resume TEXT, fallback_receipt TEXT, submission TEXT, result TEXT,
        applying_until TEXT, consumed_at TEXT);
      CREATE INDEX IF NOT EXISTS role_work_request ON role_work(role, request_id);
      CREATE INDEX IF NOT EXISTS role_work_open ON role_work(space, status, created_at);
      CREATE TABLE IF NOT EXISTS role_work_events(id INTEGER PRIMARY KEY, package_id TEXT NOT NULL, event TEXT NOT NULL,
        detail TEXT NOT NULL, at TEXT NOT NULL);`);
    this.database = db;
    return db;
  }

  // A new package supersedes every other package of the same work that could
  // still be answered, so two answers to one evidence can never both be used.
  create({ request, resume, reason, fallbackReceipt, at, ttlMs }) {
    const packageId = randomUUID();
    this.#transaction(() => {
      const superseded = this.db.prepare(`SELECT package_id FROM role_work WHERE ${SAME_WORK}
        AND (status IN ('pending', 'claimed', 'submitted') OR (status = 'applying' AND applying_until <= :at))`)
        .all({ ...sameWork(request), at: at.toISOString() });
      for (const { package_id: old } of superseded) {
        this.db.prepare(`UPDATE role_work SET status = 'stale' WHERE package_id = ?`).run(old);
        this.#event(old, 'stale', { reason: 'superseded', by: packageId }, at);
      }
      this.db.prepare(`INSERT INTO role_work(${COLUMNS}) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 0, ?, ?, ?)`).run(
        packageId, request.role, request.operation, request.requestId, request.scope.personalSpaceId,
        request.scope.personalProjectId, request.scope.sessionRef, request.versions.evidence, request.versions.policy,
        reason, at.toISOString(), new Date(at.getTime() + ttlMs).toISOString(), JSON.stringify(request),
        resume ? JSON.stringify(resume) : null, fallbackReceipt ? JSON.stringify(fallbackReceipt) : null);
      this.#event(packageId, 'created', { reason }, at);
    });
    return this.get(packageId);
  }

  get(packageId) {
    const row = this.db.prepare('SELECT * FROM role_work WHERE package_id = ?').get(packageId);
    return row ? workPackage(row) : null;
  }

  // The open package of the same work for this session binding, under any
  // requestId (C16): unanswered, or answered and waiting for a retry. A
  // package bound to another session, or unbound when this request is bound
  // (and the reverse), is not reused; create supersedes it instead.
  open(request, at) {
    const row = this.db.prepare(`SELECT * FROM role_work WHERE ${SAME_WORK} AND session_ref IS :session
      AND status IN ('pending', 'claimed', 'submitted') AND expires_at > :at ORDER BY created_at LIMIT 1`)
      .get({ ...sameWork(request), session: request.scope.sessionRef, at: at.toISOString() });
    return row ? workPackage(row) : null;
  }

  // A package of the same work whose answer an execution is applying now.
  applyingWork(request, at) {
    const row = this.db.prepare(`SELECT * FROM role_work WHERE ${SAME_WORK} AND status = 'applying' AND applying_until > :at
      LIMIT 1`).get({ ...sameWork(request), at: at.toISOString() });
    return row ? workPackage(row) : null;
  }

  // The package whose answer the role's rerun of this request may use.
  applying(role, requestId) {
    const row = this.db.prepare(`SELECT * FROM role_work WHERE role = ? AND request_id = ? AND status = 'applying'
      ORDER BY created_at DESC LIMIT 1`).get(role, requestId);
    return row ? workPackage(row) : null;
  }

  // The oldest package this session may take: bound to it, or unbound in
  // its project (or without one), not held under a live lease.
  nextClaimable(session, at) {
    const row = this.db.prepare(`SELECT * FROM role_work WHERE space = ?1 AND expires_at > ?2
      AND (status = 'pending' OR (status = 'claimed' AND lease_expires_at <= ?2))
      AND (session_ref = ?3 OR (session_ref IS NULL AND (project IS NULL OR project = ?4)))
      ORDER BY created_at LIMIT 1`).get(session.personalSpaceId, at.toISOString(), session.sessionRef, session.personalProjectId);
    return row ? workPackage(row) : null;
  }

  // Returns { workPackage } or { conflict: 'busy' | 'closed' }. A session
  // re-claiming its own live lease gets the same lease back.
  claim(packageId, session, { leaseToken, leaseExpiresAt, at }) {
    return this.#transaction(() => {
      const current = this.get(packageId);
      if (!OPEN.includes(current.status) || Date.parse(current.expiresAt) <= at.getTime()) return { conflict: 'closed' };
      const live = current.status === 'claimed' && Date.parse(current.lease.expiresAt) > at.getTime();
      if (live) return current.lease.sessionRef === session.sessionRef ? { workPackage: current } : { conflict: 'busy' };
      this.db.prepare(`UPDATE role_work SET status = 'claimed', lease_token = ?, lease_session = ?, lease_source = ?,
        lease_claimed_at = ?, lease_expires_at = ? WHERE package_id = ?`).run(leaseToken, session.sessionRef,
        session.sourceApplication, at.toISOString(), leaseExpiresAt.toISOString(), packageId);
      this.#event(packageId, 'claimed', { sessionRef: session.sessionRef }, at);
      return { workPackage: this.get(packageId) };
    });
  }

  // Moves a package on only from one of the expected statuses; null when it
  // was no longer in one of them.
  transition(packageId, from, { status, invalidSubmissions, submission, result, applyingUntil, consumedAt }, event, at) {
    return this.#transaction(() => {
      const current = this.get(packageId);
      if (!current || !from.includes(current.status)) return null;
      this.db.prepare(`UPDATE role_work SET status = ?, invalid_submissions = ?, submission = ?, result = ?,
        applying_until = ?, consumed_at = ? WHERE package_id = ?`)
        .run(status ?? current.status, invalidSubmissions ?? current.invalidSubmissions,
          JSON.stringify(submission ?? current.submission), JSON.stringify(result ?? current.result),
          applyingUntil?.toISOString() ?? current.applyingUntil, consumedAt?.toISOString() ?? current.consumedAt, packageId);
      this.#event(packageId, event.name, event.detail ?? {}, at);
      return this.get(packageId);
    });
  }

  // Starts one execution of a waiting answer: one released for a retry, or
  // one whose earlier execution window passed without a result. Null when
  // another execution holds it or it is settled.
  reapply(packageId, { at, until }) {
    return this.#transaction(() => {
      const current = this.get(packageId);
      const abandoned = current.status === 'applying' && Date.parse(current.applyingUntil) <= at.getTime();
      if (current.status !== 'submitted' && !abandoned) return null;
      return this.transition(packageId, [current.status], { status: 'applying', applyingUntil: until },
        { name: abandoned ? 'applying_taken_over' : 'applying' }, at);
    });
  }

  // The execution ended with the role's result: completed, with that result
  // in the same write, only when the role used the answer; otherwise stale.
  // A package no longer applying is returned as it is.
  finish(packageId, result, at) {
    return this.#transaction(() => {
      const current = this.get(packageId);
      if (current.status !== 'applying') return current;
      return current.consumedAt
        ? this.transition(packageId, ['applying'], { status: 'completed', result }, { name: 'completed' }, at)
        : this.transition(packageId, ['applying'], { status: 'stale' }, { name: 'stale', detail: { reason: 'not_used' } }, at);
    });
  }

  // A late or mismatched answer changes nothing but is kept in the history.
  recordStale(packageId, reason, at) {
    this.#event(packageId, 'stale_submission', { reason }, at);
  }

  expire(at) {
    this.#transaction(() => {
      const due = this.db.prepare(`SELECT package_id FROM role_work WHERE status IN ('pending', 'claimed') AND expires_at <= ?`)
        .all(at.toISOString());
      for (const { package_id: packageId } of due) {
        this.db.prepare(`UPDATE role_work SET status = 'expired' WHERE package_id = ?`).run(packageId);
        this.#event(packageId, 'expired', {}, at);
      }
    });
  }

  counts() {
    return this.db.prepare('SELECT role, status, COUNT(*) AS count FROM role_work GROUP BY role, status ORDER BY role, status').all()
      .map(row => ({ role: row.role, status: row.status, count: row.count }));
  }

  #event(packageId, name, detail, at) {
    this.db.prepare('INSERT INTO role_work_events(package_id, event, detail, at) VALUES(?, ?, ?, ?)')
      .run(packageId, name, JSON.stringify(detail), at.toISOString());
  }

  // Nested calls join the open transaction.
  #transaction(work) {
    if (this.db.isTransaction) return work();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.database?.close();
    this.database = null;
  }
}

function workPackage(row) {
  const json = value => (value === null || value === undefined ? null : JSON.parse(value));
  return {
    packageId: row.package_id, role: row.role, operation: row.operation, requestId: row.request_id,
    scope: { personalSpaceId: row.space, personalProjectId: row.project, sessionRef: row.session_ref },
    versions: { evidence: row.evidence_version, policy: row.policy_version },
    status: row.status, reason: row.reason, createdAt: row.created_at, expiresAt: row.expires_at,
    invalidSubmissions: row.invalid_submissions,
    lease: row.lease_token ? { token: row.lease_token, sessionRef: row.lease_session, sourceApplication: row.lease_source,
      claimedAt: row.lease_claimed_at, expiresAt: row.lease_expires_at } : null,
    request: json(row.request), resume: json(row.resume), fallbackReceipt: json(row.fallback_receipt),
    submission: json(row.submission), result: json(row.result),
    applyingUntil: row.applying_until, consumedAt: row.consumed_at
  };
}

function sameWork(request) {
  return { role: request.role, operation: request.operation, space: request.scope.personalSpaceId,
    project: request.scope.personalProjectId, evidence: request.versions.evidence, policy: request.versions.policy };
}
