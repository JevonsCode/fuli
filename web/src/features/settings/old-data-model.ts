import { z } from 'zod'
import { getJson, postJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { currentLocale, t } from '@/i18n'
import { formatBytes } from '@/lib/format-bytes'

// GET /api/old-data (src/old-data/port.js, rec#80 group B): the copies FULI
// kept before it changed something, and how much live and old data take.
const oldDataItem = z.looseObject({
  id: z.string(),
  kind: z.string(),
  left: z.looseObject({ zh: z.string(), en: z.string() }),
  createdAt: z.string(),
  bytes: z.number(),
  restorable: z.boolean(),
})

const oldDataSchema = z.looseObject({
  items: z.array(oldDataItem),
  summary: z.looseObject({ liveBytes: z.number(), oldBytes: z.number(), totalBytes: z.number() }),
})

export type OldDataItem = z.infer<typeof oldDataItem>
export type OldData = z.infer<typeof oldDataSchema>

export const readOldData = () => getJson('/api/old-data', shapeOf(oldDataSchema))
export const restoreOldData = (id: string) =>
  postJson(`/api/old-data/${encodeURIComponent(id)}/restore`, {}, shapeOf(z.looseObject({ id: z.string() })))
export const deleteOldData = (id: string) =>
  postJson(`/api/old-data/${encodeURIComponent(id)}/delete`, {}, shapeOf(z.looseObject({ id: z.string(), freedBytes: z.number() })))

/** What left an item, in the reader's language. */
export const oldDataLabel = (item: OldDataItem) => currentLocale() === 'en-US' ? item.left.en : item.left.zh

/** The card's one line: the live data, and the old data only when there is some. */
export function storageHeadline({ summary, items }: OldData): string {
  const live = formatBytes(summary.liveBytes)
  return items.length
    ? t('settings.storage.headlineWithOld', { live, old: formatBytes(summary.oldBytes) })
    : t('settings.storage.headline', { live })
}
