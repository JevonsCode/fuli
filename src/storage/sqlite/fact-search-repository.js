import { isRestrictedFact } from '../../security/fact-visibility.js';
import { searchTextSortKey } from '../fact-search-order.js';
import { sqliteEpisodeRestrictedSql } from './episode-privacy-sql.js';
import { mapFact } from './mapper.js';

export class FactSearchRepository {
  constructor(db) {
    this.db = db;
    this.statements = new Map();
    this.omissionStatements = new Map();
    registerSearchFunctions(db);
  }

  search(spaceIds, query, {
    includeHistorical = false,
    scope = null,
    limit = null,
    excludeRestricted = false,
    safeSourceSpaceId = null,
    maxObjectBytes = null
  } = {}) {
    return this.searchPage(spaceIds, query, {
      includeHistorical,
      scope,
      limit,
      excludeRestricted,
      safeSourceSpaceId,
      maxObjectBytes
    }).facts;
  }

  searchPage(spaceIds, query, options = {}) {
    const {
      includeHistorical = false,
      scope = null,
      limit = null,
      excludeRestricted = false,
      safeSourceSpaceId = null,
      maxObjectBytes = null
    } = options;
    if (spaceIds.length === 0) return { facts: [], objectLimitTruncated: false };
    if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
      throw new TypeError('Fact search limit must be a positive integer');
    }

    const shape = {
      spaceCount: spaceIds.length,
      includeHistorical,
      scoped: scope !== null,
      limited: limit !== null,
      excludeRestricted: excludeRestricted === true,
      safeSourceRequired: safeSourceSpaceId !== null,
      objectBytesBounded: maxObjectBytes !== null
    };
    const parameters = [...spaceIds];
    if (scope !== null) parameters.push(scope);
    if (safeSourceSpaceId !== null) parameters.push(safeSourceSpaceId);
    if (maxObjectBytes !== null) parameters.push(maxObjectBytes);
    parameters.push(query.toLowerCase());
    const factParameters = limit === null ? parameters : [...parameters, limit];
    const facts = this.#statement(shape).all(...factParameters).map(mapFact);
    const objectLimitTruncated = maxObjectBytes === null
      ? false
      : this.#omissionStatement(shape).pluck().get(...parameters) === 1;
    return { facts, objectLimitTruncated };
  }

  #statement(shape) {
    const key = Object.values(shape).join(':');
    if (!this.statements.has(key)) {
      this.statements.set(key, this.db.prepare(buildSearchQuery(shape)));
    }
    return this.statements.get(key);
  }

  #omissionStatement(shape) {
    const key = Object.values(shape).join(':');
    if (!this.omissionStatements.has(key)) {
      this.omissionStatements.set(key, this.db.prepare(buildOmissionQuery(shape)));
    }
    return this.omissionStatements.get(key);
  }
}

function buildOmissionQuery(shape) {
  return `SELECT EXISTS (
    SELECT 1 FROM facts
    WHERE ${buildWhereClause(shape, { oversized: true })}
    LIMIT 1
  )`;
}

function registerSearchFunctions(db) {
  db.function('fact_search_text_sort_key', { deterministic: true }, searchTextSortKey);
  db.function('fact_search_is_restricted', { deterministic: true },
    (subject, predicate, object, sensitivity) => Number(isRestrictedFact({
      subject, predicate, object, sensitivity
    })));
}

function buildSearchQuery({
  spaceCount,
  includeHistorical,
  scoped,
  limited,
  excludeRestricted,
  safeSourceRequired,
  objectBytesBounded
}) {
  const shape = {
    spaceCount,
    includeHistorical,
    scoped,
    excludeRestricted,
    safeSourceRequired,
    objectBytesBounded
  };
  const orderClause = limited
    ? 'ORDER BY valid_at DESC, fact_search_text_sort_key(id) ASC LIMIT ?'
    : 'ORDER BY rowid';
  return `
    SELECT * FROM facts
    WHERE ${buildWhereClause(shape)}
    ${orderClause}
  `;
}

function buildWhereClause({
  spaceCount,
  includeHistorical,
  scoped,
  excludeRestricted,
  safeSourceRequired,
  objectBytesBounded
}, { oversized = false } = {}) {
  const placeholders = Array.from({ length: spaceCount }, () => '?').join(', ');
  const currentClause = includeHistorical
    ? ''
    : "AND invalid_at IS NULL AND status NOT IN ('rejected', 'deprecated')";
  const scopeClause = scoped ? 'AND scope = ?' : '';
  const restrictedClause = excludeRestricted
    ? `AND fact_search_is_restricted(
      subject, predicate, object, sensitivity
    ) = 0`
    : '';
  const sourceClause = safeSourceRequired ? `AND EXISTS (
    SELECT 1 FROM episodes source
    WHERE source.id = source_episode_id
      AND source.space_id = ?
      AND NOT ${sqliteEpisodeRestrictedSql('source')}
  )` : '';
  const objectBytesClause = objectBytesBounded
    ? `AND length(CAST(object AS BLOB)) ${oversized ? '>' : '<='} ?`
    : '';
  return `space_id IN (${placeholders})
      ${currentClause}
      ${scopeClause}
      ${restrictedClause}
      ${sourceClause}
      ${objectBytesClause}
      AND instr(lower(subject || ' ' || predicate || ' ' || object), ?) > 0`;
}
