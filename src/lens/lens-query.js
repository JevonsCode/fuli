import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { FactScope } from '../models.js';
import { requirePersonalSpace } from './lens-input.js';
import {
  BOUNDARY_PREDICATES,
  BOUNDARY_PREFIXES,
  compareLensFacts,
  taskTokens
} from './lens-query-ranking.js';
import {
  isInjectableFact,
  projectSearchFact,
  safePersonalEpisode
} from './lens-query-projection.js';
import { LensSearchQuery } from './lens-search-query.js';

export { BOUNDARY_PREDICATES, BOUNDARY_PREFIXES };
export {
  DEFAULT_SEARCH_USER_CONTEXT_LIMIT,
  MAX_SEARCH_USER_CONTEXT_LIMIT
} from './lens-search-query.js';

export class LensQuery extends LensSearchQuery {
  getUserLens(input) {
    return this.#getUserLens(input, true);
  }

  #getUserLens({
    personalSpaceId,
    task,
    budget,
    includeObserved = true,
    includeSuggested = false,
    includeRestricted = false
  }, redactRelations) {
    requirePersonalSpace(this.store, personalSpaceId);
    validateTask(task);
    validateBudget(budget);

    const terms = taskTokens(task);
    const allowRestricted = includeRestricted === true;
    const facts = this.store.currentFacts(personalSpaceId)
      .filter((fact) => fact.spaceId === personalSpaceId && fact.scope === FactScope.PERSONAL)
      .filter((fact) => isInjectableFact(fact, {
        includeObserved,
        includeSuggested,
        includeRestricted: allowRestricted
      }))
      .sort((left, right) => compareLensFacts(left, right, terms));
    const selected = [];
    const lines = [];
    let bytes = 0;

    for (const fact of facts) {
      const line = formatFactLine(fact);
      const nextBytes = bytes + (lines.length ? 1 : 0) + Buffer.byteLength(line, 'utf8');
      if (nextBytes > budget) continue;
      selected.push(fact);
      lines.push(line);
      bytes = nextBytes;
    }

    return {
      personalSpaceId,
      task,
      text: lines.join('\n'),
      facts: redactRelations
        ? selected.map((fact) => {
          const source = this.store.episodeEvidencePreview(
            personalSpaceId,
            fact.sourceEpisodeId,
            { includeRestricted: allowRestricted, maxBodyBytes: 0 }
          );
          return projectSearchFact(
            this.store,
            fact,
            source,
            personalSpaceId,
            new Map(),
            allowRestricted
          ).fact;
        })
        : selected,
      estimatedTokens: bytes,
      truncated: selected.length < facts.length
    };
  }

  getUserLensView(input) {
    return this.store.transaction(() => {
      const lens = this.#getUserLens(input, false);
      const entries = [];
      for (const fact of lens.facts) {
        const source = safePersonalEpisode(
          this.store.episodeEvidencePreview(
            lens.personalSpaceId,
            fact.sourceEpisodeId,
            { includeRestricted: input.includeRestricted === true, maxBodyBytes: 0 }
          ),
          lens.personalSpaceId,
          input.includeRestricted === true
        );
        if (source) entries.push(projectLensViewEntry(fact, source));
      }
      return {
        entries,
        truncated: lens.truncated || entries.length < lens.facts.length
      };
    });
  }

}

function validateTask(task) {
  if (typeof task !== 'string') {
    throw new ApplicationError(ApplicationErrorCode.VALIDATION, 'Task must be a string');
  }
}

function validateBudget(budget) {
  if (!Number.isInteger(budget) || budget <= 0) {
    throw new ApplicationError(ApplicationErrorCode.VALIDATION, 'Budget must be a positive integer');
  }
}

function formatFactLine(fact) {
  return `${fact.subject} ${fact.predicate} ${fact.object} (${fact.status})`;
}

function projectLensViewEntry(fact, source) {
  return {
    subject: fact.subject,
    predicate: fact.predicate,
    object: fact.object,
    status: fact.status,
    validAt: fact.validAt,
    source: {
      kind: source.sourceKind,
      uri: source.sourceUri,
      createdAt: source.createdAt
    }
  };
}
