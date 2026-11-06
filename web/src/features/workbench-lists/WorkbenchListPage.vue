<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { z } from 'zod'
import { getJson } from '@/api/client'
import { shapeFor, shapeOf } from '@/api/response-shape'
import Breadcrumb from '@/components/Breadcrumb.vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import VirtualDirectoryList from '@/components/VirtualDirectoryList.vue'
import { Button } from '@/components/ui/button'
import { OptionCombobox } from '@/components/ui/combobox'
import { Input } from '@/components/ui/input'
import { OptionSelect } from '@/components/ui/select'
import { agentDisplayName } from '@/features/agent-profile/profile-model'
import { projectAgentSchema } from '@/features/agent-profile/agent-record-shape'
import NoticeRow from '@/features/overview/NoticeRow.vue'
import { knownNotice, noticePageShape, type Notice } from '@/features/overview/notices'
import { normalizeOverviewTasks, overviewOwnerId, overviewTaskTitle } from '@/features/overview/overview-data'
import { taskStatusLabel } from '@/features/project-agents/task-labels'
import { projectDisplayName } from '@/features/projects/project-origin'
import { currentLocale, t } from '@/i18n'
import { formatDateTime } from '@/lib/date-time'
import { createDebouncedAction } from '@/lib/debounce'
import { usePageTitle } from '@/layouts/page-title'
import { useConsoleStore } from '@/stores/console'
import type { ProjectAgentRecord, ProjectAgentTaskRecord } from '@/types'
import UiNotice from '@/ui/UiNotice.vue'
import TaskListRow from './TaskListRow.vue'
import { activeFilterCount, isFiltered, isWorkbenchList, LIST_KINDS, LIST_RANGES, LIST_SORTS, noticePageParams, readListQuery, taskPageParams,
  writeListQuery, type ListQuery, type WorkbenchList } from './list-query'
import { useListPages, type ListSource } from './useListPages'
import '@/features/overview/workbench-card.css'

// One workbench list on its own page (Jevons 11-06): 进行中, 最近完成 or
// 最近你可能需要知道的事, searched, filtered and sorted with everything in the
// URL, read a page at a time and drawn only near the viewport. The workbench
// card grows into this page (styles/motion.css, data-list-morph).
const PAGE_SIZE = 50
const SEARCH_DELAY_MS = 300
// Fixed row heights the virtual list lays out by: a task is one title line and
// one meta line; a notice reads up to two lines.
const ROW_HEIGHT = { task: 64, notice: 80 }

type Row = { key: string; task?: ProjectAgentTaskRecord; notice?: Notice }

const route = useRoute()
const router = useRouter()
const store = useConsoleStore()
const list = computed<WorkbenchList>(() => (isWorkbenchList(route.params.list) ? route.params.list : 'running'))
const isNotices = computed(() => list.value === 'notices')
const listTitle = computed(() => ({
  running: t('overview.sections.currentWork'), done: t('overview.sections.recentlyDone'), notices: t('overview.notices.title'),
})[list.value])
usePageTitle(listTitle)

const spaceId = computed(() => store.activePersonalSpace?.id ?? store.state?.activePersonalSpaceId ?? '')
const projects = computed(() => (store.state?.personalProjects ?? []).filter(project => project.personal_space_id === spaceId.value))
const projectNames = computed(() => new Map(projects.value.map(project => [project.project_id, projectDisplayName(project)])))
onMounted(() => { if (store.runtimeStatus === 'idle') void store.refresh() })

// The query the URL holds; the search box answers it after a short pause.
const query = computed(() => readListQuery(list.value, route.query))
const searchInput = ref(query.value.text)
watch(() => query.value.text, text => { if (text !== searchInput.value.trim()) searchInput.value = text })
function update(change: Partial<ListQuery>) {
  void router.replace({ query: writeListQuery(list.value, { ...query.value, ...change }) })
}
const searchSoon = createDebouncedAction(() => update({ text: searchInput.value.trim() }), SEARCH_DELAY_MS)
watch(searchInput, () => searchSoon.schedule())
onBeforeUnmount(() => searchSoon.cancel())
function clearFilters() { searchSoon.cancel(); searchInput.value = ''; void router.replace({ query: {} }) }

// The roster names a task's lead and fills the FLA filter; one read per space.
const rosterShape = shapeFor<ProjectAgentRecord[]>(z.array(projectAgentSchema))
const roster = ref<ProjectAgentRecord[]>([])
watch(spaceId, async (id) => {
  roster.value = []
  if (!id) return
  try {
    const records = await getJson(`/api/project-agents?${new URLSearchParams({ personalSpaceId: id })}`, rosterShape)
    if (id === spaceId.value) roster.value = records.filter(record => record.personalSpaceId === id)
  } catch {
    // Without names the rows still show; the FLA filter just has nothing to offer.
  }
}, { immediate: true })
const agentNames = computed(() => new Map(roster.value.map(record => [record.agentId, agentDisplayName(record)])))

