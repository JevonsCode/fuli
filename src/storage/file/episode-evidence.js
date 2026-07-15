import { isRestrictedEpisode } from '../../security/episode-visibility.js';
import {
  normalizeCorrectionEvidencePreviewOptions,
  normalizeEvidencePreviewOptions,
  previewEpisode
} from '../episode-evidence-preview.js';

export function fileEpisodeEvidencePreview(index, spaceId, episodeId, options = {}) {
  const normalized = normalizeEvidencePreviewOptions(options);
  const episode = index.get(episodeId);
  if (!isVisibleEpisode(episode, spaceId, normalized.includeRestricted)) return null;
  return previewEpisode(episode, normalized);
}

export function fileCorrectionEpisodeEvidencePreviews(
  index,
  spaceId,
  factIds,
  options = {}
) {
  const normalized = normalizeCorrectionEvidencePreviewOptions(options);
  return index.correctionWindows(spaceId, factIds, {
    includeRestricted: normalized.includeRestricted,
    limit: normalized.maxCorrectionsPerFact
  }).map((group) => ({
    factId: group.factId,
    episodes: group.episodes.map(
      (episode) => previewEpisode(episode, normalized, { correction: true })
    ),
    truncated: group.truncated
  }));
}

function isVisibleEpisode(episode, spaceId, includeRestricted) {
  return episode?.spaceId === spaceId &&
    (includeRestricted || !isRestrictedEpisode(episode));
}
