import { IngestionService } from './ingestion.js';
import { ApplicationError, ApplicationErrorCode } from './app/application-error.js';
import { CandidateStatus } from './models.js';

export function listCandidates(store, personalSpaceId) {
  return store.pendingCandidates(personalSpaceId).map((candidate) => enrichCandidate(store, candidate));
}

export function decideCandidate(store, candidateId, decision, { ingestion = new IngestionService(store) } = {}) {
  return store.transaction(
    () => decideCandidateInCurrentTransaction(store, candidateId, decision, ingestion),
    { mode: 'immediate' }
  );
}

function decideCandidateInCurrentTransaction(store, candidateId, decision, ingestion) {
  const candidate = store.getCandidate(candidateId);
  if (!candidate) {
    throw new Error(`Candidate not found: ${candidateId}`);
  }
  if (candidate.status !== CandidateStatus.PENDING) {
    throw new ApplicationError(
      ApplicationErrorCode.VALIDATION,
      `Candidate already decided: ${candidateId}`
    );
  }

  if (decision === 'sync') {
    if (!candidate.targetSpaceId) {
      throw new ApplicationError(
        ApplicationErrorCode.VALIDATION,
        'Syncing a candidate requires a target space'
      );
    }
    const episode = episodeFor(store, candidate);
    if (episode) {
      ingestion.publishConfirmedInCurrentTransaction({
        targetSpaceId: candidate.targetSpaceId,
        sourceKind: episode.sourceKind,
        body: episode.body,
        sourceUri: episode.sourceUri
      });
    }
    return store.updateCandidateStatus(candidate.id, CandidateStatus.SYNCED);
  }

  if (decision === 'personal_only') {
    const episode = episodeFor(store, candidate);
    if (episode) {
      ingestion.confirmEpisodeInCurrentTransaction({
        spaceId: candidate.personalSpaceId,
        episode
      });
    }
    return store.updateCandidateStatus(candidate.id, CandidateStatus.PERSONAL_ONLY);
  }

  if (decision === 'ignore') {
    return store.updateCandidateStatus(candidate.id, CandidateStatus.IGNORED);
  }

  throw new Error(`Unknown candidate decision: ${decision}`);
}

export function enrichCandidate(store, candidate) {
  return {
    ...candidate,
    personalSpaceName: store.getSpace(candidate.personalSpaceId)?.name ?? candidate.personalSpaceId,
    targetSpaceName: candidate.targetSpaceId
      ? store.getSpace(candidate.targetSpaceId)?.name ?? candidate.targetSpaceId
      : null,
    episode: episodeFor(store, candidate)
  };
}

function episodeFor(store, candidate) {
  return store.getEpisode(candidate.episodeId);
}
