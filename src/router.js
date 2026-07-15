import { isCurrentFact } from './models.js';

export class ContextRouter {
  constructor(store) {
    this.store = store;
  }

  searchContext({ personalSpaceId, query, includeHistorical = false }) {
    const spaceIds = [
      personalSpaceId,
      ...this.store.subscriptionsFor(personalSpaceId).map((subscription) => subscription.spaceId)
    ];
    const facts = this.store.searchFacts(spaceIds, query, { includeHistorical });
    const matches = facts.map((fact) => buildMatch(this.store, fact));

    return {
      query,
      spaceIds,
      matches,
      facts,
      answer: formatAnswer(facts)
    };
  }
}

function buildMatch(store, fact) {
  const episode = store.getEpisode(fact.sourceEpisodeId);

  return {
    spaceId: fact.spaceId,
    spaceName: store.getSpace(fact.spaceId)?.name ?? fact.spaceId,
    current: isCurrentFact(fact),
    fact,
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

function formatAnswer(facts) {
  if (facts.length === 0) {
    return '没有找到相关当前事实';
  }

  return facts
    .map((fact) => `${fact.subject}：${humanPredicate(fact.predicate)} 是 ${fact.object}`)
    .join('\n');
}

function humanPredicate(predicate) {
  return predicate.startsWith('has_') ? predicate.slice(4) : predicate;
}
