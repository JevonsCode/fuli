import { computed, ref, watch, type Ref } from 'vue'
import { z } from 'zod'
import { getJson } from '@/api/client'
import { shapeFor } from '@/api/response-shape'
import { profileItemsOf } from '@/features/knowledge/model'
import { knownNotice, NOTICE_KINDS, noticePageShape, type Notice } from '@/features/overview/notices'
import { useOverviewData } from '@/features/overview/useOverviewData'
import { detectPreferenceConflicts, type PreferenceConflictRecord } from '@/features/preferences/preference-conflicts'
import { useReviewList } from '@/features/review-list/review-store'
import { useTeamWork } from '@/features/team-work/useTeamWork'
import type { PersonalProject } from '@/types'
import { readStatement, statementTiles, statementTotal, statementWeek, type Statement } from './statement'
import { decisionRows, todayNotices, workingRows } from './today-model'

/** The sections of 今天, top to bottom. */
export const TODAY_SECTIONS = ['decisions', 'done', 'statement', 'working'] as const
export type TodaySection = typeof TODAY_SECTIONS[number]

// Notices of the last day, enough that today's five survive the kinds this console cannot word.
const NOTICE_READ = 20
const conflictRecordsShape = shapeFor<PreferenceConflictRecord[]>(z.array(z.looseObject({
  id: z.string(), status: z.string(), left_item_id: z.string(), left_item_kind: z.string(), right_item_id: z.string(), right_item_kind: z.string(),
})))

type Read<T> = { state: 'loading' | 'ready' | 'failed'; value: T }

/**
 * Everything 今天 reads, one source per section. Each section says whether it
 * has settled and what it shows; the page shows a section only once every
 * section above it has settled, so a late read only ever appends below.
 */
export function useTodayData(spaceId: Ref<string>, projects: Ref<PersonalProject[]>, now: () => Date = () => new Date()) {
  const overview = useOverviewData(spaceId, projects)
  const team = useTeamWork(spaceId)
  // The same list the top bar counts; the shell already reads it for this space.
  const review = useReviewList()
  watch(spaceId, id => { if (id) review.setSpace(id) }, { immediate: true })

  const deferred = ref<Read<PreferenceConflictRecord[]>>({ state: 'loading', value: [] })
  const notices = ref<Read<Notice[]>>({ state: 'loading', value: [] })
  const statement = ref<Read<Statement | null>>({ state: 'loading', value: null })

  // A refresh keeps what is shown until its answer arrives; only a first read starts empty.
  async function settle<T>(target: Ref<Read<T>>, id: string, read: () => Promise<T>) {
    try {
      const value = await read()
      if (id === spaceId.value) target.value = { state: 'ready', value }
    } catch {
      if (id === spaceId.value && target.value.state === 'loading') target.value = { state: 'failed', value: target.value.value }
    }
  }
  // Conflicts already handed to an assistant wait on it, not on the person.
  const loadDeferred = (id = spaceId.value) => id ? settle(deferred, id, () =>
    getJson(`/api/preference-conflicts?${new URLSearchParams({ personalSpaceId: id, status: 'ai_pending', limit: '500' })}`, conflictRecordsShape)) : Promise.resolve()
  const loadNotices = (id = spaceId.value) => id ? settle(notices, id, async () => {
    const query = new URLSearchParams({ days: '1', limit: String(NOTICE_READ) })
    for (const kind of NOTICE_KINDS) query.append('kind', kind)
    return (await getJson(`/api/notices?${query}`, noticePageShape)).items.filter(knownNotice)
  }) : Promise.resolve()
  const loadStatement = (id = spaceId.value) => id ? settle(statement, id, () => readStatement(statementWeek(now()))) : Promise.resolve()

  watch(spaceId, id => {
    deferred.value = { state: 'loading', value: [] }
    notices.value = { state: 'loading', value: [] }
    statement.value = { state: 'loading', value: null }
    void loadDeferred(id); void loadNotices(id); void loadStatement(id)
  }, { immediate: true })

  const conflicts = computed(() => detectPreferenceConflicts(profileItemsOf(review.items), deferred.value.value)
    .filter(conflict => !conflict.aiRecord).length)
  const decisions = computed(() => decisionRows({
    requests: overview.requestItems.value, requestTotal: overview.requests.data?.total ?? 0,
    reviewTotal: review.total, conflicts: deferred.value.state === 'ready' ? conflicts.value : 0,
  }))
  const done = computed(() => todayNotices(notices.value.value, now()))
  const tiles = computed(() => statement.value.value ? statementTiles(statement.value.value) : [])
  const total = computed(() => statement.value.value ? statementTotal(statement.value.value) : null)
  const working = computed(() => workingRows(overview.taskItems.value, team.sheets.value))

  const settled = computed<Record<TodaySection, boolean>>(() => ({
    decisions: Boolean(overview.requests.data || overview.requests.error) && (review.loaded || Boolean(review.error)) && deferred.value.state !== 'loading',
    done: notices.value.state !== 'loading',
    statement: statement.value.state !== 'loading',
    working: Boolean(overview.tasks.data || overview.tasks.error) && team.state.value !== 'loading',
  }))
  const filled = computed<Record<TodaySection, boolean>>(() => ({
    decisions: decisions.value.rows.length > 0,
    done: done.value.length > 0,
    statement: total.value !== null || tiles.value.length > 0,
    working: working.value.length > 0,
  }))
  // The sections that show, in order, up to the first one still reading.
  const shown = computed(() => {
    const sections: TodaySection[] = []
    for (const section of TODAY_SECTIONS) {
      if (!settled.value[section]) break
      if (filled.value[section]) sections.push(section)
    }
    return sections
  })
  const pending = computed(() => TODAY_SECTIONS.find(section => !settled.value[section]) ?? null)

  function reload() {
    return Promise.all([overview.loadTasks(), overview.loadRequests(), overview.loadNames(), review.refresh(), team.reload(),
      loadDeferred(), loadNotices(), loadStatement()])
  }
  return { overview, team, decisions, done, statement, tiles, total, working, shown, pending, reload }
}
