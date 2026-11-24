import { preferenceListState } from '@/features/knowledge/model'
import type { KnowledgeItem } from '@/types'

// The habits that never say when they apply (PR 1104): every task carries them
// in full, even one plainly about a single kind of work. A habit here is a
// current preference the person or the usage policy confirmed, the ones an
// entry delivers; whether it states a case is the console graph read's
// stated_case, judged by the same rule as an entry, never by this page.
const DELIVERED = new Set(['confirmed', 'agent_confirmed'])

export function unstatedHabits(items: readonly KnowledgeItem[]) {
  const unstated = items.filter(item => DELIVERED.has(preferenceListState(item)) && !item.raw.stated_case)
  return { count: unstated.length, hard: unstated.filter(item => item.raw.preference_qualifiers?.constraint === 'hard').length }
}
