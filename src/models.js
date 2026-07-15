export const SpaceKind = Object.freeze({
  PERSONAL: 'personal',
  PUBLIC: 'public'
});

export const CandidateStatus = Object.freeze({
  PENDING: 'pending',
  SYNCED: 'synced',
  PERSONAL_ONLY: 'personal_only',
  IGNORED: 'ignored'
});

export const FactStatus = Object.freeze({
  CONFIRMED: 'confirmed',
  OBSERVED: 'observed',
  SUGGESTED: 'suggested',
  REJECTED: 'rejected',
  DEPRECATED: 'deprecated'
});

export const Sensitivity = Object.freeze({
  NORMAL: 'normal',
  PRIVATE: 'private',
  RESTRICTED: 'restricted'
});

export const FactScope = Object.freeze({
  PERSONAL: 'personal',
  PUBLIC: 'public'
});

export const PublishRoute = Object.freeze({
  PERSONAL: 'personal',
  PUBLIC: 'public',
  CANDIDATE: 'candidate'
});

export function nowIso() {
  return new Date().toISOString();
}

export function isCurrentFact(fact) {
  return !fact.invalidAt && ![FactStatus.REJECTED, FactStatus.DEPRECATED].includes(fact.status);
}
