import { getFactHistory } from '../fact-history.js';
import { FactScope } from '../models.js';
import { getProjectRules } from '../project-rules.js';
import { projectPublicMatch } from './read-projection.js';
import { requirePublicSpace } from './space-boundary.js';

export class AgentPublicReadService {
  constructor(store) {
    this.store = store;
  }

  currentFacts(spaceId) {
    requirePublicSpace(this.store, spaceId);
    return this.#publicFacts(this.store.currentFacts(spaceId));
  }

  timeline(spaceId, subject) {
    requirePublicSpace(this.store, spaceId);
    return this.#publicFacts(this.store.timeline(spaceId, subject));
  }

  projectRules(spaceId) {
    requirePublicSpace(this.store, spaceId);
    const rules = getProjectRules(this.store, spaceId);
    const facts = rules.facts
      .filter((fact) => fact.scope === FactScope.PUBLIC)
      .map((fact) => this.#enrich(fact))
      .filter(Boolean);
    return {
      spaceId: rules.spaceId,
      spaceName: rules.spaceName,
      forbidden: facts.filter((fact) => fact.predicate === 'forbids'),
      parameters: facts.filter(isProjectParameter),
      links: facts.filter((fact) => fact.predicate === 'has_url'),
      facts
    };
  }

  factHistory(input) {
    requirePublicSpace(this.store, input.spaceId);
    const history = getFactHistory(this.store, input);
    return {
      ...history,
      facts: history.facts
        .filter((fact) => fact.scope === FactScope.PUBLIC)
        .map((fact) => {
          const enriched = this.#enrich(fact);
          return enriched ? { ...enriched, current: fact.current } : null;
        })
        .filter(Boolean)
    };
  }

  #publicFacts(facts) {
    return facts
      .filter((fact) => fact.scope === FactScope.PUBLIC)
      .map((fact) => projectPublicMatch(this.store, fact)?.fact)
      .filter(Boolean);
  }

  #enrich(fact) {
    const match = projectPublicMatch(this.store, fact);
    return match ? { ...match.fact, source: match.source } : null;
  }
}

function isProjectParameter(fact) {
  return fact.predicate.startsWith('has_') && fact.predicate !== 'has_url';
}
