<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { OptionCombobox } from '@/components/ui/combobox'
import type { SelectOption } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useFocusReturn } from '@/composables/useFocusReturn'
import { useNearEnd } from '@/composables/useNearEnd'
import { useScrollRestoration } from '@/composables/useScrollRestoration'
import { occupationLabels, saveAgentOccupation } from '@/features/agent-profile/agent-occupation'
import { useAgentPinsState } from '@/features/agent-profile/agent-pins'
import { agentWorkbenchEntry, compareWorkbenchRows, type AgentWorkbenchEntry } from '@/features/agent-profile/agent-workbench'
import { groupAgentsByProject } from '@/features/agent-profile/directory-project-groups'
import { copyFlaMention } from '@/features/agent-profile/copy-mention'
import { agentDisplayName, agentProfilePath, agentResponsibility, fuzzyMatch, profileProjectIds } from '@/features/agent-profile/profile-model'
import { useAgentRosterPages } from '@/features/agent-profile/useAgentRosterPages'
import { useAgentWorkSummary } from '@/features/agent-profile/useAgentWorkSummary'
import { useStableOrder } from '@/features/agent-profile/useStableOrder'
import { workbenchStatusDetail } from '@/features/agent-profile/workbench-status-text'
import { useOccupationCatalog } from '@/features/occupations/occupation-catalog'
import ProjectAgentFirstTask from '@/features/project-agents/ProjectAgentFirstTask.vue'
import { isFormalProject, projectDisplayName } from '@/features/projects/project-origin'
import { currentLocale, t } from '@/i18n'
import { formatRelativeTime } from '@/lib/relative-time'
import { useConsoleStore } from '@/stores/console'
import type { ProjectAgentRecord } from '@/types'
import { UiIcon, UiNotice, UiSegmented } from '@/ui'
import FlaRow from './FlaRow.vue'
import { FLA_GROUP_ORDER, flaGroup, groupFlas, groupFlasByScope, type FlaGroupKey } from './fla-groups'
import { useFlaLayout, type FlaLayout } from './fla-layout'
import { lacksOccupation, suggestedOccupation } from './occupation-backfill'
import { usePageRefresh } from '@/layouts/page-refresh'

// FLAs (重写, direction A): every FLA as cards or one dense list, grouped by
// team (the FLAs working together on a project, then the global ones), by
// status (what needs the person first) or by project. Switched-off FLAs stay
// out of sight until the person asks for them (11-03). A card or row opens
// the FLA's page; right-click pins it or copies #FLA. Search, grouping and
// filters live in the URL, so Back returns to the same view; the layout is
// kept per browser.
type View = 'team' | 'work' | 'projects'
const VIEWS: readonly View[] = ['team', 'work', 'projects']
const viewOf = (value: unknown): View => (value === 'work' || value === 'projects' ? value : 'team')
const store = useConsoleStore()
const route = useRoute()
const router = useRouter()
const space = computed(() => store.activePersonalSpace?.id ?? '')
useOccupationCatalog(space)
const pins = useAgentPinsState(space)
const work = useAgentWorkSummary(space)
// Every member status: switched-off FLAs are read too, and shown on request.
const roster = useAgentRosterPages(space, ref('all'))
const agents = roster.agents

