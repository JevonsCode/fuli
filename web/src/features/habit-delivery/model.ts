import type { ItemKind, KnowledgeItemView } from '@/features/knowledge-quick-edit/model'

/** One task entry's delivery record: when, from which client, and which habits it handed over. */
export interface HabitDelivery {
  at: string
  client: string
  model?: string | null
  items: { kind: ItemKind; id: string }[]
}

/** A habit as the page lists it: read back now, or deleted since the hand-over. */
export type HabitRow =
  | { kind: ItemKind; id: string; item: KnowledgeItemView; deleted: false }
  | { kind: ItemKind; id: string; item: null; deleted: true }
