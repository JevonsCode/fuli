import { FactStatus } from '../models.js';

export { compareSearchFacts } from '../storage/fact-search-order.js';

export const BOUNDARY_PREDICATES = Object.freeze([
  'has_boundary',
  'has_access_boundary',
  'does_not_want',
  'avoids',
  'forbids'
]);
export const BOUNDARY_PREFIXES = Object.freeze([
  'boundary_',
  'does_not_',
  'avoids_',
  'forbids_',
  'must_not_'
]);

const STATUS_RANK = Object.freeze({
  [FactStatus.SUGGESTED]: 1,
  [FactStatus.OBSERVED]: 2,
  [FactStatus.CONFIRMED]: 3
});

export function taskTokens(task) {
  return new Set(normalizedTokens(task));
}

export function compareLensFacts(left, right, terms) {
  return compareNumber(isBoundary(right), isBoundary(left)) ||
    compareNumber(termMatches(right, terms), termMatches(left, terms)) ||
    compareNumber(STATUS_RANK[right.status] ?? 0, STATUS_RANK[left.status] ?? 0) ||
    compareText(right.validAt, left.validAt) ||
    compareText(left.id, right.id);
}

function termMatches(fact, terms) {
  const factTokens = new Set(normalizedTokens(`${fact.subject} ${fact.predicate} ${fact.object}`));
  let matches = 0;
  for (const term of terms) if (factTokens.has(term)) matches += 1;
  return matches;
}

function normalizedTokens(text) {
  return String(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function isBoundary(fact) {
  return BOUNDARY_PREDICATES.includes(fact.predicate) ||
    BOUNDARY_PREFIXES.some((prefix) => fact.predicate.startsWith(prefix));
}

function compareNumber(left, right) {
  return left - right;
}

function compareText(left, right) {
  const first = String(left ?? '');
  const second = String(right ?? '');
  return first === second ? 0 : (first < second ? -1 : 1);
}
