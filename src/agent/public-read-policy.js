import { FactScope, FactStatus, Sensitivity } from '../models.js';
import { detectSensitiveContent } from '../security/sensitive-content.js';

export function isAgentReadablePublicFact(store, fact) {
  return fact?.scope === FactScope.PUBLIC &&
    fact.status === FactStatus.CONFIRMED &&
    fact.sensitivity === Sensitivity.NORMAL &&
    [fact.subject, fact.predicate, fact.object].every(isSafeText) &&
    getAgentReadablePublicSource(store, fact) !== null;
}

export function getAgentReadablePublicSource(store, fact) {
  const episode = fact ? store.getEpisode(fact.sourceEpisodeId) : null;
  if (!episode || episode.spaceId !== fact.spaceId) return null;
  if (![
    episode.sourceKind,
    episode.sourceUri,
    episode.body,
    JSON.stringify(episode.metadata)
  ].every(isSafeText)) return null;
  return episode;
}

export function getAgentReadableReplacementId(store, fact) {
  if (!fact.replacedByFactId) return null;
  const replacement = store.getFact(fact.replacedByFactId);
  return replacement?.spaceId === fact.spaceId && isAgentReadablePublicFact(store, replacement)
    ? replacement.id
    : null;
}

export function isSafeAgentText(value) {
  return isSafeText(value);
}

function isSafeText(value) {
  return value === null || value === undefined ||
    !detectSensitiveContent(String(value)).restricted;
}
