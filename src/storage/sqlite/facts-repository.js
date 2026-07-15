import { randomUUID } from 'node:crypto';

import { FactStatus, nowIso } from '../../models.js';
import { validateFactRecord } from '../record-validation.js';
import { FactSearchRepository } from './fact-search-repository.js';
import { mapFact } from './mapper.js';

export class FactsRepository {
  constructor(db) {
    this.factSearch = new FactSearchRepository(db);
    this.insertStatement = db.prepare(`
      INSERT INTO facts (
        id, space_id, subject, predicate, object, source_episode_id, status,
        confidence, sensitivity, scope, valid_at, invalid_at, replaced_by_fact_id
      ) VALUES (
        @id, @spaceId, @subject, @predicate, @object, @sourceEpisodeId, @status,
        @confidence, @sensitivity, @scope, @validAt, @invalidAt, @replacedByFactId
      )
    `);
    this.getStatement = db.prepare('SELECT * FROM facts WHERE id = ?');
    this.updateStatement = db.prepare(`
      UPDATE facts SET
        space_id = @spaceId,
        subject = @subject,
        predicate = @predicate,
        object = @object,
        source_episode_id = @sourceEpisodeId,
        status = @status,
        confidence = @confidence,
        sensitivity = @sensitivity,
        scope = @scope,
        valid_at = @validAt,
        invalid_at = @invalidAt,
        replaced_by_fact_id = @replacedByFactId
      WHERE id = @id
    `);
    this.currentStatement = db.prepare(`
      SELECT * FROM facts
      WHERE space_id = ?
        AND invalid_at IS NULL
        AND status NOT IN ('rejected', 'deprecated')
      ORDER BY rowid
    `);
    this.currentListStatement = db.prepare(`
      SELECT * FROM facts
      WHERE invalid_at IS NULL AND status NOT IN ('rejected', 'deprecated')
      ORDER BY rowid
    `);
    this.fullListStatement = db.prepare('SELECT * FROM facts ORDER BY rowid');
    this.timelineStatement = db.prepare(`
      SELECT * FROM facts
      WHERE space_id = ? AND subject = ?
      ORDER BY valid_at, rowid
    `);
    this.replaceLinkStatement = db.prepare(`
      UPDATE facts SET replaced_by_fact_id = ? WHERE id = ?
    `);
    this.deleteStatement = db.prepare('DELETE FROM facts');
  }

  add(fact) {
    if (fact.id && this.get(fact.id)) {
      throw new Error(`Duplicate fact id: ${fact.id}`);
    }

    const stored = {
      id: fact.id || randomUUID(),
      spaceId: fact.spaceId,
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      sourceEpisodeId: fact.sourceEpisodeId,
      status: fact.status ?? FactStatus.CONFIRMED,
      confidence: fact.confidence ?? 1,
      sensitivity: fact.sensitivity ?? 'normal',
      scope: fact.scope ?? 'personal',
      validAt: fact.validAt ?? nowIso(),
      invalidAt: fact.invalidAt ?? null,
      replacedByFactId: fact.replacedByFactId ?? null
    };
    validateFactRecord(stored);
    this.insertStatement.run(stored);
    return this.get(stored.id);
  }

  get(id) {
    return mapFact(this.getStatement.get(id));
  }

  update(id, updates) {
    const existing = this.get(id);
    if (!existing) throw new Error(`Fact not found: ${id}`);

    const stored = { ...existing, ...updates, id };
    validateFactRecord(stored);
    this.updateStatement.run(stored);
    return this.get(id);
  }

  invalidate(id, replacedByFactId = null) {
    const fact = this.get(id);
    if (!fact || fact.invalidAt) return;
    this.updateStatement.run({
      ...fact,
      invalidAt: nowIso(),
      replacedByFactId
    });
  }

  current(spaceId) {
    return this.currentStatement.all(spaceId).map(mapFact);
  }

  list({ includeHistorical = false } = {}) {
    const statement = includeHistorical ? this.fullListStatement : this.currentListStatement;
    return statement.all().map(mapFact);
  }

  timeline(spaceId, subject) {
    return this.timelineStatement.all(spaceId, subject).map(mapFact);
  }

  search(spaceIds, query, options = {}) {
    return this.factSearch.search(spaceIds, query, options);
  }

  searchPage(spaceIds, query, options = {}) {
    return this.factSearch.searchPage(spaceIds, query, options);
  }

  insertSnapshot(fact, { deferReplacement = false } = {}) {
    validateFactRecord(fact);
    this.insertStatement.run({
      ...fact,
      replacedByFactId: deferReplacement ? null : fact.replacedByFactId
    });
  }

  restoreReplacement(id, replacedByFactId) {
    this.replaceLinkStatement.run(replacedByFactId, id);
  }

  deleteAll() {
    this.deleteStatement.run();
  }
}
