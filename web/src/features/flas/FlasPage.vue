<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { useFocusReturn } from '@/composables/useFocusReturn'
import { useNearEnd } from '@/composables/useNearEnd'
import { useScrollRestoration } from '@/composables/useScrollRestoration'
import { occupationLabels } from '@/features/agent-profile/agent-occupation'
import { useAgentPinsState } from '@/features/agent-profile/agent-pins'
import { agentWorkbenchEntry, compareWorkbenchRows, type AgentWorkbenchEntry } from '@/features/agent-profile/agent-workbench'
import { groupAgentsByProject } from '@/features/agent-profile/directory-project-groups'
import { clipboardText, flaMention } from '@/features/agent-profile/fla-mention'
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
import { UiIcon, UiNotice } from '@/ui'
import FlaRow from './FlaRow.vue'
import { flaGroup, groupFlas, type FlaGroupKey } from './fla-groups'

// FLAs (重写, direction A): every FLA in one grouped list, what needs the
// person first. A row opens the FLA's page; right-click pins it or copies
// #FLA. Search and grouping live in the URL, so Back returns to the same view.
type View = 'work' | 'projects'
const store = useConsoleStore()
const route = useRoute()
const router = useRouter()
const space = computed(() => store.activePersonalSpace?.id ?? '')
useOccupationCatalog(space)
const pins = useAgentPinsState(space)
const work = useAgentWorkSummary(space)
// Every member status: switched-off FLAs are grouped at the end, not hidden.
const roster = useAgentRosterPages(space, ref('all'))
const agents = roster.agents

const queryText = (value: unknown) => (typeof value === 'string' ? value : '')
const search = ref(queryText(route.query.q))
const view = ref<View>(route.query.view === 'projects' ? 'projects' : 'work')
watch(() => route.query, (query) => {
  search.value = queryText(query.q)
  view.value = query.view === 'projects' ? 'projects' : 'work'
})
watch([search, view], ([q, v]) => {
  const next = { ...route.query, q: q.trim() ? q : undefined, view: v === 'projects' ? v : undefined }
  if (queryText(route.query.q) === (next.q ?? '') && (route.query.view ?? undefined) === next.view) return
  void router.replace({ query: next })
})

const projects = computed(() => (store.state?.personalProjects ?? []).filter(project => project.personal_space_id === space.value))
const formalProjectIds = computed(() => projects.value.filter(isFormalProject).map(project => project.project_id))
const projectNames = computed<Record<string, string>>(() => Object.fromEntries(projects.value.map(project => [project.project_id, projectDisplayName(project)])))

const entries = computed<Record<string, AgentWorkbenchEntry>>(() => Object.fromEntries(agents.value.map(agent => [
  agent.agentId,
  agentWorkbenchEntry(agent, { summary: work.summaries.value[agent.agentId], summaryState: work.state.value, tasks: work.tasks.value }),
])))
const byId = computed(() => new Map(agents.value.map(agent => [agent.agentId, agent])))
const groupOf = (agent: ProjectAgentRecord): FlaGroupKey => flaGroup(agent.profile.status, entries.value[agent.agentId]?.status)

// Rows keep the order the person first saw; a change of work offers a reorder instead of moving rows under the pointer.
const busy = computed(() => (roster.loading.value && !agents.value.length) || work.loading.value || store.runtimeStatus === 'loading')
const freshOrder = computed(() => agents.value
  .map(agent => ({ agent, entry: entries.value[agent.agentId]!, name: agentDisplayName(agent) }))
  .sort(compareWorkbenchRows)
  .map(row => row.agent.agentId))
const stable = useStableOrder(freshOrder, computed(() => !busy.value), space)
const reorderAvailable = computed(() => !busy.value && stable.order.value.some((id, index) => id !== freshOrder.value[index]))

const matches = (agent: ProjectAgentRecord) => !search.value.trim() || fuzzyMatch([
  agentDisplayName(agent),
  agent.employeeNumber ? `FLA ${agent.employeeNumber}` : '',
  agentResponsibility(agent),
  ...agent.profile.capabilities,
  ...occupationLabels(agent.occupation),
  entries.value[agent.agentId]?.title ?? '',
  ...profileProjectIds(agent).map(id => projectNames.value[id] ?? ''),
].join(' '), search.value)
const rows = computed(() => stable.order.value.map(id => byId.value.get(id)).filter((agent): agent is ProjectAgentRecord => Boolean(agent) && matches(agent!)))

const sections = computed(() => {
  if (view.value === 'work') {
    return groupFlas(rows.value, groupOf).map(group => ({ key: group.key, label: t(`flas.groups.${group.key}`), rows: group.rows }))
  }
  const ids = rows.value.map(agent => agent.agentId)
  const grouped = groupAgentsByProject(ids, id => profileProjectIds(byId.value.get(id)!), id => entries.value[id]?.status, formalProjectIds.value)
    .map(group => ({ key: group.projectId, label: projectNames.value[group.projectId] ?? group.projectId, rows: group.agentIds.map(id => byId.value.get(id)!) }))
  const formal = new Set(formalProjectIds.value)
  const unassigned = rows.value.filter(agent => !profileProjectIds(agent).some(id => formal.has(id)))
  return unassigned.length ? [...grouped, { key: '__none', label: t('flas.unassigned'), rows: unassigned }] : grouped
})

