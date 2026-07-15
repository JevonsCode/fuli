import { isRestrictedEpisode } from '../../security/episode-visibility.js';

export class FileEpisodeIndex {
  #byId = new Map();
  #correctionsBySpace = new Map();
  #safeCorrectionsBySpace = new Map();

  constructor(episodes) {
    this.rebuild(episodes);
  }

  rebuild(episodes) {
    this.#byId = new Map();
    this.#correctionsBySpace = new Map();
    this.#safeCorrectionsBySpace = new Map();
    for (const episode of episodes) this.add(episode);
  }

  add(episode) {
    this.#byId.set(episode.id, episode);
    const factId = episode.metadata?.kind === 'lens_correction'
      ? episode.metadata.factId
      : null;
    if (typeof factId !== 'string') return;

    addCorrection(this.#correctionsBySpace, episode, factId);
    if (!isRestrictedEpisode(episode)) {
      addCorrection(this.#safeCorrectionsBySpace, episode, factId);
    }
  }

  get(id) {
    return this.#byId.get(id) ?? null;
  }

  correctionWindows(spaceId, factIds, { includeRestricted, limit }) {
    const index = includeRestricted
      ? this.#correctionsBySpace
      : this.#safeCorrectionsBySpace;
    const byFact = index.get(spaceId) ?? new Map();
    return [...new Set(factIds)].map((factId) => {
      const episodes = byFact.get(factId) ?? [];
      return {
        factId,
        episodes: episodes.slice(Math.max(0, episodes.length - limit)).reverse(),
        truncated: episodes.length > limit
      };
    });
  }
}

function addCorrection(index, episode, factId) {
  const byFact = index.get(episode.spaceId) ?? new Map();
  const episodes = byFact.get(factId) ?? [];
  episodes.push(episode);
  episodes.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  byFact.set(factId, episodes);
  index.set(episode.spaceId, byFact);
}
