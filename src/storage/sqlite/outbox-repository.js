import { randomUUID } from 'node:crypto';

import { nowIso } from '../../models.js';
import { validateOutboxRecord } from '../record-validation.js';
import { mapOutbox } from './mapper.js';

export class OutboxRepository {
  constructor(db) {
    this.insertStatement = db.prepare(`
      INSERT INTO outbox (
        id, kind, aggregate_id, payload_json, status, attempts,
        next_attempt_at, created_at, sent_at, last_error
      ) VALUES (
        @id, @kind, @aggregateId, @payloadJson, @status, @attempts,
        @nextAttemptAt, @createdAt, @sentAt, @lastError
      )
    `);
    this.getStatement = db.prepare('SELECT * FROM outbox WHERE id = ?');
    this.listStatement = db.prepare('SELECT * FROM outbox ORDER BY rowid');
    this.pendingStatement = db.prepare(`
      SELECT * FROM outbox
      WHERE status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at, rowid
    `);
    this.markSentStatement = db.prepare(`
      UPDATE outbox SET
        status = 'sent', next_attempt_at = NULL, sent_at = ?, last_error = NULL
      WHERE id = ?
    `);
    this.markFailedStatement = db.prepare(`
      UPDATE outbox SET
        status = 'pending', attempts = attempts + 1,
        next_attempt_at = ?, last_error = ?
      WHERE id = ?
    `);
    this.deleteStatement = db.prepare('DELETE FROM outbox');
  }

  enqueue(entry) {
    if (entry.id && this.get(entry.id)) {
      throw new Error(`Duplicate outbox id: ${entry.id}`);
    }

    const stored = {
      id: entry.id || randomUUID(),
      kind: entry.kind,
      aggregateId: entry.aggregateId,
      payloadJson: JSON.stringify(entry.payload),
      status: entry.status ?? 'pending',
      attempts: entry.attempts ?? 0,
      nextAttemptAt: entry.nextAttemptAt ?? null,
      createdAt: entry.createdAt ?? nowIso(),
      sentAt: entry.sentAt ?? null,
      lastError: entry.lastError ?? null
    };
    validateOutboxRecord(stored);
    this.insertStatement.run(stored);
    return this.get(stored.id);
  }

  listPending(at = nowIso()) {
    return this.pendingStatement.all(at).map(mapOutbox);
  }

  markSent(id, sentAt = nowIso()) {
    this.require(id);
    this.markSentStatement.run(sentAt, id);
    return this.get(id);
  }

  markFailed(id, error, nextAttemptAt = null) {
    this.require(id);
    this.markFailedStatement.run(nextAttemptAt, error, id);
    return this.get(id);
  }

  get(id) {
    return mapOutbox(this.getStatement.get(id));
  }

  listAll() {
    return this.listStatement.all().map(mapOutbox);
  }

  insertSnapshot(entry) {
    validateOutboxRecord(entry);
    this.insertStatement.run({
      ...entry,
      payloadJson: JSON.stringify(entry.payload)
    });
  }

  deleteAll() {
    this.deleteStatement.run();
  }

  require(id) {
    const row = this.get(id);
    if (!row) throw new Error(`Outbox row not found: ${id}`);
    return row;
  }
}
