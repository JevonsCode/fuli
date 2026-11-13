import { InvalidInputError } from '../app/application-error.js';
import { DIAGNOSTIC_COMPONENTS, DIAGNOSTIC_LEVELS } from './safe-event.js';

// The one read of the diagnostics log (rec#73), shared by GET
// /api/diagnostics/events, the read_diagnostic_events Agent tool and `fuli
// diagnostics`: newest first, filtered, paged, with grouped counts over every
// match. An empty answer never reads as healthy: truncated says whether more
// matched than this page or the retained window, sourcesUnavailable names
// what could not be read, and notCovered says what the log never records.

const DEFAULT_LIMIT = 50;
export const MAX_DIAGNOSTIC_LIMIT = 100;
const MAX_CODE_GROUPS = 50;
const CODE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CURSOR = /^(\d{1,15})\.([0-9a-f-]{36})$/;
const NOT_COVERED = 'Only failures caught at FULI\'s lifecycle hooks, HTTP API errors, native Graph Provider start, '
  + 'MCP tool errors and roundtable wakes that did not answer are recorded. A hard power loss, a process killed before it wrote, and failures outside '
  + 'these seams leave no event.';

export function diagnosticEventsAnswer(log, input = {}) {
  const query = diagnosticQuery(input);
  const stored = log.read();
  const matches = stored.events.map((event) => ({ event, time: Date.parse(event.at) }))
    .filter(({ event, time }) => (query.from === null || time >= query.from) && (query.to === null || time <= query.to)
      && (!query.component || event.component === query.component) && (!query.level || event.level === query.level)
      && (!query.code || event.code === query.code))
    .sort((left, right) => right.time - left.time || right.event.id.localeCompare(left.event.id));
  const after = query.cursor
    ? matches.filter(({ event, time }) => time < query.cursor.time
      || (time === query.cursor.time && event.id.localeCompare(query.cursor.id) < 0))
    : matches;
  const page = after.slice(0, query.limit);
  const oldestKept = stored.events.reduce((oldest, event) => Math.min(oldest, Date.parse(event.at)), Infinity);
  const truncatedBy = [
    ...after.length > page.length ? ['page'] : [],
    // Rotation dropped older events, and the request reaches back before what is kept.
    ...stored.mayHaveDropped && (query.from === null || query.from < oldestKept) ? ['retention'] : []
  ];
  const last = page.at(-1);
  return {
    events: page.map(({ event }) => event),
    total: matches.length,
    counts: groupedCounts(matches.map(({ event }) => event)),
    nextCursor: after.length > page.length && last ? `${last.time}.${last.event.id}` : null,
    truncated: truncatedBy.length > 0,
    truncatedBy,
    retainedFrom: Number.isFinite(oldestKept) ? new Date(oldestKept).toISOString() : null,
    sourcesUnavailable: stored.sourcesUnavailable,
    skippedLines: stored.skippedLines,
    stored: stored.stored,
    notCovered: NOT_COVERED
  };
}

// Strings from a URL or CLI and values from an Agent tool alike; validated once here.
function diagnosticQuery({ from = null, to = null, component = null, level = null, code = null, limit = null,
  cursor = null }) {
  const query = {
    from: time(from, 'from'), to: time(to, 'to'),
    component: choice(component, DIAGNOSTIC_COMPONENTS, 'component'),
    level: choice(level, DIAGNOSTIC_LEVELS, 'level'),
    code: present(code) ? matching(code, CODE, 'code', 'an error code such as provider_timeout') : null,
    limit: present(limit) ? count(limit) : DEFAULT_LIMIT,
    cursor: present(cursor) ? pageCursor(cursor) : null
  };
  if (query.from !== null && query.to !== null && query.from > query.to) {
    throw new InvalidInputError('from must not be later than to');
  }
  return query;
}

const present = (value) => value !== null && value !== undefined && value !== '';

function time(value, label) {
  if (!present(value)) return null;
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed)) throw new InvalidInputError(`${label} must be an ISO 8601 date-time`);
  return parsed;
}

function choice(value, allowed, label) {
  if (!present(value)) return null;
  if (!allowed.includes(value)) throw new InvalidInputError(`${label} must be one of ${allowed.join(', ')}`);
  return value;
}

function matching(value, pattern, label, expected) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new InvalidInputError(`${label} must be ${expected}`);
  return value;
}

function count(value) {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_DIAGNOSTIC_LIMIT) {
    throw new InvalidInputError(`limit must be an integer from 1 to ${MAX_DIAGNOSTIC_LIMIT}`);
  }
  return parsed;
}

function pageCursor(value) {
  const [, at, id] = CURSOR.exec(matching(value, CURSOR, 'cursor', 'the nextCursor of an earlier page')) ?? [];
  return { time: Number(at), id };
}

function groupedCounts(events) {
  const tally = (key) => events.reduce((counts, event) => {
    const value = event[key] ?? 'none';
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
  const codes = Object.entries(tally('code')).sort(([, left], [, right]) => right - left);
  return { component: tally('component'), level: tally('level'),
    code: Object.fromEntries(codes.slice(0, MAX_CODE_GROUPS)), codesOmitted: Math.max(0, codes.length - MAX_CODE_GROUPS) };
}
