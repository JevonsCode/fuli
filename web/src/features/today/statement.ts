import { z } from 'zod'
import { getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { t } from '@/i18n'

// 这周的复利账单: GET /api/statement for one local week (Monday 00:00 to the
// next Monday 00:00). Every section may be missing, or named in `unavailable`;
// a missing number is simply not shown, and a server without the route (404)
// or a failed read means there is no statement at all.
const STATEMENT_WEEKS = 8
const count = z.number()
const section = <T extends z.ZodRawShape>(fields: T) => z.looseObject(fields).nullish()
const statementSchema = z.looseObject({
  window: section({ from: z.string(), to: z.string() }),
  total: section({ confirmed: count }),
  series: z.array(z.looseObject({ to: z.string(), confirmed: count })).nullish(),
  carried: section({ tasks: count, clients: count, items: count }),
  used: section({ times: count, tasks: count, cited: count, applied: count }),
  learned: section({ captured: count, confirmedByYou: count, confirmedByTonborg: count, promotedByUse: count, retired: count }),
  decided: section({ forYou: count, undone: count }),
  changed: section({ forYou: count }),
  done: section({ finished: count, failed: count }),
  answered: section({ questions: count }),
  unavailable: z.array(z.string()).nullish(),
})
const statementShape = shapeOf(statementSchema)
export type Statement = z.infer<typeof statementSchema>
type Section = 'total' | 'carried' | 'used' | 'learned' | 'decided' | 'changed' | 'done' | 'answered'

export interface StatementWeek { from: string; to: string }

/** The local week `weeksBack` weeks before the one `now` is in, Monday 00:00 to the next Monday 00:00. */
export function statementWeek(now: Date, weeksBack = 0): StatementWeek {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7) - 7 * weeksBack)
  const next = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7)
  return { from: monday.toISOString(), to: next.toISOString() }
}

/** The week's statement, or null when the server cannot give one. */
export async function readStatement(week: StatementWeek, signal?: AbortSignal): Promise<Statement | null> {
  const query = new URLSearchParams({ from: week.from, to: week.to, weeks: String(STATEMENT_WEEKS) })
  try {
    return await getJson(`/api/statement?${query}`, statementShape, { signal })
  } catch {
    return null
  }
}

/** One number of the statement, or null when it is missing or the server says it is not available. */
export function statementValue(statement: Statement, name: Section, field: string): number | null {
  const unavailable = statement.unavailable ?? []
  if (unavailable.includes(name) || unavailable.includes(`${name}.${field}`)) return null
  const value = (statement[name] as Record<string, unknown> | null | undefined)?.[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export interface StatementTile { key: string; value: number; label: string; sub: string | null }

/** The four tiles under the headline; a tile whose number is 0 or missing is left out. */
export function statementTiles(statement: Statement): StatementTile[] {
  const value = (name: Section, field: string) => statementValue(statement, name, field)
  // A second line with nothing to count (「跨 0 个客户端」) says nothing, so it is left out.
  const sub = (key: string, amount: number | null) => (amount ? t(`today.statement.tiles.${key}`, { count: amount }) : null)
  const tiles: Array<StatementTile | null> = [
    tile('carried', value('carried', 'tasks'), sub('carriedSub', value('carried', 'clients'))),
    tile('used', value('used', 'times'), t('today.statement.tiles.usedSub')),
    tile('learned', value('learned', 'captured'), sub('learnedSub', value('learned', 'confirmedByYou'))),
    tile('decided', value('decided', 'forYou'), sub('decidedSub', value('decided', 'undone'))),
  ]
  return tiles.filter((item): item is StatementTile => item !== null)
}
function tile(key: string, value: number | null, sub: string | null): StatementTile | null {
  return value ? { key, value, label: t(`today.statement.tiles.${key}`), sub } : null
}

/** The headline's number: everything confirmed so far, or null when there is none to show. */
export function statementTotal(statement: Statement) {
  return statementValue(statement, 'total', 'confirmed') || null
}

/** The running total, oldest week first. */
export function statementSeries(statement: Statement) {
  if ((statement.unavailable ?? []).includes('series')) return []
  return [...(statement.series ?? [])].sort((left, right) => Date.parse(left.to) - Date.parse(right.to)).map(point => point.confirmed)
}

// Every number the details list, with where it comes from: FULI saw it happen in
// its own records, or an assistant said so and FULI only counts what it said.
const DETAIL_ROWS: ReadonlyArray<{ key: string; name: Section; field: string; source: 'seen' | 'reported' }> = [
  { key: 'totalConfirmed', name: 'total', field: 'confirmed', source: 'seen' },
  { key: 'carriedTasks', name: 'carried', field: 'tasks', source: 'seen' },
  { key: 'carriedClients', name: 'carried', field: 'clients', source: 'seen' },
  { key: 'carriedItems', name: 'carried', field: 'items', source: 'seen' },
  { key: 'usedTimes', name: 'used', field: 'times', source: 'reported' },
  { key: 'usedTasks', name: 'used', field: 'tasks', source: 'reported' },
  { key: 'usedCited', name: 'used', field: 'cited', source: 'reported' },
  { key: 'usedApplied', name: 'used', field: 'applied', source: 'reported' },
  { key: 'learnedCaptured', name: 'learned', field: 'captured', source: 'seen' },
  { key: 'learnedConfirmedByYou', name: 'learned', field: 'confirmedByYou', source: 'seen' },
  { key: 'learnedConfirmedByTonborg', name: 'learned', field: 'confirmedByTonborg', source: 'seen' },
  { key: 'learnedPromotedByUse', name: 'learned', field: 'promotedByUse', source: 'seen' },
  { key: 'learnedRetired', name: 'learned', field: 'retired', source: 'seen' },
  { key: 'decidedForYou', name: 'decided', field: 'forYou', source: 'seen' },
  { key: 'decidedUndone', name: 'decided', field: 'undone', source: 'seen' },
  { key: 'changedForYou', name: 'changed', field: 'forYou', source: 'seen' },
  { key: 'doneFinished', name: 'done', field: 'finished', source: 'reported' },
  { key: 'doneFailed', name: 'done', field: 'failed', source: 'reported' },
  { key: 'answeredQuestions', name: 'answered', field: 'questions', source: 'seen' },
]

export interface StatementDetail { key: string; label: string; value: number; what: string; source: string }

/** Every number the statement has, zero included, each with what it counts and who saw it. */
export function statementDetails(statement: Statement): StatementDetail[] {
  return DETAIL_ROWS.flatMap(({ key, name, field, source }) => {
    const value = statementValue(statement, name, field)
    return value === null ? [] : [{
      key, value, label: t(`today.statement.rows.${key}.label`), what: t(`today.statement.rows.${key}.what`), source: t(`today.statement.source.${source}`),
    }]
  })
}

/** The polyline points of a small trend line, or null when there is no trend to draw. */
export function sparklinePoints(values: readonly number[], width: number, height: number, inset = 2): string | null {
  if (values.length < 2 || values.every(value => value === 0)) return null
  const low = Math.min(...values), span = Math.max(...values) - low
  const step = (width - inset * 2) / (values.length - 1)
  return values.map((value, index) => {
    const y = span ? height - inset - ((value - low) / span) * (height - inset * 2) : height / 2
    return `${round(inset + index * step)},${round(y)}`
  }).join(' ')
}
const round = (value: number) => Math.round(value * 10) / 10
