import { randomUUID } from 'node:crypto';

import { CandidateStatus, FactStatus, isCurrentFact, nowIso } from '../models.js';
import { FileEpisodeIndex } from './file/episode-index.js';
import {
  fileCorrectionEpisodeEvidencePreviews,
  fileEpisodeEvidencePreview
} from './file/episode-evidence.js';
import { searchFileFacts, searchFileFactsPage } from './file/fact-search.js';
import { readJsonFile, writeJsonFileAtomic } from './json-file.js';
import {
  validateCandidateRecord,
  validateFactRecord,
  validateOutboxRecord
} from './record-validation.js';
import { normalizeSnapshot } from './snapshot-defaults.js';

export class FileStore {
  #committedData;
  #episodeIndex;

  constructor(filePath, { jsonFileIo } = {}) {
    this.filePath = filePath;
    this.memoryOnly = filePath === ':memory:';
    this.jsonFileIo = jsonFileIo;
    this.transactionActive = false;
    this.transactionDirty = false;
    this.data = this.memoryOnly ? normalizeSnapshot() : this.#load();
    this.#committedData = cloneData(this.data);
    this.#episodeIndex = new FileEpisodeIndex(this.data.episodes);
  }

  transaction(fn, _options = {}) {
    if (this.transactionActive) {
      throw new TypeError('Nested FileStore transactions are not supported');
    }

    if (fn.constructor?.name === 'AsyncFunction') {
      throw new TypeError('Transaction callback must be synchronous');
    }

    const snapshot = cloneData(this.data);
    this.transactionActive = true;
    this.transactionDirty = false;
    try {
      const result = fn(this);
      if (isThenable(result)) {
        if (typeof result.catch === 'function') result.catch(() => {});
        throw new TypeError('Transaction callback must be synchronous');
      }

      const dirty = this.transactionDirty;
      this.transactionActive = false;
      this.transactionDirty = false;
      if (dirty) this.#commit();
      return result;
    } catch (error) {
      this.data = snapshot;
      this.#episodeIndex.rebuild(this.data.episodes);
      this.transactionActive = false;
      this.transactionDirty = false;
      throw error;
    }
  }

  createSpace(name, kind, description = null) {
    const existing = this.findSpaceByName(name);
    if (existing) return existing;

    const space = {
      id: randomUUID(),
      name,
      kind,
      description,
      createdAt: nowIso()
    };
    this.data.spaces.push(space);
    this.#save();
    return cloneData(space);
  }

  listSpaces() {
    return cloneData(this.data.spaces);
  }

  findSpaceByName(name) {
    return cloneData(this.data.spaces.find((space) => space.name === name) ?? null);
  }

  getSpace(id) {
    return cloneData(this.data.spaces.find((space) => space.id === id) ?? null);
  }

  subscribe(personalSpaceId, spaceId, mode = 'latest') {
    const existing = this.data.subscriptions.find(
      (subscription) =>
        subscription.personalSpaceId === personalSpaceId && subscription.spaceId === spaceId
    );
    if (existing) return cloneData(existing);

    const subscription = { personalSpaceId, spaceId, mode, createdAt: nowIso() };
    this.data.subscriptions.push(subscription);
    this.#save();
    return cloneData(subscription);
  }

  listSubscriptions() {
    return cloneData(this.data.subscriptions);
  }

  subscriptionsFor(personalSpaceId) {
    return cloneData(this.data.subscriptions.filter(
      (subscription) => subscription.personalSpaceId === personalSpaceId
    ));
  }

  addEpisode(spaceId, sourceKind, body, sourceUri = null, metadata = {}) {
    const episode = {
      id: randomUUID(),
      spaceId,
      sourceKind,
      body,
      sourceUri,
      metadata: cloneData(metadata),
      createdAt: nowIso()
    };
    this.data.episodes.push(episode);
    this.#episodeIndex.add(episode);
    this.#save();
    return cloneData(episode);
  }