const queryText = (value: unknown) => (typeof value === 'string' ? value : '')
const queryList = (value: unknown) => queryText(value).split(',').map(item => item.trim()).filter(Boolean)
const flaGroupKey = (value: string): value is FlaGroupKey => (FLA_GROUP_ORDER as readonly string[]).includes(value)
const search = ref(queryText(route.query.q))
const view = ref<View>(viewOf(route.query.view))
const showInactive = ref(route.query.inactive === '1')
const { layout, set: setLayout } = useFlaLayout()
const layoutOptions = computed(() => (['cards', 'list'] as const).map(value => ({
  value, label: t(`flas.layout.${value}`), icon: value === 'cards' ? 'grid' as const : 'list' as const, iconOnly: true,
})))
// A filter depends on the grouping: statuses for 按团队 and 按状态, projects for 按项目.
// Both live in the URL, so Back returns to the same filtered view.
const statusFilter = ref<FlaGroupKey[]>(queryList(route.query.status).filter(flaGroupKey))
const projectFilter = ref<string[]>(queryList(route.query.project))
watch(() => route.query, (query) => {
  search.value = queryText(query.q)
  view.value = viewOf(query.view)
  showInactive.value = query.inactive === '1'
  statusFilter.value = queryList(query.status).filter(flaGroupKey)
  projectFilter.value = queryList(query.project)
})
watch([search, view, statusFilter, projectFilter, showInactive], ([q, v, status, project, inactive]) => {
  const next = { ...route.query, q: q.trim() ? q : undefined, view: v === 'team' ? undefined : v, status: status.length ? status.join(',') : undefined,
    project: project.length ? project.join(',') : undefined, inactive: inactive ? '1' : undefined }
  if (queryText(route.query.q) === (next.q ?? '') && (route.query.view ?? undefined) === next.view && (route.query.inactive ?? undefined) === next.inactive
    && queryList(route.query.status).join(',') === (next.status ?? '') && queryList(route.query.project).join(',') === (next.project ?? '')) return
  void router.replace({ query: next })
})

const projects = computed(() => (store.state?.personalProjects ?? []).filter(project => project.personal_space_id === space.value))
const formalProjectIds = computed(() => projects.value.filter(isFormalProject).map(project => project.project_id))
const projectNames = computed<Record<string, string>>(() => Object.fromEntries(projects.value.map(project => [project.project_id, projectDisplayName(project)])))
// The filters shown beside the grouping switch: the status groups the page
// renders (按团队, 按状态), or the formal projects it groups by (按项目).
// Switched-off FLAs have their own switch beside them instead of a status.
const statusFilterOptions = computed<SelectOption[]>(() => FLA_GROUP_ORDER.filter(key => key !== 'inactive')
  .map(key => ({ value: key, label: t(`flas.groups.${key}`) })))
const projectFilterOptions = computed<SelectOption[]>(() => {
  const names = new Map<string, number>()
  for (const id of formalProjectIds.value) {
    const name = projectNames.value[id] ?? id
    names.set(name, (names.get(name) ?? 0) + 1)
  }
  return formalProjectIds.value.map(id => {
    const name = projectNames.value[id] ?? id
    return { value: id, label: name, ...((names.get(name) ?? 0) > 1 ? { meta: id } : {}) }
  })
})

const entries = computed<Record<string, AgentWorkbenchEntry>>(() => Object.fromEntries(agents.value.map(agent => [
  agent.agentId,
  agentWorkbenchEntry(agent, { summary: work.summaries.value[agent.agentId], summaryState: work.state.value, tasks: work.tasks.value }),
])))
const byId = computed(() => new Map(agents.value.map(agent => [agent.agentId, agent])))
const groupOf = (agent: ProjectAgentRecord): FlaGroupKey => flaGroup(agent.profile.status, entries.value[agent.agentId]?.status)
const inactiveCount = computed(() => agents.value.filter(agent => groupOf(agent) === 'inactive').length)

// Older FLAs without an occupation (11-03): one click gives each the occupation
// its own words point to (occupation-backfill.ts). Only those with a guess are
// offered; the rest stay for the person to set on their page. Each is an
// ordinary occupation change, so it can be changed back there.
const occupationFills = computed(() => agents.value.filter(lacksOccupation)
  .map(agent => ({ agent, role: suggestedOccupation(agent) }))
  .filter((fill): fill is { agent: ProjectAgentRecord; role: string } => Boolean(fill.role)))
const fillingOccupations = ref(false)
async function fillOccupations() {
  if (fillingOccupations.value) return
  fillingOccupations.value = true
  const fills = occupationFills.value
  const unknown = agents.value.filter(lacksOccupation).length - fills.length
  let done = 0
  try {
    // One at a time: a few dozen small writes, never a burst at the provider.
    for (const { agent, role } of fills) {
      try {
        await saveAgentOccupation(space.value, agent.agentId, { role, tags: agent.occupation?.tags ?? [] })
        done += 1
      } catch {
        // Counted below; the FLA keeps its empty occupation and the offer stays.
      }
    }
    await roster.reload()
  } finally {
    fillingOccupations.value = false
  }
  const failed = fills.length - done
  if (done) store.notify([t('flas.occupations.done', { count: done }), unknown ? t('flas.occupations.unknown', { count: unknown }) : ''].filter(Boolean).join(' '))
  if (failed) store.reportError(new Error(t('flas.occupations.failed', { count: failed })))
}

