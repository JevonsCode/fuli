import { isCurrentFact } from './models.js';

export function getFactHistory(store, { spaceId, predicate }) {
  const normalizedPredicate = normalizePredicate(predicate);
  const facts = store.listFacts({ includeHistorical: true })
    .filter((fact) => fact.spaceId === spaceId && fact.predicate === normalizedPredicate)
    .sort((left, right) => left.validAt.localeCompare(right.validAt))
    .map((fact) => enrichFact(store, fact));

  return {
    spaceId,
    spaceName: store.getSpace(spaceId)?.name ?? spaceId,
    predicate: normalizedPredicate,
    facts
  };
}

export function normalizePredicate(value) {
  if (value.startsWith('has_') || value === 'forbids') return value;
  return `has_${value}`;
}

function enrichFact(store, fact) {
  const episode = store.getEpisode(fact.sourceEpisodeId);

  return {
    ...fact,
    current: isCurrentFact(fact),
    source: episode
      ? {
          id: episode.id,
          kind: episode.sourceKind,
          uri: episode.sourceUri,
          body: episode.body,
          createdAt: episode.createdAt
        }
      : null
  };
}
