import { enrichCandidate } from '../candidates.js';

export class StateService {
  constructor(store) {
    this.store = store;
  }

  build() {
    const spaces = this.store.listSpaces();
    const currentFacts = spaces.flatMap((space) =>
      this.store.currentFacts(space.id).map((fact) => this.#enrichFact(fact))
    );
    const historicalFacts = this.store
      .listFacts({ includeHistorical: true })
      .filter((fact) => fact.invalidAt)
      .map((fact) => this.#enrichFact(fact));
    const candidates = this.store.listCandidates().map((candidate) =>
      enrichCandidate(this.store, candidate)
    );

    return {
      spaces,
      subscriptions: this.store.listSubscriptions(),
      episodes: this.store.listEpisodes(),
      currentFacts,
      historicalFacts,
      candidates
    };
  }

  #enrichFact(fact) {
    return {
      ...fact,
      spaceName: this.store.getSpace(fact.spaceId)?.name ?? fact.spaceId,
      episode: this.store.getEpisode(fact.sourceEpisodeId)
    };
  }
}