// Rows keep the order the person first saw; a change of work offers a reorder instead of moving rows under the pointer.
const busy = computed(() => (roster.loading.value && !agents.value.length) || work.loading.value || store.runtimeStatus === 'loading')
const freshOrder = computed(() => agents.value
  .map(agent => ({ agent, entry: entries.value[agent.agentId]!, name: agentDisplayName(agent) }))
  .sort(compareWorkbenchRows)
  .map(row => row.agent.agentId))
const stable = useStableOrder(freshOrder, computed(() => !busy.value), space)
const reorderAvailable = computed(() => !busy.value && stable.order.value.some((id, index) => id !== freshOrder.value[index]))

const matches = (agent: ProjectAgentRecord) => {
  if (search.value.trim() && !fuzzyMatch([
    agentDisplayName(agent),
    agent.employeeNumber ? `FLA ${agent.employeeNumber}` : '',
    agentResponsibility(agent),
    ...agent.profile.capabilities,
    ...occupationLabels(agent.occupation),
    entries.value[agent.agentId]?.title ?? '',
    ...profileProjectIds(agent).map(id => projectNames.value[id] ?? ''),
  ].join(' '), search.value)) return false
  const group = groupOf(agent)
  if (group === 'inactive') return showInactive.value
  if (view.value !== 'projects' && statusFilter.value.length && !statusFilter.value.includes(group)) return false
  if (view.value === 'projects' && projectFilter.value.length && !profileProjectIds(agent).some(id => projectFilter.value.includes(id))) return false
  return true
}
const rows = computed(() => stable.order.value.map(id => byId.value.get(id)).filter((agent): agent is ProjectAgentRecord => Boolean(agent) && matches(agent!)))

const formalIds = computed(() => new Set(formalProjectIds.value))
const sections = computed(() => {
  if (view.value === 'team') {
    return groupFlasByScope(rows.value, agent => profileProjectIds(agent).some(id => formalIds.value.has(id)))
      .map(group => ({ key: group.key, label: t(`flas.scopes.${group.key}`), rows: group.rows }))
  }
  if (view.value === 'work') {
    return groupFlas(rows.value, groupOf).map(group => ({ key: group.key, label: t(`flas.groups.${group.key}`), rows: group.rows }))
  }
  const ids = rows.value.map(agent => agent.agentId)
  const grouped = groupAgentsByProject(ids, id => profileProjectIds(byId.value.get(id)!), id => entries.value[id]?.status, formalProjectIds.value)
    .map(group => ({ key: group.projectId, label: projectNames.value[group.projectId] ?? group.projectId, rows: group.agentIds.map(id => byId.value.get(id)!) }))
  // A project filter shows only the chosen projects' groups, even for an FLA that also works elsewhere.
  if (projectFilter.value.length) return grouped.filter(group => projectFilter.value.includes(group.key))
  const unassigned = rows.value.filter(agent => !profileProjectIds(agent).some(id => formalIds.value.has(id)))
  return unassigned.length ? [...grouped, { key: '__none', label: t('flas.unassigned'), rows: unassigned }] : grouped
})

function meta(agent: ProjectAgentRecord) {
  return [...occupationLabels(agent.occupation).slice(0, 2), agent.employeeNumber ? `FLA ${agent.employeeNumber}` : ''].filter(Boolean).join(' · ')
}
// Under 按状态 the heading already says free, not reported or switched off;
// those rows say what the FLA is for instead of repeating it. Elsewhere a
// switched-off FLA says so first.
function workLine(agent: ProjectAgentRecord) {
  const group = groupOf(agent)
  const entry = entries.value[agent.agentId]
  if (group === 'inactive' && view.value !== 'work') return { group, text: `${t('flas.inactive.tag')} · ${agentResponsibility(agent)}` }
  if (group === 'inactive') return { group, text: agentResponsibility(agent) }
  // The line says what the FLA is doing now; what it is for comes after, never in its place.
  if (group === 'unknown' || group === 'idle') return { group, text: `${t(`flas.now.${group}`)} · ${agentResponsibility(agent)}` }
  if (group === 'working') return { group, text: entry?.title ? t('flas.now.working', { title: entry.title }) : t(`agentRedesign.workStatus.${entry!.status}`) }
  const detail = workbenchStatusDetail(entry) ?? entry?.title
  return { group, text: [t(`agentRedesign.workStatus.${entry!.status}`), detail].filter(Boolean).join(' · ') }
}
function lastUpdate(agent: ProjectAgentRecord) {
  const group = groupOf(agent)
  return group === 'working' || group === 'attention' ? formatRelativeTime(entries.value[agent.agentId]?.lastUpdateAt, currentLocale()) || null : null
}
const profilePath = (agent: ProjectAgentRecord) => agentProfilePath(space.value, agent.agentId)

