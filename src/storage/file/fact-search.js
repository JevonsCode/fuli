import { isCurrentFact } from '../../models.js';
import { isRestrictedEpisode } from '../../security/episode-visibility.js';
import { isRestrictedFact } from '../../security/fact-visibility.js';
import { compareSearchFacts } from '../fact-search-order.js';

export function searchFileFacts(facts, episodeIndex, spaceIds, query, options = {}) {
  return searchFileFactsPage(facts, episodeIndex, spaceIds, query, options).facts;
}

export function searchFileFactsPage(facts, episodeIndex, spaceIds, query, options = {}) {
  const search = {
    includeHistorical: options.includeHistorical ?? false,
    scope: options.scope ?? null,
    limit: options.limit ?? null,
    excludeRestricted: options.excludeRestricted === true,
    safeSourceSpaceId: options.safeSourceSpaceId ?? null,
    maxObjectBytes: options.maxObjectBytes ?? null,
    query: query.toLowerCase()
  };

  if (search.limit !== null && (!Number.isInteger(search.limit) || search.limit <= 0)) {
    throw new TypeError('Fact search limit must be a positive integer');
  }

  const selected = [];
  let objectLimitTruncated = false;
  for (const fact of facts) {
    if (!matchesSearchWithoutObjectLimit(fact, episodeIndex, spaceIds, search)) continue;
    if (
      search.maxObjectBytes !== null &&
      Buffer.byteLength(fact.object, 'utf8') > search.maxObjectBytes
    ) {
      objectLimitTruncated = true;
      continue;
    }
    selected.push(fact);
    if (search.limit === null) continue;
    selected.sort(compareSearchFacts);
    if (selected.length > search.limit) selected.pop();
  }
  return { facts: selected, objectLimitTruncated };
}

function matchesSearchWithoutObjectLimit(fact, episodeIndex, spaceIds, search) {
  if (!spaceIds.includes(fact.spaceId)) return false;
  if (search.scope !== null && fact.scope !== search.scope) return false;
  if (!search.includeHistorical && !isCurrentFact(fact)) return false;
  if (search.excludeRestricted && isRestrictedFact(fact)) return false;
  if (search.safeSourceSpaceId !== null) {
    const source = episodeIndex.get(fact.sourceEpisodeId);
    if (
      !source ||
      source.spaceId !== search.safeSourceSpaceId ||
      isRestrictedEpisode(source)
    ) return false;
  }
  return `${fact.subject} ${fact.predicate} ${fact.object}`
    .toLowerCase()
    .includes(search.query);
}
