import { FactScope, FactStatus } from '../models.js';

const STATUS_RANK = Object.freeze({
  [FactStatus.SUGGESTED]: 1,
  [FactStatus.OBSERVED]: 2,
  [FactStatus.CONFIRMED]: 3
});

export function writePersonalFact(store, input) {
  const equivalent = equivalentCurrentFacts(store, input);
  const fact = store.addFact({
    spaceId: input.spaceId,
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    sourceEpisodeId: input.sourceEpisodeId,
    status: input.status,
    confidence: input.confidence,
    sensitivity: input.sensitivity,
    scope: FactScope.PERSONAL
  });
  const candidates = [...equivalent, fact];
  const winner = candidates.reduce(strongerOrLater);
  for (const candidate of candidates) {
    if (candidate.id !== winner.id) store.invalidateFact(candidate.id, winner.id);
  }
  return store.getFact(fact.id);
}

export function writePersonalFactSpecs(store, input) {
  const facts = [];
  for (const spec of input.specs) {
    if (spec.kind === 'replacement') {
      facts.push(...writeReplacement(store, input, spec));
      continue;
    }
    facts.push(writePersonalFact(store, {
      ...input,
      subject: spec.subject ?? input.subject,
      predicate: spec.predicate,
      object: spec.object,
      status: FactStatus.CONFIRMED
    }));
  }
  return facts;
}

function writeReplacement(store, input, spec) {
  const subject = spec.subject ?? input.subject;
  const oldFacts = store.currentFacts(input.spaceId).filter(
    (fact) => fact.subject === subject && fact.object === spec.oldValue
  );
  const predicates = oldFacts.length
    ? [...new Set(oldFacts.map((fact) => fact.predicate))]
    : ['has_replacement'];
  return predicates.map((predicate) => {
    const fact = writePersonalFact(store, {
      ...input,
      subject,
      predicate,
      object: spec.newValue,
      status: FactStatus.CONFIRMED
    });
    for (const previous of oldFacts.filter((item) => item.predicate === predicate)) {
      store.invalidateFact(previous.id, fact.id);
    }
    return fact;
  });
}

function equivalentCurrentFacts(store, input) {
  return store.currentFacts(input.spaceId).filter((fact) =>
    fact.subject === input.subject &&
    fact.predicate === input.predicate &&
    fact.object === input.object
  );
}

function strongerOrLater(current, candidate) {
  return rank(candidate.status) >= rank(current.status) ? candidate : current;
}

function rank(status) {
  return STATUS_RANK[status] ?? 0;
}