const copyMention = (agent: ProjectAgentRecord) => copyFlaMention(agentDisplayName(agent), store)

// Reading: the whole list arrives in pages; the next page is read as the end comes into view.
const scroller = ref<HTMLElement | null>(null)
const rosterEnd = ref<HTMLElement | null>(null)
const nearEnd = useNearEnd(rosterEnd, scroller)
watch([nearEnd, roster.loading], ([near, loading]) => {
  if (near && !loading && !roster.complete.value && !roster.error.value) void roster.loadMore()
})
const firstLoading = computed(() => busy.value && !agents.value.length)
const loadFailed = computed(() => !agents.value.length && (Boolean(roster.error.value) || store.runtimeStatus === 'error'))
const noFlas = computed(() => !busy.value && roster.complete.value && !agents.value.length && !loadFailed.value)
const filtersActive = computed(() => (view.value === 'projects' ? projectFilter.value.length : statusFilter.value.length) > 0)
const noMatch = computed(() => (Boolean(search.value.trim()) || filtersActive.value) && roster.complete.value && agents.value.length > 0 && !rows.value.length)
const noMatchCause = computed(() => (search.value.trim() ? 'search' : 'filter'))
function clearFilters() {
  search.value = ''
  statusFilter.value = []
  projectFilter.value = []
}
const showFirstTask = computed(() => !busy.value && store.runtimeStatus === 'ready' && !formalProjectIds.value.length && !loadFailed.value)
function retry() {
  void roster.reload()
  void work.load()
}

const ready = computed(() => rows.value.length > 0)
useScrollRestoration(scroller, 'flas', ready)
const focusReturn = useFocusReturn(scroller, 'flas', ready)
function open(agent: ProjectAgentRecord) {
  focusReturn.remember(agent.agentId)
  void router.push(profilePath(agent))
}

onMounted(() => {
  if (store.runtimeStatus === 'idle') void store.refresh()
})
// Links from before the rewrite: a quick look (?item=<space>/<agent>) or ?agent= open the FLA's page.
watch([space, () => route.query.item, () => route.query.agent], ([spaceId, item, agent]) => {
  if (!spaceId) return
  const [itemSpace, itemAgent] = typeof item === 'string' ? item.split('/') : []
  const target = typeof agent === 'string' ? agent : itemSpace === spaceId ? itemAgent : ''
  if (target && typeof route.query.task === 'string') void router.replace({ path: '/project-agents/manage', query: route.query })
  else if (target) void router.replace(agentProfilePath(spaceId, target))
}, { immediate: true })
// The top bar's 刷新 reads the roster and the work again; the rows stay until the first page replaces them.
usePageRefresh(() => Promise.all([roster.reload(), work.load()]))
</script>

