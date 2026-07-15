import { isCurrentFact } from '../models.js';
import {
  getAgentReadablePublicSource,
  getAgentReadableReplacementId,
  isAgentReadablePublicFact
} from './public-read-policy.js';

export function projectPersonalMatch(item, spaceName) {
  return {
    spaceId: item.fact.spaceId,
    spaceName,
    current: item.current,
    fact: item.fact,
    source: projectEpisode(item.sourceEpisode)
  };
}

export function projectPublicMatch(store, fact) {
  if (!isAgentReadablePublicFact(store, fact)) return null;
  const source = projectEpisode(getAgentReadablePublicSource(store, fact));
  return {
    spaceId: fact.spaceId,
    spaceName: store.getSpace(fact.spaceId)?.name ?? fact.spaceId,
    current: isCurrentFact(fact),
    fact: projectPublicFact(store, fact, source),
    source
  };
}

export function compactMatch(match) {
  return {
    spaceId: match.spaceId,
    spaceName: match.spaceName,
    current: match.current,
    fact: {
      id: match.fact.id,
      spaceId: match.fact.spaceId,
      subject: match.fact.subject,
      predicate: match.fact.predicate,
      object: match.fact.object,
      status: match.fact.status,
      validAt: match.fact.validAt,
      invalidAt: match.fact.invalidAt
    },
    source: compactSource(match.source)
  };
}

export function compactHistoryFact(store, fact) {
  return {
    id: fact.id,
    spaceId: fact.spaceId,
    spaceName: store.getSpace(fact.spaceId)?.name ?? fact.spaceId,
    subject: fact.subject,
    predicate: fact.predicate,
    object: fact.object,
    status: fact.status,
    current: fact.current,
    validAt: fact.validAt,
    invalidAt: fact.invalidAt,
    source: compactSource(fact.source)
  };
}

export function compactSource(source) {
  if (!source) return null;
  return {
    id: source.id,
    kind: source.kind ?? source.sourceKind,
    uri: source.uri ?? source.sourceUri,
    createdAt: source.createdAt,
    preview: firstLine(source.body)
  };
}

function projectPublicFact(store, fact, source) {
  return {
    id: fact.id,
    spaceId: fact.spaceId,
    subject: fact.subject,
    predicate: fact.predicate,
    object: fact.object,
    sourceEpisodeId: source?.id ?? null,
    validAt: fact.validAt,
    invalidAt: fact.invalidAt,
    replacedByFactId: getAgentReadableReplacementId(store, fact),
    confidence: fact.confidence,
    sensitivity: fact.sensitivity,
    scope: fact.scope,
    status: fact.status
  };
}

function projectEpisode(episode) {
  if (!episode) return null;
  return {
    id: episode.id,
    kind: episode.sourceKind,
    uri: episode.sourceUri,
    body: episode.body,
    createdAt: episode.createdAt
  };
}

function firstLine(value) {
  return value === undefined ? undefined : String(value).split(/\r?\n/)[0].slice(0, 160);
}
