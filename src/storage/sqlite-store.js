import { configureDatabase, runMigrations } from './migrate.js';
import { CandidatesRepository } from './sqlite/candidates-repository.js';
import { EpisodeEvidenceRepository } from './sqlite/episode-evidence-repository.js';
import { registerEpisodePrivacyFunction } from './sqlite/episode-privacy-sql.js';
import { EpisodesRepository } from './sqlite/episodes-repository.js';
import { FactsRepository } from './sqlite/facts-repository.js';
import { ImportsRepository } from './sqlite/imports-repository.js';
import { OutboxRepository } from './sqlite/outbox-repository.js';
import { openDatabase } from './sqlite/open-database.js';
import { SnapshotRepository } from './sqlite/snapshot-repository.js';
import { SpacesRepository } from './sqlite/spaces-repository.js';
import { SubscriptionsRepository } from './sqlite/subscriptions-repository.js';

export class SqliteStore {
  #db;
  #repositories;
  #schemaVersionsStatement;
  #transactionActive = false;

  constructor(filePath = '.fuli/context.db') {
    this.#db = openDatabase(filePath);
    try {
      configureDatabase(this.#db, filePath);
      runMigrations(this.#db);
      this.#repositories = createRepositories(this.#db);
      this.#schemaVersionsStatement = this.#db.prepare(`
        SELECT version FROM schema_migrations ORDER BY version
      `);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  transaction(fn, { mode = 'default' } = {}) {
    if (this.#transactionActive) {
      throw new TypeError('Nested SqliteStore transactions are not supported');
    }
    if (fn.constructor?.name === 'AsyncFunction') {
      throw new TypeError('Transaction callback must be synchronous');
    }

    this.#transactionActive = true;
    try {
      const transaction = this.#db.transaction(() => {
        const result = fn(this);
        if (isThenable(result)) {
          if (typeof result.catch === 'function') result.catch(() => {});
          throw new TypeError('Transaction callback must be synchronous');
        }
        return result;
      });
      const run = mode === 'immediate' ? transaction.immediate : transaction;
      if (typeof run !== 'function') throw new TypeError(`Unsupported transaction mode: ${mode}`);
      return run();
    } finally {
      this.#transactionActive = false;
    }
  }

  createSpace(name, kind, description = null) {
    return this.#repositories.spaces.create(name, kind, description);
  }

  listSpaces() { return this.#repositories.spaces.list(); }
  findSpaceByName(name) { return this.#repositories.spaces.findByName(name); }
  getSpace(id) { return this.#repositories.spaces.get(id); }

  subscribe(personalSpaceId, spaceId, mode = 'latest') {
    return this.#repositories.subscriptions.subscribe(personalSpaceId, spaceId, mode);
  }

  listSubscriptions() { return this.#repositories.subscriptions.list(); }
  subscriptionsFor(personalSpaceId) {
    return this.#repositories.subscriptions.forPersonalSpace(personalSpaceId);
  }

  addEpisode(spaceId, sourceKind, body, sourceUri = null, metadata = {}) {
    return this.#repositories.episodes.add(spaceId, sourceKind, body, sourceUri, metadata);
  }

  getEpisode(id) { return this.#repositories.episodes.get(id); }
  listEpisodes() { return this.#repositories.episodes.list(); }
  episodeEvidencePreview(spaceId, episodeId, options = {}) {
    return this.#repositories.episodeEvidence.source(spaceId, episodeId, options);
  }
  correctionEpisodeEvidencePreviews(spaceId, factIds, options = {}) {
    return this.#repositories.episodeEvidence.corrections(spaceId, factIds, options);
  }
  addFact(fact) { return this.#repositories.facts.add(fact); }
  getFact(id) { return this.#repositories.facts.get(id); }
  updateFact(id, updates) { return this.#repositories.facts.update(id, updates); }
  invalidateFact(id, replacedByFactId = null) {
    return this.#repositories.facts.invalidate(id, replacedByFactId);
  }

  currentFacts(spaceId) { return this.#repositories.facts.current(spaceId); }
  listFacts(options = {}) { return this.#repositories.facts.list(options); }
  timeline(spaceId, subject) { return this.#repositories.facts.timeline(spaceId, subject); }
  searchFacts(spaceIds, query, options = {}) {
    return this.#repositories.facts.search(spaceIds, query, options);
  }
  searchFactsPage(spaceIds, query, options = {}) {
    return this.#repositories.facts.searchPage(spaceIds, query, options);
  }

  addCandidate(candidate) { return this.#repositories.candidates.add(candidate); }
  getCandidate(id) { return this.#repositories.candidates.get(id); }
  listCandidates() { return this.#repositories.candidates.list(); }
  pendingCandidates(personalSpaceId) {
    return this.#repositories.candidates.pending(personalSpaceId);
  }

  updateCandidateStatus(id, status) {
    return this.#repositories.candidates.updateStatus(id, status);
  }

  enqueueOutbox(entry) { return this.#repositories.outbox.enqueue(entry); }
  listPendingOutbox(at) { return this.#repositories.outbox.listPending(at); }
  markOutboxSent(id, sentAt) { return this.#repositories.outbox.markSent(id, sentAt); }
  markOutboxFailed(id, error, nextAttemptAt = null) {
    return this.#repositories.outbox.markFailed(id, error, nextAttemptAt);
  }

  hasImport(contentHash) { return this.#repositories.imports.has(contentHash); }
  recordImport(record) { return this.#repositories.imports.record(record); }
  exportSnapshot() { return this.#repositories.snapshot.export(); }
  importSnapshot(snapshot) { return this.#repositories.snapshot.import(snapshot); }

  schemaVersions() {
    return this.#schemaVersionsStatement.pluck().all();
  }

  close() {
    if (this.#db.open) this.#db.close();
  }
}

function createRepositories(db) {
  registerEpisodePrivacyFunction(db);
  const repositories = {
    spaces: new SpacesRepository(db),
    subscriptions: new SubscriptionsRepository(db),
    episodes: new EpisodesRepository(db),
    episodeEvidence: new EpisodeEvidenceRepository(db),
    facts: new FactsRepository(db),
    candidates: new CandidatesRepository(db),
    outbox: new OutboxRepository(db),
    imports: new ImportsRepository(db)
  };
  repositories.snapshot = new SnapshotRepository(db, repositories);
  return repositories;
}

function isThenable(value) {
  return value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof value.then === 'function';
}
