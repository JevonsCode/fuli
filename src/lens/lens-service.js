import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { FactScope, FactStatus, Sensitivity } from '../models.js';
import { assertSafeSourceMetadata } from '../security/source-metadata-policy.js';
import { assertStorePort } from '../storage/store-port.js';
import { writePersonalFact, writePersonalFactSpecs } from './lens-fact-writer.js';
import { assertSafeLensTexts, requirePersonalSpace, validateLensWriteInput } from './lens-input.js';
import { LensCorrectionService } from './lens-correction-service.js';
const OBSERVATION_INFERENCES = new Set(['direct', 'inferred']);
const IMMEDIATE = { mode: 'immediate' };
const SOURCE_METADATA_ERROR = 'Sensitive source metadata is not allowed in Personal Lens';

export class LensService {
  #corrections;

  constructor(store) {
    assertStorePort(store);
    this.store = store;
    this.#corrections = new LensCorrectionService(store);
  }
  rememberUserFact({
    personalSpaceId,
    subject = 'user',
    predicate,
    value,
    sourceText,
    sourceKind = 'conversation',
    sensitivity = Sensitivity.NORMAL,
    confidence = 1
  }) {
    assertSafeSourceMetadata(sourceKind, null, SOURCE_METADATA_ERROR);
    this.#validate(personalSpaceId, [subject, predicate, value, sourceText], sensitivity, confidence);
    return this.store.transaction(() => {
      const episode = this.store.addEpisode(personalSpaceId, sourceKind, sourceText);
      const fact = this.#writeFact({
        personalSpaceId, subject, predicate, value, episode,
        status: FactStatus.CONFIRMED, sensitivity, confidence
      });
      return { episode, fact };
    }, IMMEDIATE);
  }
  rememberUserFactsFromSourceInCurrentTransaction({
    personalSpaceId,
    subject = 'user',
    specs,
    sourceText,
    sourceKind,
    sourceUri = null,
    sensitivity = Sensitivity.NORMAL,
    confidence = 1
  }) {
    assertSafeSourceMetadata(sourceKind, sourceUri, SOURCE_METADATA_ERROR);
    const specTexts = specs.flatMap(specTextsForValidation);
    this.#validate(
      personalSpaceId,
      [subject, sourceText, ...specTexts],
      sensitivity,
      confidence
    );
    const episode = this.store.addEpisode(personalSpaceId, sourceKind, sourceText, sourceUri);
    const facts = writePersonalFactSpecs(this.store, {
      spaceId: personalSpaceId,
      subject,
      specs,
      sourceEpisodeId: episode.id,
      sensitivity,
      confidence
    });
    return { episode, facts };
  }
  writeUserFactsForEpisodeInCurrentTransaction({
    personalSpaceId,
    subject = 'user',
    specs,
    episode,
    sensitivity = Sensitivity.NORMAL,
    confidence = 1
  }) {
    assertSafeSourceMetadata(episode?.sourceKind, episode?.sourceUri, SOURCE_METADATA_ERROR);
    if (episode.spaceId !== personalSpaceId) {
      throw new ApplicationError(ApplicationErrorCode.VALIDATION, 'Lens source episode belongs to another space');
    }
    this.#validate(
      personalSpaceId,
      [subject, episode.body, ...specs.flatMap(specTextsForValidation)],
      sensitivity,
      confidence
    );
    const facts = writePersonalFactSpecs(this.store, {
      spaceId: personalSpaceId,
      subject,
      specs,
      sourceEpisodeId: episode.id,
      sensitivity,
      confidence
    });
    return { episode, facts };
  }
  submitUserObservation({
    personalSpaceId,
    subject = 'user',
    predicate,
    value,
    evidenceText,
    inference,
    sourceKind = 'observation',
    sensitivity = Sensitivity.NORMAL,
    confidence = inference === 'inferred' ? 0.5 : 1
  }) {
    assertSafeSourceMetadata(sourceKind, null, SOURCE_METADATA_ERROR);
    this.#validate(personalSpaceId, [subject, predicate, value, evidenceText], sensitivity, confidence);
    if (!OBSERVATION_INFERENCES.has(inference)) {
      throw new ApplicationError(
        ApplicationErrorCode.VALIDATION,
        'Observation inference must be direct or inferred'
      );
    }
    return this.store.transaction(() => {
      const episode = this.store.addEpisode(personalSpaceId, sourceKind, evidenceText);
      const fact = this.#writeFact({
        personalSpaceId, subject, predicate, value, episode,
        status: inference === 'inferred' ? FactStatus.SUGGESTED : FactStatus.OBSERVED,
        sensitivity, confidence
      });
      return { episode, fact };
    }, IMMEDIATE);
  }
  confirmObservation({ personalSpaceId, factId, sourceText, sourceKind = 'confirmation' }) {
    assertSafeSourceMetadata(sourceKind, null, SOURCE_METADATA_ERROR);
    requirePersonalSpace(this.store, personalSpaceId);
    assertSafeLensTexts([sourceText]);
    return this.store.transaction(() => {
      const original = this.#findConfirmableFact(personalSpaceId, factId);
      assertSafeLensTexts([original.subject, original.predicate, original.object]);
      const episode = this.store.addEpisode(personalSpaceId, sourceKind, sourceText);
      const fact = this.#writeFact({
        personalSpaceId,
        subject: original.subject,
        predicate: original.predicate,
        value: original.object,
        episode,
        status: FactStatus.CONFIRMED,
        sensitivity: original.sensitivity,
        confidence: original.confidence
      });
      return { episode, fact, replacedFact: original };
    }, IMMEDIATE);
  }
  correctUserFact(input) {
    assertSafeSourceMetadata(input.sourceKind, null, SOURCE_METADATA_ERROR);
    return this.#corrections.correctUserFact(input);
  }

  #writeFact(input) {
    return writePersonalFact(this.store, {
      spaceId: input.personalSpaceId,
      subject: input.subject,
      predicate: input.predicate,
      object: input.value,
      sourceEpisodeId: input.episode.id,
      status: input.status,
      sensitivity: input.sensitivity,
      confidence: input.confidence
    });
  }
  #validate(personalSpaceId, texts, sensitivity, confidence) {
    validateLensWriteInput(this.store, { personalSpaceId, texts, sensitivity, confidence });
  }

  #findConfirmableFact(personalSpaceId, factId) {
    const fact = this.store.getFact(factId);
    if (!fact || fact.spaceId !== personalSpaceId || fact.scope !== FactScope.PERSONAL) {
      throw new ApplicationError(ApplicationErrorCode.NOT_FOUND, `Observation not found: ${factId}`);
    }
    if (fact.invalidAt || ![FactStatus.OBSERVED, FactStatus.SUGGESTED].includes(fact.status)) {
      throw new ApplicationError(ApplicationErrorCode.VALIDATION, `Observation cannot be confirmed: ${factId}`);
    }
    return fact;
  }
}
function specTextsForValidation(spec) {
  return [spec.subject, spec.predicate, spec.object, spec.oldValue, spec.newValue]
    .filter(value => value !== undefined);
}