<template>
  <section ref="scroller" class="view flas-view" :aria-label="t('routes.projectAgents.title')">
    <div class="flas">
      <header class="flas-bar">
        <label class="flas-search">
          <UiIcon name="search" :size="16" />
          <span class="ui-sr-only">{{ t('flas.search') }}</span>
          <input v-model="search" type="search" maxlength="160" :placeholder="t('flas.search')" data-flas-search @keydown.esc="search = ''" />
        </label>
        <div class="flas-switch" role="radiogroup" :aria-label="t('flas.view.label')">
          <button v-for="option in VIEWS" :key="option" type="button" role="radio" :aria-checked="view === option"
            :data-flas-view="option" @click="view = option">{{ t(`flas.view.${option}`) }}</button>
        </div>
        <OptionCombobox v-if="view !== 'projects'" v-model="statusFilter" class="flas-filter" multiple :searchable="false"
          :options="statusFilterOptions" :label="t('flas.filter.status')" :placeholder="t('flas.filter.allStatus')" />
        <OptionCombobox v-else v-model="projectFilter" class="flas-filter" multiple
          :options="projectFilterOptions" :label="t('flas.filter.project')" :placeholder="t('flas.filter.allProjects')" />
        <label class="flas-inactive">
          <Switch v-model="showInactive" data-flas-inactive />
          <span>{{ t('flas.inactive.show') }}</span>
          <span class="ui-num">{{ inactiveCount }}</span>
        </label>
        <span class="flas-count" role="status">
          <GrowthLoading v-if="busy && agents.length" variant="inline" :label="t('flas.refreshing')" />
          <template v-else-if="agents.length">{{ t(roster.complete.value ? 'flas.count' : 'flas.countPartial', { count: agents.length }) }}</template>
        </span>
        <UiSegmented :model-value="layout" :options="layoutOptions" :label="t('flas.layout.label')" data-flas-layout
          @update:model-value="setLayout($event as FlaLayout)" />
      </header>

      <UiNotice v-if="pins.error.value" tone="error">
        {{ pins.error.value }}
        <template #actions><Button size="sm" variant="ghost" @click="pins.load({ force: true })">{{ t('flas.retry') }}</Button></template>
      </UiNotice>
      <UiNotice v-if="work.error.value" tone="warning" data-flas-work-error>
        {{ t('flas.workError') }}
        <template #actions><Button size="sm" variant="ghost" @click="work.load()">{{ t('flas.retry') }}</Button></template>
      </UiNotice>
      <UiNotice v-if="reorderAvailable" tone="info" data-flas-reorder>
        {{ t('flas.reorder.hint') }}
        <template #actions><Button size="sm" variant="ghost" @click="stable.apply()">{{ t('flas.reorder.apply') }}</Button></template>
      </UiNotice>
      <UiNotice v-if="occupationFills.length && !busy" tone="info" data-flas-occupations>
        {{ t('flas.occupations.offer', { count: occupationFills.length }) }}
        <template #actions>
          <Button size="sm" variant="ghost" :loading="fillingOccupations" :loading-label="t('flas.occupations.filling')"
            data-flas-occupations-fill @click="fillOccupations">{{ t('flas.occupations.fill') }}</Button>
        </template>
      </UiNotice>
      <ProjectAgentFirstTask v-if="showFirstTask" :personal-space-id="space" />

      <GrowthLoading v-if="firstLoading" :label="t('flas.loading')" />
      <div v-else-if="loadFailed" class="flas-empty" role="alert">
        <p>{{ roster.error.value || t('flas.loadError') }}</p>
        <Button size="sm" variant="outline" @click="retry">{{ t('flas.retry') }}</Button>
      </div>
      <p v-else-if="noFlas" class="flas-empty">{{ t('flas.empty') }}</p>
      <div v-else-if="noMatch" class="flas-empty" data-flas-no-match>
        <p>{{ noMatchCause === 'search' ? t('flas.noMatch', { query: search.trim() }) : t('flas.filterEmpty') }}</p>
        <Button size="sm" variant="ghost" @click="noMatchCause === 'search' ? (search = '') : clearFilters()">
          {{ noMatchCause === 'search' ? t('flas.clearSearch') : t('flas.clearFilters') }}
        </Button>
      </div>

      <section v-for="section in sections" :key="section.key" class="flas-group" :aria-labelledby="`flas-group-${section.key}`" :data-flas-group="section.key">
        <h2 :id="`flas-group-${section.key}`" class="flas-group-label">{{ section.label }} <span class="ui-num">{{ section.rows.length }}</span></h2>
        <ul class="flas-list" :data-layout="layout">
          <FlaRow v-for="agent in section.rows" :key="agent.agentId" :layout="layout" :agent-id="agent.agentId" :name="agentDisplayName(agent)" :meta="meta(agent)"
            :work="workLine(agent)" :time="lastUpdate(agent)" :to="profilePath(agent)"
            :pinned="pins.agentIds.value.includes(agent.agentId)" :pin-pending="pins.savingAgentId.value === agent.agentId"
            @click="focusReturn.remember(agent.agentId)" @open="open(agent)" @copy="copyMention(agent)" @toggle-pin="pins.setPinned(agent.agentId, $event)" />
        </ul>
      </section>

      <div v-if="agents.length && !roster.complete.value" ref="rosterEnd" class="flas-more">
        <GrowthLoading v-if="roster.loading.value" variant="inline" :label="t('flas.more.loading')" />
        <template v-else-if="roster.error.value">
          <span role="alert">{{ t('flas.more.failed') }}</span>
          <Button size="sm" variant="ghost" data-flas-more-retry @click="roster.loadMore()">{{ t('flas.retry') }}</Button>
        </template>
        <Button v-else size="sm" variant="ghost" data-flas-more @click="roster.loadMore()">{{ t('flas.more.load') }}</Button>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Inset grouped lists on the page's full width: a wider window shows more of each FLA's current work. */
