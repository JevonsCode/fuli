import { FactScope } from '../models.js';
import { projectPersonalMatch, projectPublicMatch } from './read-projection.js';
import { requirePersonalSpace } from './space-boundary.js';

export class AgentSearchService {
  constructor(store, lensQuery) {
    this.store = store;
    this.lensQuery = lensQuery;
  }

  search({ personalSpaceId, query, includeHistorical = false }) {
    const personal = requirePersonalSpace(this.store, personalSpaceId);
    const publicSpaceIds = this.#subscribedPublicSpaceIds(personalSpaceId);
    const matches = [
      ...this.personalMatches({ personalSpaceId, query, includeHistorical }, personal.name),
      ...this.publicMatches(publicSpaceIds, query, includeHistorical)
    ];
    const facts = matches.map((match) => match.fact);
    return {
      query,
      spaceIds: [personalSpaceId, ...publicSpaceIds],
      matches,
      facts,
      answer: formatAnswer(facts)
    };
  }

  personalMatches(input, spaceName) {
    const personal = spaceName ?? requirePersonalSpace(this.store, input.personalSpaceId).name;
    return this.lensQuery.searchUserContext({
      ...input,
      includeRestricted: false
    }).facts.map((item) => projectPersonalMatch(item, personal));
  }

  publicMatches(spaceIds, query, includeHistorical = false) {
    if (!spaceIds.length) return [];
    return this.store.searchFacts(spaceIds, query, { includeHistorical })
      .filter((fact) => fact.scope === FactScope.PUBLIC)
      .map((fact) => projectPublicMatch(this.store, fact))
      .filter(Boolean);
  }

  #subscribedPublicSpaceIds(personalSpaceId) {
    return this.store.subscriptionsFor(personalSpaceId)
      .map((subscription) => this.store.getSpace(subscription.spaceId))
      .filter((space) => space?.kind === 'public')
      .map((space) => space.id);
  }
}

function formatAnswer(facts) {
  if (!facts.length) return '没有找到相关当前事实';
  return facts
    .map((fact) => `${fact.subject}：${humanPredicate(fact.predicate)} 是 ${fact.object}`)
    .join('\n');
}

function humanPredicate(predicate) {
  return predicate.startsWith('has_') ? predicate.slice(4) : predicate;
}
