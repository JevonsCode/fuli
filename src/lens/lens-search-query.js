import { ApplicationError, ApplicationErrorCode } from '../app/application-error.js';
import { FactScope } from '../models.js';
import { MAX_EPISODE_EVIDENCE_BODY_BYTES } from '../storage/episode-evidence-preview.js';
import { assertStorePort } from '../storage/store-port.js';
import { requirePersonalSpace } from './lens-input.js';
import {
  buildCorrectionIndex,
  isSearchableFact,
  projectSearchFact
} from './lens-query-projection.js';

export const DEFAULT_SEARCH_USER_CONTEXT_LIMIT = 20;
export const MAX_SEARCH_USER_CONTEXT_LIMIT = 100;
const MAX_SEARCH_USER_CONTEXT_SCAN_LIMIT = 200;

export class LensSearchQuery {
  constructor(store) {
    assertStorePort(store);
    this.store = store;
  }

  searchUserContext({
    personalSpaceId,
    query,
    includeHistorical = false,
    includeRestricted = false,
    requireSafeSource = false,
    maxFactObjectBytes = null,
    maxEvidenceBodyBytes = MAX_EPISODE_EVIDENCE_BODY_BYTES,
    limit = DEFAULT_SEARCH_USER_CONTEXT_LIMIT,
    scanLimit = limit,
    factFilter = null
  }) {
    requirePersonalSpace(this.store, personalSpaceId);
    validateQuery(query);
    validateSearchLimit(limit);
    validateScanOptions(scanLimit, limit, factFilter);

    const allowRestricted = includeRestricted === true;
    const page = this.store.searchFactsPage([personalSpaceId], query, {
      includeHistorical,
      scope: FactScope.PERSONAL,
      excludeRestricted: !allowRestricted,
      safeSourceSpaceId: requireSafeSource === true ? personalSpaceId : null,
      maxObjectBytes: maxFactObjectBytes,
      limit: scanLimit + 1
    });
    const candidates = page.facts;
    const scanned = candidates.slice(0, scanLimit);
    const facts = scanned
      .filter((fact) => fact.spaceId === personalSpaceId && fact.scope === FactScope.PERSONAL)
      .filter((fact) => isSearchableFact(fact, {
        includeHistorical,
        includeRestricted: allowRestricted
      }))
      .filter((fact) => factFilter?.(fact) ?? true);
    const selected = facts.slice(0, limit);
    const correctionIndex = buildCorrectionIndex(
      this.store.correctionEpisodeEvidencePreviews(
        personalSpaceId,
        selected.map((fact) => fact.id),
        { includeRestricted: allowRestricted, maxBodyBytes: maxEvidenceBodyBytes }
      ),
      personalSpaceId,
      allowRestricted
    );
    return {
      personalSpaceId,
      query,
      truncated: page.objectLimitTruncated ||
        candidates.length > scanLimit ||
        facts.length > limit ||
        facts.length < scanned.length,
      facts: selected.map((fact) => {
        const source = this.store.episodeEvidencePreview(
          personalSpaceId,
          fact.sourceEpisodeId,
          { includeRestricted: allowRestricted, maxBodyBytes: maxEvidenceBodyBytes }
        );
        return projectSearchFact(
          this.store,
          fact,
          source,
          personalSpaceId,
          correctionIndex,
          allowRestricted
        );
      })
    };
  }
}

function validateScanOptions(scanLimit, limit, factFilter) {
  if (
    !Number.isInteger(scanLimit) ||
    scanLimit < limit ||
    scanLimit > MAX_SEARCH_USER_CONTEXT_SCAN_LIMIT
  ) {
    throw new ApplicationError(
      ApplicationErrorCode.VALIDATION,
      `Scan limit must be an integer between the result limit and ${MAX_SEARCH_USER_CONTEXT_SCAN_LIMIT}`
    );
  }
  if (factFilter !== null && typeof factFilter !== 'function') {
    throw new ApplicationError(ApplicationErrorCode.VALIDATION, 'Fact filter must be a function');
  }
}

function validateQuery(query) {
  if (typeof query !== 'string') {
    throw new ApplicationError(ApplicationErrorCode.VALIDATION, 'Query must be a string');
  }
}

function validateSearchLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_USER_CONTEXT_LIMIT) {
    throw new ApplicationError(
      ApplicationErrorCode.VALIDATION,
      `Limit must be an integer between 1 and ${MAX_SEARCH_USER_CONTEXT_LIMIT}`
    );
  }
}
