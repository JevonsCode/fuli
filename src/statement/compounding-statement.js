import { InvalidInputError } from '../app/application-error.js';
import { positiveInteger } from '../validation/values.js';

// The person's compounding statement (复利账单): for one window, only the
// numbers FULI really has. Each section comes from one source read once; a
// source that cannot be read now is named in `unavailable` and its sections
// are left out, never zeroed or estimated. The graph's part is one Provider
// call (five aggregate reads); the rest are local SQLite counts. Nothing here
// runs at task entry.
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MAX_WINDOW_MS = 366 * DAY_MS;
// The calendar's 53 weeks and a few days to spare; the Provider holds the same cap.
const MAX_DAYS = 371;
export const DEFAULT_WEEKS = 8;
export const MAX_WEEKS = 26;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

// from/to: ISO instants with a zone (the person's local week bounds, as the
// caller computed them); weeks: how many week-end points the series has.
export function statementWindow({ from, to, weeks = DEFAULT_WEEKS }) {
  const start = instant(from, 'from');
  const end = instant(to, 'to');
  if (start >= end) throw new InvalidInputError('from must be before to');
  if (end - start > MAX_WINDOW_MS) throw new InvalidInputError('from and to may be at most 366 days apart');
  return { from: start, to: end, weeks: positiveInteger(weeks, 'weeks', MAX_WEEKS) };
}

// This machine's current local week, Monday 00:00 to the next Monday.
export function currentLocalWeek(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  return { from: start.toISOString(), to: end.toISOString() };
}

export async function compoundingStatement(app, { from, to, weeks }) {
  const space = app.config.personal.spaceId;
  const window = { from: from.toISOString(), to: to.toISOString() };
  const points = Array.from({ length: weeks }, (_, index) => new Date(to.getTime() - (weeks - 1 - index) * WEEK_MS).toISOString());
  const [graph, carried, decided, changed] = await Promise.all([
    settle(() => app.personal.readKnowledgeStatement({ personal_space_id: space, since: window.from, until: window.to, points })),
    settle(() => app.recallImpressions.deliveredBetween({ personalSpaceId: space, ...window })),
    settle(() => app.judgment.store().executionCounts(space, window.from, window.to)),
    settle(() => app.delegatedOperations.succeededBetween(window.from, window.to))
  ]);
  const unavailable = [];
  const section = (names, result, shape) => {
    if (result) return shape(result.value);
    unavailable.push(...names);
    return {};
  };
  return {
    window,
    ...section(['total', 'series'], graph, value => ({
      total: { confirmed: value.series.at(-1) },
      series: points.map((point, index) => ({ to: point, confirmed: value.series[index] }))
    })),
    ...section(['carried'], carried, value => ({ carried: value })),
    ...section(['used', 'learned'], graph, value => ({
      used: value.used,
      learned: { captured: value.learned.captured, confirmedByYou: value.learned.confirmed_by_you,
        confirmedByTonborg: value.learned.confirmed_by_tonborg, promotedByUse: value.learned.promoted_by_use,
        retired: value.learned.retired }
    })),
    ...section(['decided'], decided, value => ({ decided: { forYou: value.applied, undone: value.undone } })),
    ...section(['changed'], changed, value => ({ changed: { forYou: value } })),
    ...section(['done', 'answered'], graph, value => ({
      done: value.done,
      answered: { questions: value.answered }
    })),
    unavailable
  };
}

// The statement day by day (the console's calendar): from/to carry the
// person's UTC offset, one and the same, and a day is a local day of it.
export function statementDaysWindow({ from, to }) {
  const start = instant(from, 'from');
  const end = instant(to, 'to');
  if (start >= end) throw new InvalidInputError('from must be before to');
  if (end - start > MAX_DAYS * DAY_MS) throw new InvalidInputError(`from and to may be at most ${MAX_DAYS} days apart`);
  const offsetMinutes = offsetOf(from);
  if (offsetMinutes !== offsetOf(to)) throw new InvalidInputError('from and to must carry the same UTC offset');
  return { from, to, start, end, offsetMinutes };
}

// Per local day, the weekly statement's own measures where they are cheap to
// cut by day: learned (learned.captured), confirmed (learned.confirmedByYou +
// confirmedByTonborg + promotedByUse), used (used.times) from one Provider
// call, carried (carried.tasks) from one grouped local read. Days with
// nothing are left out; a source that cannot be read is named in
// `unavailable` and its measures are left out of every day.
export async function statementDays(app, { from, to, start, end, offsetMinutes }) {
  const space = app.config.personal.spaceId;
  const [graph, carried] = await Promise.all([
    settle(() => app.personal.readKnowledgeStatementDays({ personal_space_id: space, since: from, until: to })),
    settle(() => app.recallImpressions.deliveredTasksByDay({ personalSpaceId: space, from: start.toISOString(),
      to: end.toISOString(), offsetMinutes }))
  ]);
  const days = new Map();
  const add = (day, counts) => days.set(day, { ...days.get(day), ...counts });
  for (const { day, learned, confirmed, used } of graph?.value.days ?? []) add(day, { learned, confirmed, used });
  for (const { day, tasks } of carried?.value ?? []) add(day, { carried: tasks });
  const blank = { ...(graph ? { learned: 0, confirmed: 0, used: 0 } : {}), ...(carried ? { carried: 0 } : {}) };
  return {
    window: { from: start.toISOString(), to: end.toISOString() },
    days: [...days].sort(([left], [right]) => left.localeCompare(right))
      .map(([day, counts]) => ({ day, ...blank, ...counts }))
      .filter(entry => Object.values(entry).some(value => typeof value === 'number' && value > 0)),
    unavailable: [...(graph ? [] : ['learned', 'confirmed', 'used']), ...(carried ? [] : ['carried'])]
  };
}

function offsetOf(value) {
  const zone = value.match(/(Z|[+-]\d{2}:\d{2})$/)[1];
  if (zone === 'Z') return 0;
  const minutes = Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4));
  return zone[0] === '-' ? -minutes : minutes;
}

function instant(value, label) {
  const parsed = typeof value === 'string' && INSTANT.test(value) ? Date.parse(value) : NaN;
  if (Number.isNaN(parsed)) throw new InvalidInputError(`${label} must be an ISO 8601 instant with a time zone`);
  return new Date(parsed);
}

// A source that throws, or is not there at all, is unavailable.
async function settle(read) {
  try {
    return { value: await read() };
  } catch {
    return null;
  }
}
