import { z } from 'zod'
import { getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { sourceApplication, sourceApplicationName } from '@/features/knowledge/source-adapters'
import { t } from '@/i18n'
import type { ConversationSourceApplication } from '@/types'
import type { StatementWeek } from './statement'

// The lists behind two of the statement's tiles, for one week: the
// conversations that carried habits (GET /api/statement/carried) and the items
// learned and confirmed (GET /api/statement/learned, ids only; each item's
// text is read by itself, as the habit list does). The server counts each
// number and lists its rows from the same source, so a list is as long as its
// number says, up to the rows it holds.
const count = z.number()
const carriedSchema = z.looseObject({
  rows: z.array(z.looseObject({
    key: z.string().nullable(), at: z.string(), client: z.string().nullable(), model: z.string().nullable(), habits: count, recalled: count,
  })),
  more: z.boolean(),
})
const itemList = z.looseObject({
  total: count,
  items: z.array(z.looseObject({ kind: z.enum(['entity', 'relationship']), id: z.string(), at: z.string() })),
})
const learnedSchema = z.looseObject({ captured: itemList, confirmedByYou: itemList })
const carriedShape = shapeOf(carriedSchema)
const learnedShape = shapeOf(learnedSchema)
export type CarriedTasks = z.infer<typeof carriedSchema>
export type LearnedItems = z.infer<typeof learnedSchema>
export type LearnedList = 'captured' | 'confirmedByYou'

const windowQuery = (week: StatementWeek) => new URLSearchParams({ from: week.from, to: week.to })

/** The week's conversations that carried habits, the latest first; a failed read throws. */
export const readCarriedTasks = (week: StatementWeek, signal?: AbortSignal) =>
  getJson(`/api/statement/carried?${windowQuery(week)}`, carriedShape, { signal })

/** Which items the week's 新学到的 and 你确认的 count, the latest first; a failed read throws. */
export const readLearnedItems = (week: StatementWeek, signal?: AbortSignal) =>
  getJson(`/api/statement/learned?${windowQuery(week)}`, learnedShape, { signal })

/** One conversation as its row shows it; `to` is its habit list, when it was handed any. */
export interface CarriedRow {
  id: string; at: string; client: ConversationSourceApplication | null; clientName: string; model: string | null; carried: string; to: string | null
}

export function carriedRows(list: CarriedTasks): CarriedRow[] {
  return list.rows.map((row, index) => {
    const client = row.client === null ? null : sourceApplication({ source_application: row.client })
    return {
      id: row.key ?? `${row.at}-${index}`,
      at: row.at,
      client,
      clientName: client === null ? t('today.lists.carried.unknownClient')
        : client === 'other' ? t('today.usage.otherClient') : sourceApplicationName(client),
      model: row.model,
      carried: [row.habits ? t('today.lists.carried.habits', { count: row.habits }) : '',
        row.recalled ? t('today.lists.carried.recalled', { count: row.recalled }) : ''].filter(Boolean).join(' · '),
      to: row.key && row.habits ? `/habits/${row.key}` : null,
    }
  })
}

/** The list a learned dialog opens on: the new items, or the confirmed ones when nothing was new. */
export const firstLearnedList = (lists: LearnedItems): LearnedList => (lists.captured.total || !lists.confirmedByYou.total ? 'captured' : 'confirmedByYou')