const taskPageShape = shapeOf(z.looseObject({ items: z.array(z.unknown()), nextCursor: z.string().nullable(), total: z.number().nullable() }))
const source = computed<ListSource<Row> | null>(() => {
  const space = spaceId.value
  if (!space) return null
  const state = query.value
  const which = list.value
  if (which === 'notices') {
    const params = noticePageParams(state)
    params.set('limit', String(PAGE_SIZE))
    return {
      key: `${space}\n${which}\n${params}`,
      read: async (cursor, signal) => {
        const page = await getJson(`/api/notices?${withCursor(params, cursor)}`, noticePageShape, { signal })
        return { items: page.items.filter(knownNotice).map(notice => ({ key: notice.id, notice })), nextCursor: page.nextCursor ?? null, total: page.total }
      },
    }
  }
  // The time window starts from when this query was first read, so later pages keep the same window.
  const params = taskPageParams(which, state, space, Date.now())
  params.set('limit', String(PAGE_SIZE))
  return {
    key: `${space}\n${which}\n${writeListKey(state)}`,
    read: async (cursor, signal) => {
      const page = await getJson(`/api/project-agent-task-pages?${withCursor(params, cursor)}`, taskPageShape, { signal })
      const items = normalizeOverviewTasks({ items: page.items }, space).map(task => ({ key: `${task.personalProjectId ?? ''}:${task.taskId}`, task }))
      return { items, nextCursor: page.nextCursor, total: page.total }
    },
  }
})
const writeListKey = (state: ListQuery) => JSON.stringify(writeListQuery(list.value, state))
function withCursor(params: URLSearchParams, cursor: string | null) {
  const page = new URLSearchParams(params)
  if (cursor) page.set('cursor', cursor)
  return page
}
const pages = useListPages(source)
const rows = computed(() => pages.items.value)
const firstRead = computed(() => pages.loading.value && !rows.value.length)
const filtered = computed(() => isFiltered(list.value, query.value))
// Phones fold the filters behind one button that counts the ones in use.
const filtersOpen = ref(false)
const activeFilters = computed(() => activeFilterCount(list.value, query.value))

// Filter choices.
const rangeOptions = computed(() => LIST_RANGES[list.value].map(value => ({ value, label: t(`overview.lists.range.${value}`) })))
const sortOptions = computed(() => LIST_SORTS.map(value => ({ value, label: t(`overview.lists.sort.${value}`) })))
const projectOptions = computed(() => projects.value.map(project => ({ value: project.project_id, label: projectDisplayName(project) })))
const flaOptions = computed(() => roster.value.map(record => ({ value: record.agentId, label: agentDisplayName(record) })))
const kindOptions = computed(() => LIST_KINDS[list.value].map(value => ({
  value, label: isNotices.value ? t(`overview.lists.kinds.${value}`) : taskStatusLabel(value),
})))
const kindLabel = computed(() => t(isNotices.value ? 'overview.lists.kind.label' : 'overview.lists.status.label'))
const kindAll = computed(() => t(isNotices.value ? 'overview.lists.kind.all' : 'overview.lists.status.all'))

// Row words.
function formatTime(value?: string | null) {
  return formatDateTime(value, currentLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
    { missing: t('overview.missing.time'), invalid: t('overview.missing.time') })
}
function taskMeta(task: ProjectAgentTaskRecord) {
  const lead = overviewOwnerId(task)
  const owner = lead ? agentNames.value.get(lead) ?? lead : t('overview.missing.owner')
  const project = (task.personalProjectId && projectNames.value.get(task.personalProjectId)) || ''
  if (list.value === 'done' && task.resultSummary?.trim()) return task.resultSummary.trim()
  return [owner, project].filter(Boolean).join(' · ')
}
const statusLabel = (status: string) => taskStatusLabel(status, { unrecognized: t('overview.missing.status') })
</script>

