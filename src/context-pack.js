import { isCurrentFact } from './models.js';
import { listCandidates } from './candidates.js';
import { getProjectRules } from './project-rules.js';
import { getFactHistory } from './fact-history.js';

export function buildContextPack(store, { personalSpaceId, spaceId, query = '' }) {
  const personalSpace = store.getSpace(personalSpaceId);
  const space = store.getSpace(spaceId);
  const scopedSpaceIds = [...new Set([personalSpaceId, spaceId])];
  const matches = store
    .searchFacts(scopedSpaceIds, query, { includeHistorical: false })
    .map((fact) => compactMatch(store, fact));
  const histories = buildHistories(store, matches);
  const rules = compactRules(getProjectRules(store, spaceId), store);
  const candidates = listCandidates(store, personalSpaceId)
    .filter((candidate) => !candidate.targetSpaceId || candidate.targetSpaceId === spaceId)
    .map(compactCandidate);

  return {
    query,
    personalSpace: compactSpace(personalSpace, personalSpaceId),
    space: compactSpace(space, spaceId),
    rules,
    matches,
    histories,
    candidateCount: candidates.length,
    candidates,
    answer: formatPackAnswer(matches)
  };
}

export function formatContextPack(pack) {
  const lines = [
    `Context ${pack.personalSpace.name} -> ${pack.space.name}`,
    `Query ${pack.query || '(empty)'}`,
    'Rules',
    ...formatRules(pack.rules),
    'Matches',
    ...formatMatches(pack.matches),
    ...formatHistories(pack.histories),
    `Candidates ${pack.candidateCount}`
  ];

  return lines.join('\n');
}

function compactRules(rules, store) {
  return {
    spaceId: rules.spaceId,
    spaceName: rules.spaceName,
    forbidden: rules.forbidden.map((fact) => compactFact(store, fact)),
    parameters: rules.parameters.map((fact) => compactFact(store, fact)),
    links: rules.links.map((fact) => compactFact(store, fact))
  };
}

function compactFact(store, fact) {
  return {
    id: fact.id,
    spaceId: fact.spaceId,
    spaceName: store.getSpace(fact.spaceId)?.name ?? fact.spaceId,
    subject: fact.subject,
    predicate: fact.predicate,
    object: fact.object,
    current: isCurrentFact(fact),
    validAt: fact.validAt,
    invalidAt: fact.invalidAt,
    source: compactSource(store, fact.sourceEpisodeId)
  };
}

function compactMatch(store, fact) {
  const compact = compactFact(store, fact);
  return {
    spaceId: compact.spaceId,
    spaceName: compact.spaceName,
    current: compact.current,
    fact: {
      id: compact.id,
      spaceId: compact.spaceId,
      subject: compact.subject,
      predicate: compact.predicate,
      object: compact.object,
      validAt: compact.validAt,
      invalidAt: compact.invalidAt
    },
    source: compact.source
  };
}

function buildHistories(store, matches) {
  const keys = new Set();
  const histories = [];

  for (const match of matches) {
    const key = `${match.fact.spaceId}:${match.fact.predicate}`;
    if (keys.has(key)) continue;
    keys.add(key);

    const history = getFactHistory(store, {
      spaceId: match.fact.spaceId,
      predicate: match.fact.predicate
    });
    if (history.facts.length <= 1) continue;

    histories.push({
      spaceId: history.spaceId,
      spaceName: history.spaceName,
      predicate: history.predicate,
      facts: history.facts.map((fact) => compactFact(store, fact))
    });
  }

  return histories;
}

function compactCandidate(candidate) {
  return {
    id: candidate.id,
    reason: candidate.reason,
    createdAt: candidate.createdAt,
    targetSpaceId: candidate.targetSpaceId,
    targetSpaceName: candidate.targetSpaceName,
    source: candidate.episode
      ? {
          id: candidate.episode.id,
          kind: candidate.episode.sourceKind,
          uri: candidate.episode.sourceUri,
          createdAt: candidate.episode.createdAt,
          preview: firstLine(candidate.episode.body)
        }
      : null
  };
}

function compactSource(store, episodeId) {
  const episode = store.getEpisode(episodeId);
  if (!episode) return null;

  return {
    id: episode.id,
    kind: episode.sourceKind,
    uri: episode.sourceUri,
    createdAt: episode.createdAt,
    preview: firstLine(episode.body)
  };
}

function compactSpace(space, fallbackId) {
  return {
    id: space?.id ?? fallbackId,
    name: space?.name ?? fallbackId,
    kind: space?.kind ?? null
  };
}

function firstLine(value) {
  return String(value).split(/\r?\n/)[0].slice(0, 160);
}

function formatPackAnswer(matches) {
  if (matches.length === 0) {
    return 'No matching current facts found.';
  }

  return matches
    .map((match) => `${match.fact.subject} ${match.fact.predicate} ${match.fact.object}`)
    .join('\n');
}

function formatRules(rules) {
  const lines = [
    ...rules.forbidden.map((fact) => `forbids ${fact.object}`),
    ...rules.parameters.map((fact) => `${humanPredicate(fact.predicate)} ${fact.object}`),
    ...rules.links.map((fact) => `url ${fact.object}`)
  ];

  return lines.length ? lines : ['(none)'];
}

function formatMatches(matches) {
  return matches.length
    ? matches.map(
        (match) =>
          `${match.spaceName} ${humanPredicate(match.fact.predicate)} ${match.fact.object}`
      )
    : ['(none)'];
}

function formatHistories(histories) {
  if (!histories?.length) return [];

  return [
    'History',
    ...histories.flatMap((history) =>
      history.facts.map(
        (fact) =>
          `${fact.current ? 'current' : 'historical'} ${humanPredicate(history.predicate)} ${fact.object}`
      )
    )
  ];
}

function humanPredicate(predicate) {
  return predicate.startsWith('has_') ? predicate.slice(4) : predicate;
}
