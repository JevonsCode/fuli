import { FactScope, FactStatus, isCurrentFact } from '../models.js';
import { isRestrictedEpisode } from '../security/episode-visibility.js';
import { isRestrictedFact } from '../security/fact-visibility.js';

export function isInjectableFact(
  fact,
  { includeObserved, includeSuggested, includeRestricted }
) {
  if (fact.invalidAt) return false;
  if (fact.status === FactStatus.CONFIRMED) return isVisibleFact(fact, includeRestricted);
  if (fact.status === FactStatus.OBSERVED && includeObserved) {
    return isVisibleFact(fact, includeRestricted);
  }
  if (fact.status === FactStatus.SUGGESTED && includeSuggested) {
    return isVisibleFact(fact, includeRestricted);
  }
  return false;
}

export function isSearchableFact(fact, { includeHistorical, includeRestricted }) {
  return (includeHistorical || isCurrentFact(fact)) && isVisibleFact(fact, includeRestricted);
}

export function buildCorrectionIndex(groups, personalSpaceId, includeRestricted) {
  const index = new Map();
  for (const group of groups) {
    if (typeof group.factId !== 'string') continue;
    const episodes = group.episodes.filter((episode) =>
      episode.spaceId === personalSpaceId &&
      episode.metadata?.kind === 'lens_correction' &&
      episode.metadata?.factId === group.factId &&
      (includeRestricted || !isRestrictedEpisode(episode))
    );
    index.set(group.factId, {
      episodes,
      truncated: group.truncated === true || episodes.length < group.episodes.length
    });
  }
  return index;
}

export function projectSearchFact(
  store,
  fact,
  evidenceEpisode,
  personalSpaceId,
  correctionIndex,
  includeRestricted
) {
  const sourceEpisode = safePersonalEpisode(
    evidenceEpisode,
    personalSpaceId,
    includeRestricted
  );
  const replacement = fact.replacedByFactId ? store.getFact(fact.replacedByFactId) : null;
  const replacementFact = replacement?.spaceId === personalSpaceId &&
    replacement.scope === FactScope.PERSONAL &&
    isVisibleFact(replacement, includeRestricted)
    ? replacement
    : null;
  return {
    fact: projectSearchFactDto(fact, sourceEpisode, replacementFact),
    current: isCurrentFact(fact),
    sourceEpisode,
    replacementFact,
    correctionEpisodes: correctionIndex.get(fact.id)?.episodes ?? [],
    correctionEpisodesTruncated: correctionIndex.get(fact.id)?.truncated ?? false
  };
}

function projectSearchFactDto(fact, sourceEpisode, replacementFact) {
  return {
    ...fact,
    sourceEpisodeId: sourceEpisode?.id ?? null,
    replacedByFactId: replacementFact?.id ?? null
  };
}

function isVisibleFact(fact, includeRestricted) {
  return includeRestricted === true || !isRestrictedFact(fact);
}

export function safePersonalEpisode(episode, personalSpaceId, includeRestricted) {
  if (!episode || episode.spaceId !== personalSpaceId) return null;
  if (!includeRestricted && isRestrictedEpisode(episode)) return null;
  return episode;
}
