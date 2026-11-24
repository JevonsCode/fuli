import { preferenceListState } from '@/features/knowledge/model'
import type { KnowledgeItem } from '@/types'

// The habits that never say when they apply: every task carries them, even
// one plainly about a single kind of work. A habit here is a
// current preference the person or the usage policy confirmed, the ones an
// entry delivers; whether it states a case is the console graph read's
// stated_case and whether it is a hard rule its hard_rule, judged by the
// same rules as an entry, never by this page.
const DELIVERED = new Set(['confirmed', 'agent_confirmed'])

export function unstatedHabits(items: readonly KnowledgeItem[]) {
  const unstated = items.filter(item => DELIVERED.has(preferenceListState(item)) && !item.raw.stated_case)
  return { count: unstated.length, hard: unstated.filter(item => item.raw.hard_rule).length }
}
