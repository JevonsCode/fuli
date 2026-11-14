import { z } from 'zod'
import { ApiError, getJson } from '@/api/client'
import { shapeFor } from '@/api/response-shape'
import { hardDeletedFrom } from '@/features/knowledge-hard-delete/model'
import { readKnowledgeItem } from '@/features/knowledge-quick-edit/quick-edit-api'
import type { HabitDelivery, HabitRow } from './model'

// The list behind a new conversation's 「FULI 习惯」 receipt line: the local
// delivery record names the habits by id; each is read back as it is now.
const deliveryShape = shapeFor<HabitDelivery>(z.looseObject({
  at: z.string(), client: z.string(), model: z.string().nullish(),
  items: z.array(z.looseObject({ kind: z.string(), id: z.string() })),
}))

/** null: the record expired or never existed (404). */
export async function readHabitDelivery(taskKey: string): Promise<HabitDelivery | null> {
  try {
    return await getJson(`/api/habit-deliveries/${encodeURIComponent(taskKey)}`, deliveryShape)
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 404) return null
    throw cause
  }
}

/** Each handed-over habit as it is now; one deleted since reads as deleted, any other failure fails the list. */
export function readHabitRows(spaceId: string, delivery: HabitDelivery): Promise<HabitRow[]> {
  return Promise.all(delivery.items.map(async ({ kind, id }): Promise<HabitRow> => {
    try {
      return { kind, id, item: await readKnowledgeItem(spaceId, kind, id), deleted: false }
    } catch (cause) {
      if (hardDeletedFrom(cause) || (cause instanceof ApiError && cause.status === 404)) return { kind, id, item: null, deleted: true }
      throw cause
    }
  }))
}
