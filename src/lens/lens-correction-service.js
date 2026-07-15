import { nowIso, FactScope, FactStatus, isCurrentFact } from '../models.js';
import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { assertStorePort } from '../storage/store-port.js';
import { writePersonalFact } from './lens-fact-writer.js';
import { assertSafeLensTexts, requirePersonalSpace } from './lens-input.js';

const ACTIONS = new Set(['replace', 'reject', 'deprecate']);
const CORRECTABLE_STATUSES = new Set([
  FactStatus.CONFIRMED,
  FactStatus.OBSERVED,
  FactStatus.SUGGESTED
]);
const IMMEDIATE = { mode: 'immediate' };

export class LensCorrectionService {
  constructor(store) {
    assertStorePort(store);
    this.store = store;
  }

  correctUserFact({ personalSpaceId, factId, action, value, sourceText, sourceKind = 'correction' }) {
    if (!ACTIONS.has(action)) {
      throw new ApplicationError(ApplicationErrorCode.VALIDATION, `Unknown correction action: ${action}`);
    }

    requirePersonalSpace(this.store, personalSpaceId);
    assertSafeLensTexts([sourceText]);
    if (action === 'replace') assertSafeLensTexts([value]);

    const original = this.#requireCurrentFact(personalSpaceId, factId);
    if (action === 'replace') assertSafeLensTexts([original.subject, original.predicate]);

    return this.store.transaction(() => {
      requirePersonalSpace(this.store, personalSpaceId);
      const current = this.#requireCurrentFact(personalSpaceId, factId);
      assertSafeLensTexts([sourceText]);
      if (action === 'replace') assertSafeLensTexts([current.subject, current.predicate, value]);

      const episode = this.store.addEpisode(
        personalSpaceId,
        sourceKind,
        sourceText,
        null,
        { kind: 'lens_correction', factId: current.id, action }
      );

      if (action === 'replace') {
        const fact = writePersonalFact(this.store, {
          spaceId: personalSpaceId,
          subject: current.subject,
          predicate: current.predicate,
          object: value,
          sourceEpisodeId: episode.id,
          status: FactStatus.CONFIRMED,
          sensitivity: current.sensitivity,
          confidence: current.confidence,
          scope: FactScope.PERSONAL
        });
        this.store.invalidateFact(current.id, fact.id);
        return { episode, fact, replacedFact: this.store.getFact(current.id) };
      }

      const fact = this.store.updateFact(current.id, {
        status: action === 'reject' ? FactStatus.REJECTED : FactStatus.DEPRECATED,
        invalidAt: nowIso()
      });
      return { episode, fact };
    }, IMMEDIATE);
  }

  #requireCurrentFact(personalSpaceId, factId) {
    const fact = this.store.getFact(factId);
    if (!fact || fact.spaceId !== personalSpaceId || fact.scope !== FactScope.PERSONAL) {
      throw new ApplicationError(ApplicationErrorCode.NOT_FOUND, `Lens fact not found: ${factId}`);
    }
    if (!isCurrentFact(fact) || !CORRECTABLE_STATUSES.has(fact.status)) {
      throw new ApplicationError(ApplicationErrorCode.VALIDATION, `Lens fact is not current: ${factId}`);
    }
    return fact;
  }
}
