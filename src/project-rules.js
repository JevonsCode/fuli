export function getProjectRules(store, spaceId) {
  const facts = store.currentFacts(spaceId).map((fact) => enrichFact(store, fact));

  return {
    spaceId,
    spaceName: store.getSpace(spaceId)?.name ?? spaceId,
    forbidden: facts.filter((fact) => fact.predicate === 'forbids'),
    parameters: facts.filter(isProjectParameter),
    links: facts.filter((fact) => fact.predicate === 'has_url'),
    facts
  };
}

function enrichFact(store, fact) {
  const episode = store.getEpisode(fact.sourceEpisodeId);

  return {
    ...fact,
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

function isProjectParameter(fact) {
  return fact.predicate.startsWith('has_') && fact.predicate !== 'has_url';
}
