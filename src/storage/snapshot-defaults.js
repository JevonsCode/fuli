import { CandidateStatus, FactStatus, nowIso } from '../models.js';
import { validateSnapshotRecords } from './record-validation.js';

export function normalizeSnapshot(snapshot = {}, { outbox = [], imports = [] } = {}) {
  const input = cloneSnapshot(snapshot);
  const normalized = {
    spaces: (input.spaces ?? []).map((space) => ({
      ...space,
      description: space.description ?? null,
      createdAt: space.createdAt ?? nowIso()
    })),
    subscriptions: (input.subscriptions ?? []).map((subscription) => ({
      ...subscription,
      mode: subscription.mode ?? 'latest',
      createdAt: subscription.createdAt ?? nowIso()
    })),
    episodes: (input.episodes ?? []).map((episode) => ({
      ...episode,
      sourceUri: episode.sourceUri ?? null,
      metadata: episode.metadata ?? {},
      createdAt: episode.createdAt ?? nowIso()
    })),
    facts: (input.facts ?? []).map((fact) => ({
      ...fact,
      status: fact.status ?? FactStatus.CONFIRMED,
      confidence: fact.confidence ?? 1,
      sensitivity: fact.sensitivity ?? 'normal',
      scope: fact.scope ?? 'personal',
      validAt: fact.validAt ?? nowIso(),
      invalidAt: fact.invalidAt ?? null,
      replacedByFactId: fact.replacedByFactId ?? null
    })),
    candidates: (input.candidates ?? []).map(normalizeCandidate),
    outbox: Object.hasOwn(input, 'outbox') ? input.outbox : cloneSnapshot(outbox),
    imports: Object.hasOwn(input, 'imports') ? input.imports : cloneSnapshot(imports)
  };
  return validateSnapshotRecords(normalized);
}

export function cloneSnapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeCandidate(candidate) {
  const status = candidate.status ?? CandidateStatus.PENDING;
  const createdAt = candidate.createdAt ?? nowIso();
  return {
    ...candidate,
    targetSpaceId: candidate.targetSpaceId ?? null,
    status,
    createdAt,
    decidedAt: candidate.decidedAt ?? (status === CandidateStatus.PENDING ? null : createdAt)
  };
}
