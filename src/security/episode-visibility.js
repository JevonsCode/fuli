import { detectSensitiveContent } from './sensitive-content.js';

export function isRestrictedEpisode(episode) {
  return [
    episode.sourceKind,
    episode.body,
    episode.sourceUri,
    JSON.stringify(episode.metadata)
  ].some(hasSensitiveContent);
}

function hasSensitiveContent(text) {
  return detectSensitiveContent(text).restricted;
}
