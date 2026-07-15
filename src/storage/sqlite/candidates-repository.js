import { randomUUID } from 'node:crypto';

import { CandidateStatus, nowIso } from '../../models.js';
import { validateCandidateRecord } from '../record-validation.js';
import { mapCandidate } from './mapper.js';

export class CandidatesRepository {
  constructor(db) {
    this.insertStatement = db.prepare(`
      INSERT INTO candidates (
        id, personal_space_id, target_space_id, episode_id, reason,
        status, created_at, decided_at
      ) VALUES (
        @id, @personalSpaceId, @targetSpaceId, @episodeId, @reason,
        @status, @createdAt, @decidedAt
      )
    `);
    this.getStatement = db.prepare('SELECT * FROM candidates WHERE id = ?');
    this.listStatement = db.prepare('SELECT * FROM candidates ORDER BY rowid');
    this.pendingStatement = db.prepare(`
      SELECT * FROM candidates
      WHERE personal_space_id = ? AND status = 'pending'
      ORDER BY rowid
    `);
    this.updateStatusStatement = db.prepare(`
      UPDATE candidates SET status = ?, decided_at = ? WHERE id = ?
    `);
    this.deleteStatement = db.prepare('DELETE FROM candidates');
  }

  add(candidate) {
    if (candidate.id && this.get(candidate.id)) {
      throw new Error(`Duplicate candidate id: ${candidate.id}`);
    }

    const status = candidate.status ?? CandidateStatus.PENDING;
    const createdAt = candidate.createdAt ?? nowIso();
    const stored = {
      id: candidate.id || randomUUID(),
      personalSpaceId: candidate.personalSpaceId,
      targetSpaceId: candidate.targetSpaceId ?? null,
      episodeId: candidate.episodeId,
      reason: candidate.reason,
      status,
      createdAt,
      decidedAt: candidate.decidedAt ?? (
        status === CandidateStatus.PENDING ? null : createdAt
      )
    };
    validateCandidateRecord(stored);
    this.insertStatement.run(stored);
    return this.get(stored.id);
  }

  get(id) {
    return mapCandidate(this.getStatement.get(id));
  }

  list() {
    return this.listStatement.all().map(mapCandidate);
  }

  pending(personalSpaceId) {
    return this.pendingStatement.all(personalSpaceId).map(mapCandidate);
  }

  updateStatus(id, status) {
    const candidate = this.get(id);
    if (!candidate) throw new Error(`Candidate not found: ${id}`);
    const decidedAt = status === CandidateStatus.PENDING ? null : nowIso();
    validateCandidateRecord({ ...candidate, status, decidedAt });
    this.updateStatusStatement.run(status, decidedAt, id);
    return this.get(id);
  }

  insertSnapshot(candidate) {
    validateCandidateRecord(candidate);
    this.insertStatement.run(candidate);
  }

  deleteAll() {
    this.deleteStatement.run();
  }
}
