import { detectSensitiveContent } from '../security/sensitive-content.js';

export function projectCurrentFact(fact) {
  return compactFact(fact);
}

export function isSafeResourceFact(fact) {
  return compactFact(fact) !== null;
}

export function projectHistoryItem(item) {
  const fact = compactFact(item.fact);
  if (!fact) return null;
  return {
    current: item.current,
    fact,
    source: compactEpisode(item.sourceEpisode),
    replacementFact: compactFact(item.replacementFact),
    correctionEpisodes: item.correctionEpisodes.map(compactCorrection).filter(Boolean)
  };
}

export function projectSubscription(subscription, space) {
  if (![
    space?.id,
    space?.name,
    space?.kind,
    subscription?.mode,
    subscription?.createdAt
  ].every(isSafeResourceText)) return null;
  const compactSpace = { id: space.id, name: space.name, kind: space.kind };
  if (isSafeResourceText(space.description)) {
    compactSpace.description = space.description;
  }
  return {
    space: compactSpace,
    mode: subscription.mode,
    createdAt: subscription.createdAt
  };
}

function compactFact(fact) {
  if (!fact || ![
    fact.id,
    fact.subject,
    fact.predicate,
    fact.object,
    fact.status,
    fact.validAt
  ].every(isSafeResourceText)) return null;
  if (!Number.isFinite(fact.confidence) || fact.confidence < 0 || fact.confidence > 1) {
    return null;
  }
  return {
    id: fact.id,
    subject: fact.subject,
    predicate: fact.predicate,
    object: fact.object,
    status: fact.status,
    confidence: fact.confidence,
    validAt: fact.validAt
  };
}

function compactEpisode(episode) {
  if (!episode) return null;
  if (![
    episode.id,
    episode.sourceKind,
    episode.createdAt
  ].every(isSafeResourceText)) return null;
  if (!isSafeResourceText(episode.sourceUri, { nullable: true })) return null;
  return {
    id: episode.id,
    kind: episode.sourceKind,
    uri: episode.sourceUri,
    createdAt: episode.createdAt
  };
}

function compactCorrection(episode) {
  const compact = compactEpisode(episode);
  if (!compact || !isSafeResourceText(episode.metadata?.action)) return null;
  return {
    ...compact,
    action: episode.metadata.action
  };
}

export function isSafeResourceText(value, { nullable = false } = {}) {
  if (value === null || value === undefined) return nullable;
  return typeof value === 'string' && !detectSensitiveContent(value).restricted;
}
