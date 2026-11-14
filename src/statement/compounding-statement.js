import { InvalidInputError } from '../app/application-error.js';
import { positiveInteger } from '../validation/values.js';
import { normalisedClient } from '../agents/source-applications.js';

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
// Usage by client and model: the rows a reader gets, and the days the executor judgment looks back.
const USAGE_ROWS = 20;
const USAGE_DAYS = 30;
const RECENT_USAGE_NOTE = 'taskEntries: task entries FULI recorded; wakes / failedWakes: wakes FULI started that answered / did not; '
  + 'model null: not reported. A task entry records no outcome.';
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

// Which clients and models the person's assistants worked with in a window:
// task entries FULI recorded (client as recorded, model as the client's hook
// reported it) and wakes of clients FULI woke, answered and failed (model and
// tokens as the woken client reported them). A model nobody reported stays null, its own row;
// tokens appear only where a client reported them. Two grouped local reads;
// the most active rows first, at most USAGE_ROWS of them.
export async function clientModelUsage(app, { from, to }) {
  const window = { from: from.toISOString(), to: to.toISOString() };
  const [entries, wakes] = await Promise.all([
    settle(() => app.recallImpressions.entriesByClientModel({ personalSpaceId: app.config.personal.spaceId, ...window })),
    settle(() => app.roundtable.wakeUsage(window))
  ]);
  const rows = new Map();
  const row = (reported, model) => {
    const client = normalisedClient(reported) || 'other';
    const key = JSON.stringify([client, model]);
    if (!rows.has(key)) rows.set(key, { client, model, taskEntries: 0, wakes: 0, failedWakes: 0, tokens: null });
    return rows.get(key);
  };
  for (const { client, model, entries: count } of entries?.value ?? []) row(client, model).taskEntries += count;
  for (const { client, model, wakes: answered, failedWakes, inputTokens, outputTokens, tokenWakes } of wakes?.value ?? []) {
    const target = row(client, model);
    target.wakes += answered;
    target.failedWakes += failedWakes;
    if (tokenWakes) target.tokens = addTokens(target.tokens, { input: inputTokens, output: outputTokens, wakes: tokenWakes });
  }
  const work = row => row.taskEntries + row.wakes + row.failedWakes;
  const ranked = [...rows.values()].sort((left, right) => work(right) - work(left)
    || left.client.localeCompare(right.client) || String(left.model ?? '').localeCompare(String(right.model ?? '')));
  return { window, rows: ranked.slice(0, USAGE_ROWS), more: ranked.length > USAGE_ROWS,
    unavailable: [...(entries ? [] : ['taskEntries']), ...(wakes ? [] : ['wakes'])] };
}

// What Tonborg's executor judgment reads beside its other evidence: the last
// USAGE_DAYS days of clientModelUsage, compact. Null when nothing was read.
export async function recentClientModelUsage(app, now = new Date()) {
  const usage = await clientModelUsage(app, { from: new Date(now.getTime() - USAGE_DAYS * DAY_MS), to: now });
  if (!usage.rows.length) return null;
  return { days: USAGE_DAYS, note: RECENT_USAGE_NOTE,
    rows: usage.rows.map(({ client, model, taskEntries, wakes, failedWakes }) => ({ client, model, taskEntries, wakes, failedWakes })),
    ...(usage.more ? { more: true } : {}) };
}

function addTokens(sum, { input, output, wakes }) {
  const add = (left, right) => (left === null || right === null ? left ?? right : left + right);
  return { input: add(sum?.input ?? null, input), output: add(sum?.output ?? null, output),
    wakes: (sum?.wakes ?? 0) + wakes, source: 'client_reported' };
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