<template>
  <section class="view workbench-list-view" :data-workbench-list="list">
    <Breadcrumb :parent="{ label: t('routes.overview.title'), to: '/', from: /^\/(?:[?#]|$)/ }" />
    <div class="workbench-card workbench-list-card" :data-list-morph="list">
      <div class="workbench-list-bar" :class="{ 'is-folded': !filtersOpen }" role="search">
        <Input v-model="searchInput" type="search" class="workbench-list-search" maxlength="200" data-list-search
          :aria-label="t(isNotices ? 'overview.lists.search.notices' : 'overview.lists.search.tasks')"
          :placeholder="t(isNotices ? 'overview.lists.search.notices' : 'overview.lists.search.tasks')" @keydown.enter.prevent="searchSoon.flush()" />
        <Button variant="outline" class="workbench-list-toggle" :aria-expanded="filtersOpen" data-list-filters @click="filtersOpen = !filtersOpen">
          {{ activeFilters ? t('overview.lists.filtersCount', { count: activeFilters }) : t('overview.lists.filters') }}
        </Button>
        <OptionSelect class="workbench-list-filter" :model-value="query.range" :options="rangeOptions" :label="t('overview.lists.range.label')"
          data-list-range @update:model-value="update({ range: $event as ListQuery['range'] })" />
        <OptionCombobox class="workbench-list-filter" multiple :model-value="query.projects" :options="projectOptions"
          :label="t('overview.lists.project.label')" :placeholder="t('overview.lists.project.all')" :max-chips="1" data-list-project
          @update:model-value="update({ projects: $event })" />
        <OptionCombobox class="workbench-list-filter" multiple :model-value="query.flas" :options="flaOptions"
          :label="t('overview.lists.fla.label')" :placeholder="t('overview.lists.fla.all')" :max-chips="1" data-list-fla
          @update:model-value="update({ flas: $event })" />
        <OptionCombobox class="workbench-list-filter" multiple :searchable="false" :model-value="query.kinds" :options="kindOptions"
          :label="kindLabel" :placeholder="kindAll" :max-chips="1" data-list-kind @update:model-value="update({ kinds: $event })" />
        <OptionSelect class="workbench-list-filter" :model-value="query.sort" :options="sortOptions" :label="t('overview.lists.sort.label')"
          data-list-sort @update:model-value="update({ sort: $event as ListQuery['sort'] })" />
        <span class="workbench-list-count" role="status">
          <GrowthLoading v-if="pages.loading.value && rows.length" variant="inline" :label="t('overview.lists.refreshing', { list: listTitle })" />
          <template v-else-if="pages.total.value !== null && rows.length">{{ t('overview.lists.count', { count: pages.total.value }) }}</template>
        </span>
      </div>

      <UiNotice v-if="pages.error.value" tone="error" data-list-error>
        {{ t('overview.lists.failed', { list: listTitle }) }}
        <template #actions><Button size="sm" variant="ghost" @click="pages.reload()">{{ t('overview.lists.retry') }}</Button></template>
      </UiNotice>
      <GrowthLoading v-if="firstRead" variant="compact" :label="t('overview.lists.loading', { list: listTitle })" />
      <p v-else-if="!rows.length && filtered && !pages.loading.value && !pages.error.value" class="workbench-list-none" data-list-none>
        {{ t('overview.lists.none') }}
        <Button variant="ghost" size="sm" @click="clearFilters">{{ t('overview.lists.clear') }}</Button>
      </p>
      <VirtualDirectoryList v-if="rows.length" class="workbench-list-rows" :items="rows" :row-height="isNotices ? ROW_HEIGHT.notice : ROW_HEIGHT.task"
        :label="listTitle" :item-key="row => row.key" :reset-key="source?.key" @near-end="pages.more()">
        <template #default="{ item }">
          <NoticeRow v-if="item.notice" :item="item.notice" class="workbench-list-notice" />
          <TaskListRow v-else-if="item.task" :task="item.task" :done="list === 'done'" :title="overviewTaskTitle(item.task) || t('overview.missing.taskTitle')"
            :meta="taskMeta(item.task)" :time="formatTime(list === 'done' ? item.task.completedAt ?? item.task.updatedAt : item.task.updatedAt)"
            :status-label="statusLabel(item.task.status)" />
        </template>
        <template #footer>
          <GrowthLoading v-if="pages.loadingMore.value" class="workbench-list-more" variant="inline" :label="t('overview.lists.loadingMore', { list: listTitle })" />
        </template>
      </VirtualDirectoryList>
    </div>
  </section>
</template>

<style scoped>
/* The page fills the window and the list scrolls inside its card, so the card
   the workbench grows from keeps one frame (the shared-element morph). The card
   ends above the floating dock, as the workbench stage does. */
.workbench-list-view { display: flex; flex-direction: column; gap: 12px; overflow: hidden; padding-bottom: 96px !important; }
.workbench-list-card { display: flex; flex: 1; flex-direction: column; gap: 10px; min-height: 0; padding-bottom: 6px; }
.workbench-list-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
.workbench-list-search { flex: 1 1 200px; min-width: 180px; max-width: 320px; }
.workbench-list-filter { width: 148px; }
.workbench-list-toggle { display: none; }
.workbench-list-count { margin-left: auto; color: var(--color-muted); font-size: var(--text-meta); font-variant-numeric: tabular-nums; white-space: nowrap; }
.workbench-list-rows { flex: 1; min-height: 0; margin: 0 -10px; }
/* Rows keep their right edge clear of the list's position capsule. */
.workbench-list-rows :deep(.virtual-directory-list__content) { padding-right: 28px; border-bottom: 1px solid var(--color-border); }
.workbench-list-notice { height: 100%; padding: 0 10px; }
.workbench-list-more { padding: 10px; }
.workbench-list-none { display: flex; align-items: center; gap: 8px; margin: 4px 0; color: var(--color-muted); font-size: var(--text-body); }
/* Phones: the search shares its line with 筛选, which unfolds the filters in two columns. */
@media (max-width: 860px) {
  .workbench-list-view { padding-bottom: calc(112px + env(safe-area-inset-bottom)) !important; }
  .workbench-list-search { flex: 1 1 calc(100% - 120px); max-width: none; min-width: 0; }
  .workbench-list-toggle { display: inline-flex; }
  .workbench-list-filter { width: calc(50% - 5px); }
  .is-folded .workbench-list-filter { display: none; }
  .workbench-list-count { flex-basis: 100%; margin-left: 0; }
}
</style>
