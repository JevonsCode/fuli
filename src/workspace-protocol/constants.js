export const WORKSPACE_PROTOCOL_VERSION = '1';

export const ProviderCapability = Object.freeze({
  QUERY: 'query',
  SYNC: 'sync',
  PUBLISH: 'publish',
  REVIEW: 'review',
});

export const WorkspaceVisibility = Object.freeze({
  PUBLIC: 'public',
  UNLISTED: 'unlisted',
  PRIVATE: 'private',
});

export const WorkspaceRole = Object.freeze({
  MEMBER: 'member',
  MAINTAINER: 'maintainer',
});

export const ProposalStatus = Object.freeze({
  EFFECTIVE: 'effective',
  PENDING_REVIEW: 'pending_review',
  REJECTED: 'rejected',
});

export const FactState = Object.freeze({
  ACTIVE: 'active',
  SUPERSEDED: 'superseded',
  RETRACTED: 'retracted',
  DISPUTED: 'disputed',
});

export const FactCertainty = Object.freeze({
  CONFIRMED: 'confirmed',
  KNOWN_UNKNOWN: 'known_unknown',
});
