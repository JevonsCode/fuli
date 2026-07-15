import { FactStatus } from '../models.js';
import { compactHistoryFact, compactMatch } from './read-projection.js';
import { requirePersonalSpace, requirePublicSpace } from './space-boundary.js';

export class AgentContextPackService {
  constructor(store, publicReads, search, candidateReads) {
    this.store = store;
    this.publicReads = publicReads;
    this.search = search;
    this.candidateReads = candidateReads;
  }

  build({ personalSpaceId, spaceId, query = '' }) {
    const personal = requirePersonalSpace(this.store, personalSpaceId);
    const project = requirePublicSpace(this.store, spaceId);
    const personalMatches = this.search
      .personalMatches({ personalSpaceId, query, includeHistorical: false }, personal.name)
      .filter(({ fact }) => [FactStatus.CONFIRMED, FactStatus.OBSERVED].includes(fact.status));
    const publicMatches = this.search.publicMatches([spaceId], query);
    const matches = [...personalMatches, ...publicMatches].map(compactMatch);
    const candidates = this.candidateReads.listForSpace(personalSpaceId, spaceId);
    return {
      query,
      personalSpace: compactSpace(personal),
      space: compactSpace(project),
      rules: this.#rules(spaceId),
      matches,
      histories: this.#histories(publicMatches),
      candidateCount: candidates.length,
      candidates,
      answer: formatAnswer(matches)
    };
  }

  #rules(spaceId) {
    const rules = this.publicReads.projectRules(spaceId);
    const compact = (fact) => compactHistoryFact(this.store, {
      ...fact,
      current: true
    });
    return {
      spaceId: rules.spaceId,
      spaceName: rules.spaceName,
      forbidden: rules.forbidden.map(compact),
      parameters: rules.parameters.map(compact),
      links: rules.links.map(compact)
    };
  }

  #histories(matches) {
    const seen = new Set();
    const histories = [];
    for (const match of matches) {
      const key = `${match.fact.spaceId}:${match.fact.predicate}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const history = this.publicReads.factHistory({
        spaceId: match.fact.spaceId,
        predicate: match.fact.predicate
      });
      if (history.facts.length <= 1) continue;
      histories.push({
        spaceId: history.spaceId,
        spaceName: history.spaceName,
        predicate: history.predicate,
        facts: history.facts.map((fact) => compactHistoryFact(this.store, fact))
      });
    }
    return histories;
  }

}

function compactSpace(space) {
  return { id: space.id, name: space.name, kind: space.kind };
}

function formatAnswer(matches) {
  if (!matches.length) return 'No matching current facts found.';
  return matches
    .map(({ fact }) => `${fact.subject} ${fact.predicate} ${fact.object}`)
    .join('\n');
}