.flas { display: flex; flex-direction: column; gap: 28px; width: 100%; }
.flas-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; }
.flas-search {
  display: flex; flex: 0 1 360px; align-items: center; gap: 8px; min-width: 200px; height: var(--control-height-md); padding: 0 14px;
  border-radius: var(--radius-pill); color: var(--color-faint); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border);
  transition: box-shadow var(--motion-fast);
}
.flas-search:focus-within { box-shadow: 0 0 0 1px var(--color-border-strong), 0 0 0 4px var(--color-surface-hover); }
.flas-search input { flex: 1; min-width: 0; min-height: 0; padding: 0; border: 0; outline: 0; box-shadow: none; color: var(--color-ink); background: transparent; font: inherit; font-size: var(--text-body); }
.flas-switch { display: inline-flex; padding: 3px; border-radius: var(--radius-pill); background: var(--color-surface-hover); }
.flas-switch button {
  height: calc(var(--control-height-md) - 6px); padding: 0 14px; border: 0; border-radius: var(--radius-pill); color: var(--color-muted); background: transparent;
  font: inherit; font-size: var(--text-control); font-weight: var(--weight-medium); cursor: pointer; transition: color var(--motion-fast), background var(--motion-fast), box-shadow var(--motion-fast);
}
.flas-switch button[aria-checked="true"] { color: var(--color-ink); background: var(--color-surface); box-shadow: var(--shadow-xs); }
.flas-switch button:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 1px; }
.flas-filter { width: 220px; }
.flas-inactive { display: inline-flex; align-items: center; gap: 8px; color: var(--color-muted); font-size: var(--text-control); white-space: nowrap; cursor: pointer; user-select: none; }
.flas-inactive .ui-num { color: var(--color-faint); }
.flas-count { margin-left: auto; color: var(--color-muted); font-size: var(--text-control); font-variant-numeric: tabular-nums; }
.flas-group { display: grid; gap: 8px; }
.flas-group-label { display: flex; align-items: baseline; gap: 8px; margin: 0; padding-inline: 18px; color: var(--color-ink-soft); font-size: var(--text-control); font-weight: var(--weight-strong); }
.flas-group-label .ui-num { color: var(--color-faint); font-weight: var(--weight-medium); }
/* An inset grouped list: one white surface, rows split by hairlines that start after the portrait. */
.flas-list { margin: 0; padding: 0; list-style: none; border-radius: var(--radius-card); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border); }
.flas-list > :first-child :deep(.fla-row) { border-start-start-radius: var(--radius-card); border-start-end-radius: var(--radius-card); }
.flas-list > :last-child :deep(.fla-row) { border-end-start-radius: var(--radius-card); border-end-end-radius: var(--radius-card); }
/* Cards: each FLA its own tile, as many across as the width allows. */
.flas-list[data-layout="cards"] { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap: 12px; border-radius: 0; background: none; box-shadow: none; }
.flas-empty { display: grid; justify-items: center; gap: 12px; margin: 0; padding: 56px 24px; color: var(--color-muted); text-align: center; }
.flas-empty p { margin: 0; }
.flas-more { display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--color-muted); font-size: var(--text-control); }
@media (max-width: 640px) {
  .flas-search { flex-basis: 100%; }
  .flas-count { margin-left: 0; }
}
</style>
