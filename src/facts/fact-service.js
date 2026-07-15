import { FactScope, FactStatus } from '../models.js';

export class FactService {
  constructor(store) {
    this.store = store;
  }

  writeSpecs({ spaceId, subject, episodeId, specs, scope = FactScope.PERSONAL }) {
    const written = [];
    for (const spec of specs) {
      if (spec.kind === 'replacement') {
        written.push(...this.#replaceFact({ spaceId, subject, episodeId, spec, scope }));
        continue;
      }

      if (this.#hasCurrentFact(spaceId, subject, spec.predicate, spec.object)) continue;

      const supersededFacts = this.#supersededCurrentFacts(
        spaceId,
        subject,
        spec.predicate,
        spec.object
      );
      const newFact = this.store.addFact({
        spaceId,
        subject,
        predicate: spec.predicate,
        object: spec.object,
        sourceEpisodeId: episodeId,
        status: FactStatus.CONFIRMED,
        scope
      });
      written.push(newFact);

      for (const oldFact of supersededFacts) {
        this.store.invalidateFact(oldFact.id, newFact.id);
      }
    }
    return written;
  }

  #hasCurrentFact(spaceId, subject, predicate, object) {
    return this.store.currentFacts(spaceId).some(
      (fact) =>
        fact.subject === subject &&
        fact.predicate === predicate &&
        fact.object === object
    );
  }

  #supersededCurrentFacts(spaceId, subject, predicate, object) {
    if (!isUniqueParameterPredicate(predicate)) return [];

    return this.store.currentFacts(spaceId).filter(
      (fact) =>
        fact.subject === subject &&
        fact.predicate === predicate &&
        fact.object !== object
    );
  }

  #replaceFact({ spaceId, subject, episodeId, spec, scope }) {
    const oldFacts = this.store.currentFacts(spaceId).filter(
      (fact) => fact.subject === subject && fact.object === spec.oldValue
    );
    const predicates = oldFacts.length
      ? [...new Set(oldFacts.map((fact) => fact.predicate))]
      : ['has_replacement'];
    const newFacts = predicates.map((predicate) => this.store.addFact({
      spaceId,
      subject,
      predicate,
      object: spec.newValue,
      sourceEpisodeId: episodeId,
      status: FactStatus.CONFIRMED,
      scope
    }));

    for (const oldFact of oldFacts) {
      const replacement = newFacts.find((fact) => fact.predicate === oldFact.predicate) ?? newFacts[0];
      this.store.invalidateFact(oldFact.id, replacement.id);
    }
    return newFacts;
  }
}

function isUniqueParameterPredicate(predicate) {
  return predicate.startsWith('has_') && predicate !== 'has_url';
}