function meta(agent: ProjectAgentRecord) {
  return [...occupationLabels(agent.occupation).slice(0, 2), agent.employeeNumber ? `FLA ${agent.employeeNumber}` : ''].filter(Boolean).join(' · ')
}
// The group heading already says free, not reported or switched off; those
// rows say what the FLA is for instead of repeating it.
function workLine(agent: ProjectAgentRecord) {
  const group = groupOf(agent)
  const entry = entries.value[agent.agentId]
  if (group === 'inactive' || group === 'unknown' || group === 'idle') return { group, text: agentResponsibility(agent) }
  if (group === 'working') return { group, text: entry?.title ?? t(`agentRedesign.workStatus.${entry!.status}`) }
  const detail = workbenchStatusDetail(entry) ?? entry?.title
  return { group, text: [t(`agentRedesign.workStatus.${entry!.status}`), detail].filter(Boolean).join(' · ') }
}
function lastUpdate(agent: ProjectAgentRecord) {
  const group = groupOf(agent)
  return group === 'working' || group === 'attention' ? formatRelativeTime(entries.value[agent.agentId]?.lastUpdateAt, currentLocale()) || null : null
}
const profilePath = (agent: ProjectAgentRecord) => agentProfilePath(space.value, agent.agentId)

async function copyMention(agent: ProjectAgentRecord) {
  const mention = flaMention(agentDisplayName(agent))
  try {
    const clipboard = globalThis.navigator?.clipboard
    if (!clipboard?.writeText) throw new Error('clipboard unavailable')
    await clipboard.writeText(clipboardText(mention))
    store.notify(t('flas.menu.copied', { mention }))
  } catch {
    store.reportError(new Error(t('flas.menu.copyFailed')))
  }
}

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
const noMatch = computed(() => Boolean(search.value.trim()) && roster.complete.value && agents.value.length > 0 && !rows.value.length)
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
          <button v-for="option in (['work', 'projects'] as const)" :key="option" type="button" role="radio" :aria-checked="view === option"
            :data-flas-view="option" @click="view = option">{{ t(`flas.view.${option}`) }}</button>
        </div>
        <span class="flas-count" role="status">
          <GrowthLoading v-if="busy && agents.length" variant="inline" :label="t('flas.refreshing')" />
          <template v-else-if="agents.length">{{ t(roster.complete.value ? 'flas.count' : 'flas.countPartial', { count: agents.length }) }}</template>
        </span>
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
      <ProjectAgentFirstTask v-if="showFirstTask" :personal-space-id="space" />

      <GrowthLoading v-if="firstLoading" :label="t('flas.loading')" />
      <div v-else-if="loadFailed" class="flas-empty" role="alert">
        <p>{{ roster.error.value || t('flas.loadError') }}</p>
        <Button size="sm" variant="outline" @click="retry">{{ t('flas.retry') }}</Button>
      </div>
      <p v-else-if="noFlas" class="flas-empty">{{ t('flas.empty') }}</p>
      <div v-else-if="noMatch" class="flas-empty" data-flas-no-match>
        <p>{{ t('flas.noMatch', { query: search.trim() }) }}</p>
        <Button size="sm" variant="ghost" @click="search = ''">{{ t('flas.clearSearch') }}</Button>
      </div>

      <section v-for="section in sections" :key="section.key" class="flas-group" :aria-labelledby="`flas-group-${section.key}`" :data-flas-group="section.key">
        <h2 :id="`flas-group-${section.key}`" class="flas-group-label">{{ section.label }} <span class="ui-num">{{ section.rows.length }}</span></h2>
        <ul class="flas-list">
          <FlaRow v-for="agent in section.rows" :key="agent.agentId" :agent-id="agent.agentId" :name="agentDisplayName(agent)" :meta="meta(agent)"
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
.flas-search input { flex: 1; min-width: 0; min-height: 0; padding: 0; border: 0; outline: 0; color: var(--color-ink); background: transparent; font: inherit; font-size: var(--text-body); }
.flas-switch { display: inline-flex; padding: 3px; border-radius: var(--radius-pill); background: var(--color-surface-hover); }
.flas-switch button {
  height: calc(var(--control-height-md) - 6px); padding: 0 14px; border: 0; border-radius: var(--radius-pill); color: var(--color-muted); background: transparent;
  font: inherit; font-size: var(--text-control); font-weight: var(--weight-medium); cursor: pointer; transition: color var(--motion-fast), background var(--motion-fast), box-shadow var(--motion-fast);
}
.flas-switch button[aria-checked="true"] { color: var(--color-ink); background: var(--color-surface); box-shadow: var(--shadow-xs); }
.flas-switch button:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 1px; }
.flas-count { margin-left: auto; color: var(--color-muted); font-size: var(--text-control); font-variant-numeric: tabular-nums; }
.flas-group { display: grid; gap: 8px; }
.flas-group-label { display: flex; align-items: baseline; gap: 8px; margin: 0; padding-inline: 18px; color: var(--color-ink-soft); font-size: var(--text-control); font-weight: var(--weight-strong); }
.flas-group-label .ui-num { color: var(--color-faint); font-weight: var(--weight-medium); }
/* An inset grouped list: one white surface, rows split by hairlines that start after the portrait. */
.flas-list { margin: 0; padding: 0; list-style: none; border-radius: var(--radius-card); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border); }
.flas-list > :first-child :deep(.fla-row) { border-start-start-radius: var(--radius-card); border-start-end-radius: var(--radius-card); }
.flas-list > :last-child :deep(.fla-row) { border-end-start-radius: var(--radius-card); border-end-end-radius: var(--radius-card); }
.flas-empty { display: grid; justify-items: center; gap: 12px; margin: 0; padding: 56px 24px; color: var(--color-muted); text-align: center; }
.flas-empty p { margin: 0; }
.flas-more { display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--color-muted); font-size: var(--text-control); }
@media (max-width: 640px) {
  .flas-search { flex-basis: 100%; }
  .flas-count { margin-left: 0; }
}
</style>
