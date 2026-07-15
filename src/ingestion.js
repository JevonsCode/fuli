import { classifyEpisode } from './classifier.js';
import { extractFactSpecs } from './extractor.js';
import { FactService } from './facts/fact-service.js';
import { LensService } from './lens/lens-service.js';
import { ApplicationError, ApplicationErrorCode } from './app/application-error.js';
import { CandidateStatus, FactScope, PublishRoute, SpaceKind } from './models.js';
import { detectSensitiveContent } from './security/sensitive-content.js';
import { assertSafeSourceMetadata } from './security/source-metadata-policy.js';
import { PublicationService } from './publication/publication-service.js';

export class IngestionService {
  constructor(store, {
    facts = new FactService(store),
    lens = new LensService(store),
    publication = new PublicationService(store)
  } = {}) {
    this.store = store;
    this.facts = facts;
    this.lens = lens;
    this.publication = publication;
  }

  remember(input) {
    this.#assertSafeInput(input);
    return this.store.transaction(
      () => this.rememberInCurrentTransaction(input),
      { mode: 'immediate' }
    );
  }

  rememberInCurrentTransaction({
    personalSpaceId,
    sourceKind,
    body,
    targetSpaceId = null,
    sourceUri = null
  }) {
    this.#assertSafeInput({ body, sourceKind, sourceUri });
    const route = classifyEpisode({ sourceKind, body });

    if (route === PublishRoute.PERSONAL) {
      const result = this.lens.rememberUserFactsFromSourceInCurrentTransaction({
        personalSpaceId,
        subject: this.#spaceName(personalSpaceId),
        specs: extractFactSpecs(this.#spaceName(personalSpaceId), body),
        sourceText: body,
        sourceKind,
        sourceUri
      });
      return { route, ...result };
    }

    const personalEpisode = this.store.addEpisode(personalSpaceId, sourceKind, body, sourceUri);

    if (route === PublishRoute.PUBLIC && targetSpaceId) {
      const targetEpisode = this.store.addEpisode(targetSpaceId, sourceKind, body, sourceUri);
      const facts = this.facts.writeSpecs({
        spaceId: targetSpaceId,
        subject: this.#spaceName(targetSpaceId),
        episodeId: targetEpisode.id,
        specs: extractFactSpecs(this.#spaceName(targetSpaceId), body),
        scope: FactScope.PUBLIC
      });
      const publication = facts.length === 0
        ? null
        : this.publication.prepareInCurrentTransaction({
          spaceId: targetSpaceId,
          episode: targetEpisode,
          facts
        });
      return { route, episode: targetEpisode, publication };
    }

    const candidate = this.store.addCandidate({
      personalSpaceId,
      targetSpaceId,
      episodeId: personalEpisode.id,
      reason: 'not safe enough to publish automatically',
      status: CandidateStatus.PENDING
    });
    return { route: PublishRoute.CANDIDATE, episode: personalEpisode, candidate };
  }

  publishConfirmed(input) {
    this.#assertSafeInput(input);
    return this.store.transaction(
      () => this.publishConfirmedInCurrentTransaction(input),
      { mode: 'immediate' }
    );
  }

  publishConfirmedInCurrentTransaction({ targetSpaceId, sourceKind, body, sourceUri = null }) {
    this.#assertSafeInput({ body, sourceKind, sourceUri });
    const targetEpisode = this.store.addEpisode(targetSpaceId, sourceKind, body, sourceUri);
    const result = this.confirmEpisodeInCurrentTransaction({
      spaceId: targetSpaceId,
      episode: targetEpisode
    });
    return result;
  }

  confirmEpisode(input) {
    this.#assertSafeEpisode(input.episode);
    return this.store.transaction(
      () => this.confirmEpisodeInCurrentTransaction(input),
      { mode: 'immediate' }
    );
  }

  confirmEpisodeInCurrentTransaction({ spaceId, episode }) {
    this.#assertSafeEpisode(episode);
    const subject = this.#spaceName(spaceId);
    const specs = extractFactSpecs(subject, episode.body);
    if (this.store.getSpace(spaceId)?.kind === SpaceKind.PERSONAL) {
      return this.lens.writeUserFactsForEpisodeInCurrentTransaction({
        personalSpaceId: spaceId,
        subject,
        specs,
        episode
      });
    }
    const facts = this.facts.writeSpecs({
      spaceId,
      subject,
      episodeId: episode.id,
      specs,
      scope: FactScope.PUBLIC
    });
    const publication = facts.length === 0
      ? null
      : this.publication.prepareInCurrentTransaction({ spaceId, episode, facts });
    return { episode, publication };
  }

  #spaceName(spaceId) {
    return this.store.getSpace(spaceId)?.name ?? spaceId;
  }

  #assertSafeInput({ body, sourceKind, sourceUri }) {
    this.#assertSafeBody(body);
    assertSafeSourceMetadata(
      sourceKind,
      sourceUri,
      'Sensitive source metadata is not allowed in ingestion'
    );
  }

  #assertSafeEpisode(episode) {
    this.#assertSafeInput(episode);
  }

  #assertSafeBody(body) {
    if (detectSensitiveContent(body).restricted) {
      throw new ApplicationError(
        ApplicationErrorCode.VALIDATION,
        'Sensitive content is not allowed in ingestion'
      );
    }
  }

}
