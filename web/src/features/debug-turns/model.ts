import { z } from 'zod'
import { deleteJson, getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { t } from '@/i18n'
import { tableLabel } from '@/i18n/label-table'

// The #debug turn records (src/debug-turns/): one turn of a session with all
// the context FULI saw, as ordered parts, each from one source.
export const DEBUG_SOURCES = ['person', 'fuli', 'ai', 'host', 'not_visible'] as const
export type DebugSource = typeof DEBUG_SOURCES[number]

const totals = z.looseObject(Object.fromEntries(DEBUG_SOURCES.map(source => [source, z.number()])) as Record<DebugSource, z.ZodNumber>)
const part = z.looseObject({ source: z.enum(DEBUG_SOURCES), kind: z.string(), label: z.string(), text: z.string(), bytes: z.number() })
const summary = z.looseObject({ id: z.string(), createdAt: z.string(), sourceApplication: z.string(), promptLine: z.string(), totals })
const record = z.looseObject({
  id: z.string(), createdAt: z.string(), sourceApplication: z.string(),
  transcript: z.enum(['read', 'unavailable', 'not_supported']), parts: z.array(part), totals,
  cut: z.looseObject({ historyMessages: z.number(), historyBytes: z.number(), parts: z.array(z.number()) }),
})
export type DebugTotals = z.infer<typeof totals>
export type DebugPart = z.infer<typeof part>
export type DebugTurnSummary = z.infer<typeof summary>
export type DebugTurnRecord = z.infer<typeof record>

const listShape = shapeOf(z.looseObject({ records: z.array(summary) }))
const recordShape = shapeOf(record)
const deletedShape = shapeOf(z.looseObject({ deleted: z.string() }))

const recordPath = (id: string) => `/api/debug-turns/${encodeURIComponent(id)}`
export const listDebugTurns = async (signal?: AbortSignal) => (await getJson('/api/debug-turns', listShape, { signal })).records
export const readDebugTurn = (id: string, signal?: AbortSignal) => getJson(recordPath(id), recordShape, { signal })
export const deleteDebugTurn = (id: string) => deleteJson(recordPath(id), undefined, deletedShape)

/** The bytes FULI added to the turn and their share of all it saw, as a whole percent (0 when empty). */
export function fuliShare(sums: DebugTotals): { bytes: number; total: number; percent: number } {
  const total = DEBUG_SOURCES.reduce((sum, source) => sum + sums[source], 0)
  const bytes = sums.fuli
  return { bytes, total, percent: total ? Math.round((bytes / total) * 100) : 0 }
}

// A part longer than this starts folded; shorter ones show whole.
export const FOLDED_PART_BYTES = 600
export const startsFolded = (item: DebugPart) => item.bytes > FOLDED_PART_BYTES || item.text.split('\n').length > 12

// The record's labels: a count for the tool list and the history, the event or
// tool name otherwise. An unknown kind keeps its code.
const COUNTED: Record<string, string> = { mcp_tools: 'debugTurns.toolCount', history: 'debugTurns.messageCount' }

/** The design token that colours a source, for its parts and its legend entry. */
export const sourceColour = (source: DebugSource) => `var(--color-source-${source.replace('_', '-')})`

/** One part's heading: what it is, then its label. */
export function partTitle(item: DebugPart): string {
  const kind = tableLabel('debugTurns.kinds', item.kind) ?? item.kind
  const counted = COUNTED[item.kind]
  const label = counted && item.label ? t(counted, { count: item.label }) : item.label
  return label ? `${kind} · ${label}` : kind
}

/** The client that ran the turn, by its source application code. */
export const clientName = (code: string) => tableLabel('settings.conversationLaunchers.applications', code) ?? code
