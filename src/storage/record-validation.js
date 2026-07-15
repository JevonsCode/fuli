import { CandidateStatus, FactScope, FactStatus, Sensitivity } from '../models.js';

const FACT_STATUSES = new Set(Object.values(FactStatus));
const CANDIDATE_STATUSES = new Set(Object.values(CandidateStatus));
const SENSITIVITIES = new Set(Object.values(Sensitivity));
const SCOPES = new Set(Object.values(FactScope));
const OUTBOX_STATUSES = new Set(['pending', 'sent']);

export function validateFactRecord(fact) {
  requireMember('fact status', fact.status, FACT_STATUSES);
  if (
    typeof fact.confidence !== 'number' ||
    !Number.isFinite(fact.confidence) ||
    fact.confidence < 0 ||
    fact.confidence > 1
  ) {
    throw new TypeError('Fact confidence must be between 0 and 1');
  }
  requireMember('fact sensitivity', fact.sensitivity, SENSITIVITIES);
  requireMember('fact scope', fact.scope, SCOPES);
  return fact;
}

export function validateCandidateRecord(candidate) {
  requireMember('candidate status', candidate.status, CANDIDATE_STATUSES);
  return candidate;
}

export function validateOutboxRecord(entry) {
  requireMember('outbox status', entry.status, OUTBOX_STATUSES);
  if (!Number.isInteger(entry.attempts) || entry.attempts < 0) {
    throw new TypeError('Outbox attempts must be a nonnegative integer');
  }
  return entry;
}

export function validateSnapshotRecords(snapshot) {
  for (const fact of snapshot.facts) validateFactRecord(fact);
  for (const candidate of snapshot.candidates) validateCandidateRecord(candidate);
  for (const entry of snapshot.outbox) validateOutboxRecord(entry);
  return snapshot;
}

function requireMember(label, value, allowed) {
  if (!allowed.has(value)) throw new TypeError(`Invalid ${label}: ${value}`);
}
