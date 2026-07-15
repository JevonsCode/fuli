import { CandidateStatus, FactStatus, SpaceKind } from '../models.js';
import {
  validateCandidateRecord,
  validateFactRecord,
  validateOutboxRecord
} from './record-validation.js';

export function validateLegacyRecords(snapshot) {
  requireUnique(snapshot.spaces, 'space', (record) => record.id);
  requireUnique(snapshot.spaces, 'space name', (record) => record.name);
  requireUnique(snapshot.episodes, 'episode', (record) => record.id);
  requireUnique(snapshot.facts, 'fact', (record) => record.id);
  requireUnique(snapshot.candidates, 'candidate', (record) => record.id);
  requireUnique(snapshot.outbox ?? [], 'outbox', (record) => record.id);
  requireUnique(snapshot.imports ?? [], 'import', (record) => record.contentHash);
  requireUnique(snapshot.subscriptions, 'subscription', subscriptionKey);
  for (const space of snapshot.spaces) validateSpace(space);
  for (const subscription of snapshot.subscriptions) validateSubscription(subscription);
  for (const episode of snapshot.episodes) validateEpisode(episode);
  for (const fact of snapshot.facts) validateFact(fact);
  for (const candidate of snapshot.candidates) validateCandidate(candidate);
  for (const entry of snapshot.outbox ?? []) validateOutbox(entry);
  for (const record of snapshot.imports ?? []) {
    requireStrings(record, 'import', ['contentHash', 'sourcePath', 'importedAt']);
  }
  validateReferences(snapshot);
}
function validateSpace(space) {
  requireStrings(space, 'space', ['id', 'name', 'kind']);
  if (!Object.values(SpaceKind).includes(space.kind)) {
    throw new TypeError(`Invalid space kind: ${space.kind}`);
  }
  nullableString(space, 'description');
  optionalString(space, 'createdAt');
}

function validateSubscription(subscription) {
  requireStrings(subscription, 'subscription', ['personalSpaceId', 'spaceId']);
  optionalString(subscription, 'mode');
  optionalString(subscription, 'createdAt');
}

function validateEpisode(episode) {
  requireStrings(episode, 'episode', ['id', 'spaceId', 'sourceKind', 'body']);
  nullableString(episode, 'sourceUri');
  optionalString(episode, 'createdAt');
}

function validateFact(fact) {
  requireStrings(fact, 'fact', ['id', 'spaceId', 'subject', 'predicate', 'object', 'sourceEpisodeId']);
  optionalString(fact, 'validAt');
  nullableString(fact, 'invalidAt');
  nullableString(fact, 'replacedByFactId');
  validateFactRecord({
    ...fact,
    status: fact.status ?? FactStatus.CONFIRMED,
    confidence: fact.confidence ?? 1,
    sensitivity: fact.sensitivity ?? 'normal',
    scope: fact.scope ?? 'personal'
  });
}

function validateCandidate(candidate) {
  requireStrings(candidate, 'candidate', ['id', 'personalSpaceId', 'episodeId', 'reason']);
  nullableString(candidate, 'targetSpaceId');
  optionalString(candidate, 'createdAt');
  nullableString(candidate, 'decidedAt');
  validateCandidateRecord({ ...candidate, status: candidate.status ?? CandidateStatus.PENDING });
}

function validateOutbox(entry) {
  requireStrings(entry, 'outbox', ['id', 'kind', 'aggregateId']);
  optionalString(entry, 'createdAt');
  nullableString(entry, 'nextAttemptAt');
  nullableString(entry, 'sentAt');
  nullableString(entry, 'lastError');
  validateOutboxRecord({ ...entry, status: entry.status ?? 'pending', attempts: entry.attempts ?? 0 });
}

function validateReferences(snapshot) {
  const spaces = ids(snapshot.spaces);
  const episodes = ids(snapshot.episodes);
  const facts = ids(snapshot.facts);
  for (const subscription of snapshot.subscriptions) {
    requireReference(spaces, subscription.personalSpaceId, 'Subscription references missing personal space');
    requireReference(spaces, subscription.spaceId, 'Subscription references missing space');
  }
  for (const episode of snapshot.episodes) {
    requireReference(spaces, episode.spaceId, `Episode ${episode.id} references missing space`);
  }
  for (const fact of snapshot.facts) {
    requireReference(spaces, fact.spaceId, `Fact ${fact.id} references missing space`);
    requireReference(episodes, fact.sourceEpisodeId, `Fact ${fact.id} references missing episode`);
    if (fact.replacedByFactId) {
      requireReference(facts, fact.replacedByFactId, `Fact ${fact.id} references missing replacement fact`);
    }
  }
  for (const candidate of snapshot.candidates) {
    requireReference(spaces, candidate.personalSpaceId, `Candidate ${candidate.id} references missing personal space`);
    if (candidate.targetSpaceId) {
      requireReference(spaces, candidate.targetSpaceId, `Candidate ${candidate.id} references missing target space`);
    }
    requireReference(episodes, candidate.episodeId, `Candidate ${candidate.id} references missing episode`);
  }
}

function requireUnique(records, label, identifier) {
  const seen = new Set();
  for (const record of records) {
    const value = identifier(record);
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} id must be a nonempty string`);
    if (seen.has(value)) {
      const suffix = label === 'subscription' || label.endsWith('name')
        ? `: ${value}`
        : ` id: ${value}`;
      throw new Error(`Duplicate ${label}${suffix}`);
    }
    seen.add(value);
  }
}

function requireStrings(record, label, fields) {
  for (const field of fields) {
    if (typeof record[field] !== 'string' || record[field].length === 0) {
      throw new TypeError(`${label} ${field} must be a nonempty string`);
    }
  }
}

function optionalString(record, field) {
  if (record[field] !== undefined && typeof record[field] !== 'string') {
    throw new TypeError(`${field} must be a string when provided`);
  }
}

function nullableString(record, field) {
  if (record[field] !== undefined && record[field] !== null && typeof record[field] !== 'string') {
    throw new TypeError(`${field} must be a string or null`);
  }
}

function subscriptionKey(record) {
  return `${record.personalSpaceId} -> ${record.spaceId}`;
}

function requireReference(validIds, id, message) {
  if (!validIds.has(id)) throw new Error(`${message}: ${id}`);
}

function ids(records) {
  return new Set(records.map((record) => record.id));
}