  getEpisode(id) {
    return cloneData(this.#episodeIndex.get(id));
  }

  listEpisodes() {
    return cloneData(this.data.episodes);
  }

  episodeEvidencePreview(spaceId, episodeId, options = {}) {
    return cloneData(fileEpisodeEvidencePreview(
      this.#episodeIndex,
      spaceId,
      episodeId,
      options
    ));
  }

  correctionEpisodeEvidencePreviews(spaceId, factIds, options = {}) {
    return cloneData(fileCorrectionEpisodeEvidencePreviews(
      this.#episodeIndex,
      spaceId,
      factIds,
      options
    ));
  }

  addFact(fact) {
    if (fact.id && this.data.facts.some((item) => item.id === fact.id)) {
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
    this.data.facts.push(stored);
    this.#save();
    return cloneData(stored);
  }

  getFact(id) {
    return cloneData(this.data.facts.find((fact) => fact.id === id) ?? null);
  }

  updateFact(id, updates) {
    const fact = this.data.facts.find((item) => item.id === id);
    if (!fact) {
      throw new Error(`Fact not found: ${id}`);
    }

    const updated = { ...fact, ...updates, id };
    validateFactRecord(updated);
    Object.assign(fact, updated);
    this.#save();
    return cloneData(fact);
  }

  invalidateFact(factId, replacedByFactId = null) {
    const fact = this.data.facts.find((item) => item.id === factId);
    if (!fact || fact.invalidAt) return;

    fact.invalidAt = nowIso();
    fact.replacedByFactId = replacedByFactId;
    this.#save();
  }

  currentFacts(spaceId) {
    return cloneData(
      this.data.facts.filter((fact) => fact.spaceId === spaceId && isCurrentFact(fact))
    );
  }

  listFacts(options = {}) {
    const includeHistorical = options.includeHistorical ?? false;
    return cloneData(
      this.data.facts.filter((fact) => includeHistorical || isCurrentFact(fact))
    );
  }

  timeline(spaceId, subject) {
    return cloneData(this.data.facts
      .filter((fact) => fact.spaceId === spaceId && fact.subject === subject)
      .sort((left, right) => left.validAt.localeCompare(right.validAt)));
  }

  searchFacts(spaceIds, query, options = {}) {
    return cloneData(searchFileFacts(
      this.data.facts,
      this.#episodeIndex,
      spaceIds,
      query,
      options
    ));
  }

  searchFactsPage(spaceIds, query, options = {}) {
    return cloneData(searchFileFactsPage(
      this.data.facts,
      this.#episodeIndex,
      spaceIds,
      query,
      options
    ));
  }

  addCandidate(candidate) {
    if (candidate.id && this.data.candidates.some((item) => item.id === candidate.id)) {
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
    this.data.candidates.push(stored);
    this.#save();
    return cloneData(stored);
  }

  pendingCandidates(personalSpaceId) {
    return cloneData(this.data.candidates.filter(
      (candidate) =>
        candidate.personalSpaceId === personalSpaceId &&
        candidate.status === CandidateStatus.PENDING
    ));
  }

  getCandidate(id) {
    return cloneData(this.data.candidates.find((candidate) => candidate.id === id) ?? null);
  }

  listCandidates() {
    return cloneData(this.data.candidates);
  }

  updateCandidateStatus(id, status) {
    const candidate = this.data.candidates.find((item) => item.id === id);
    if (!candidate) {
      throw new Error(`Candidate not found: ${id}`);
    }

    const updated = {
      ...candidate,
      status,
      decidedAt: status === CandidateStatus.PENDING ? null : nowIso()
    };
    validateCandidateRecord(updated);
    Object.assign(candidate, updated);
    this.#save();
    return cloneData(candidate);
  }

  enqueueOutbox(entry) {
    if (entry.id && this.data.outbox.some((item) => item.id === entry.id)) {
      throw new Error(`Duplicate outbox id: ${entry.id}`);
    }

    const row = {
      id: entry.id || randomUUID(),
      kind: entry.kind,
      aggregateId: entry.aggregateId,
      payload: cloneData(entry.payload),
      status: entry.status ?? 'pending',
      attempts: entry.attempts ?? 0,
      nextAttemptAt: entry.nextAttemptAt ?? null,
      createdAt: entry.createdAt ?? nowIso(),
      sentAt: entry.sentAt ?? null,
      lastError: entry.lastError ?? null
    };
    validateOutboxRecord(row);
    this.data.outbox.push(row);
    this.#save();
    return cloneData(row);
  }

  listPendingOutbox(at = nowIso()) {
    return cloneData(this.data.outbox
      .filter(
        (row) =>
          row.status === 'pending' &&
          (row.nextAttemptAt === null || row.nextAttemptAt <= at)
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
  }

  markOutboxSent(id, sentAt = nowIso()) {
    const row = this.data.outbox.find((item) => item.id === id);
    if (!row) {
      throw new Error(`Outbox row not found: ${id}`);
    }

    row.status = 'sent';
    row.nextAttemptAt = null;
    row.sentAt = sentAt;
    row.lastError = null;
    this.#save();
    return cloneData(row);
  }

  markOutboxFailed(id, error, nextAttemptAt = null) {
    const row = this.data.outbox.find((item) => item.id === id);
    if (!row) {
      throw new Error(`Outbox row not found: ${id}`);
    }

    row.status = 'pending';
    row.attempts += 1;
    row.nextAttemptAt = nextAttemptAt;
    row.lastError = error;
    this.#save();
    return cloneData(row);
  }

  hasImport(contentHash) {
    return this.data.imports.some((record) => record.contentHash === contentHash);
  }

  recordImport(record) {
    if (this.hasImport(record.contentHash)) {
      throw new Error(`Duplicate import content hash: ${record.contentHash}`);
    }

    const stored = cloneData(record);
    this.data.imports.push(stored);
    this.#save();
    return cloneData(stored);
  }

  exportSnapshot() {
    return cloneData(this.data);
  }

  importSnapshot(snapshot) {
    this.data = normalizeSnapshot(snapshot, {
      outbox: this.data.outbox,
      imports: this.data.imports
    });
    this.#episodeIndex.rebuild(this.data.episodes);
    this.#save();
  }

  close() {}

  #load() {
    return normalizeSnapshot(readJsonFile(this.filePath, {}));
  }

  #save() {
    if (this.transactionActive) {
      this.transactionDirty = true;
      return;
    }

    try {
      this.#commit();
    } catch (error) {
      this.data = cloneData(this.#committedData);
      this.#episodeIndex.rebuild(this.data.episodes);
      throw error;
    }
  }

  #commit() {
    this.#persist();
    this.#committedData = cloneData(this.data);
  }

  #persist() {
    if (this.memoryOnly) return;
    writeJsonFileAtomic(this.filePath, this.data, this.jsonFileIo);
  }
}

function cloneData(data) {
  return JSON.parse(JSON.stringify(data));
}

function isThenable(value) {
  return value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof value.then === 'function';
}
