import { SpaceKind } from '../models.js';
import { isSafeAgentText } from './public-read-policy.js';
import { requirePersonalSpace } from './space-boundary.js';

export class AgentCandidateReadService {
  constructor(store) {
    this.store = store;
  }

  list(personalSpaceId) {
    requirePersonalSpace(this.store, personalSpaceId);
    return this.store.pendingCandidates(personalSpaceId)
      .map((candidate) => this.#project(candidate, personalSpaceId));
  }

  listForSpace(personalSpaceId, spaceId) {
    return this.list(personalSpaceId)
      .filter((candidate) => !candidate.targetSpaceId || candidate.targetSpaceId === spaceId);
  }

  #project(candidate, personalSpaceId) {
    const resolvedTarget = candidate.targetSpaceId
      ? this.store.getSpace(candidate.targetSpaceId)
      : null;
    const target = resolvedTarget?.kind === SpaceKind.PUBLIC ? resolvedTarget : null;
    return {
      id: candidate.id,
      reason: isSafeAgentText(candidate.reason) ? candidate.reason : null,
      status: candidate.status,
      createdAt: candidate.createdAt,
      targetSpaceId: target?.id ?? null,
      targetSpaceName: target?.name ?? null,
      source: this.#source(candidate.episodeId, personalSpaceId)
    };
  }

  #source(episodeId, personalSpaceId) {
    const episode = this.store.getEpisode(episodeId);
    if (!episode || episode.spaceId !== personalSpaceId) return null;
    if (![
      episode.sourceKind,
      episode.sourceUri,
      episode.body,
      JSON.stringify(episode.metadata)
    ].every(isSafeAgentText)) return null;
    return {
      id: episode.id,
      kind: episode.sourceKind,
      uri: episode.sourceUri,
      createdAt: episode.createdAt
    };
  }
}
