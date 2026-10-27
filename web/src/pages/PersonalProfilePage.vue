<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { getJson, postJson } from '@/api/client'
import { readPersonalProfileGraph } from '@/api/personal-profile-graph'
import GrowthLoading from '@/components/GrowthLoading.vue'
import UiSelect from '@/ui/UiSelect.vue'
import { UiEmpty, UiIconButton, UiSegmented, UiStatRow, UiToolbar, type UiStat } from '@/ui'
import { useMinimumLoadingDisplay } from '@/composables/useMinimumLoadingDisplay'
import { reconcileKnowledgeWrites } from '@/features/knowledge/knowledge-write-lifecycle'
import KnowledgeConfirmDialog from '@/features/knowledge/KnowledgeConfirmDialog.vue'
import KnowledgePeek from '@/features/knowledge/KnowledgePeek.vue'
import { useKnowledgeItemPeek } from '@/features/knowledge/useKnowledgeItemPeek'
import KnowledgeEditDialog from '@/features/knowledge/KnowledgeEditDialog.vue'
import PreferenceConflictDialog from '@/features/preferences/PreferenceConflictDialog.vue'
import {
  detectPreferenceConflicts,
    preferenceValue,
  type PreferenceConflict,
  type PreferenceConflictRecord,
} from '@/features/preferences/preference-conflicts'
import {
  formatTime,
  knowledgeReviewState,
  latestItemValue,
  personalProfileItems,
  profileAspectLabel,
  reviewStateLabel,
  distinctSummary,
  preferenceListState,
  type PreferenceListState,
  knowledgeItemKey,
} from '@/features/knowledge/model'
import { currentLocale, t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { versionStatusLabel } from '@/features/knowledge-quick-edit/model'
import type { KnowledgeGraph, KnowledgeItem } from '@/types'

const store = useConsoleStore()
const graph = ref<KnowledgeGraph | null>(null)
const loading = ref(false)
const snapshotReady = ref(false)
const loadFailed = ref(false)
const takingLong = ref(false)
const readStatus = ref<number | null>(null)
const pageElement = ref<HTMLElement | null>(null)
let slowTimer: ReturnType<typeof setTimeout> | undefined
let deadlineTimer: ReturnType<typeof setTimeout> | undefined
const initialLoading = computed(() => loading.value && !graph.value)
const showInitialLoading = useMinimumLoadingDisplay(initialLoading)
const activeAspect = ref('all')
// ?aspect= keeps the dimension addressable, so the sidebar can open 品味,
// 个性 or 判断 directly and a reload keeps the choice.
const PROFILE_ASPECTS = ['taste', 'personality', 'judgment_preference']
// Embedded without a router (tests, previews) the filter stays local.
const route = useRoute() as ReturnType<typeof useRoute> | undefined
const router = useRouter() as ReturnType<typeof useRouter> | undefined
watch(() => route?.query.aspect, aspect => {
  activeAspect.value = typeof aspect === 'string' && PROFILE_ASPECTS.includes(aspect) ? aspect : 'all'
}, { immediate: true })
// The pending ?aspect= update, so a replacement opens on the URL that includes it.
let aspectSync: Promise<unknown> = Promise.resolve()
watch(activeAspect, aspect => {
  if (!route || !router) return
  const current = typeof route.query.aspect === 'string' ? route.query.aspect : 'all'
  if (current === aspect) return
  const query = { ...route.query }
  if (aspect === 'all') delete query.aspect
  else query.aspect = aspect
  aspectSync = router.replace({ query })
})
const activeScope = ref('all')
// 'all' lists what is current; history is its own group (rec#5 C8-1).
const activeReviewState = ref<'all' | PreferenceListState>('all')
const conflictsOnly = ref(false)
const confirmingItem = ref<KnowledgeItem | null>(null)
const editingItem = ref<KnowledgeItem | null>(null)
const activeConflict = ref<PreferenceConflict | null>(null)
const conflictRecords = ref<PreferenceConflictRecord[]>([])
const deferringConflictId = ref('')
const deferTakingLong = ref(false)
let loadVersion = 0
let loadController: AbortController | null = null

const items = computed(() => personalProfileItems(graph.value))
// The open preference is part of the URL (?item=<space>/<kind>:<id>); see useKnowledgeItemPeek.
const peek = useKnowledgeItemPeek({
  spaceId: computed(() => store.activePersonalSpace?.id),
  items,
  settled: computed(() => snapshotReady.value && !loading.value),
  root: pageElement,
})
const selectedItem = peek.item
// Set while a replacement opens: its filters change under the open quick look on purpose.
let replacing = false
const conflicts = computed(() =>
  detectPreferenceConflicts(items.value, conflictRecords.value),
)
const conflictingIds = computed(
  () => new Set(conflicts.value.flatMap(({ left, right }) => [knowledgeItemKey(left), knowledgeItemKey(right)])),
)
const aiResolvedIds = computed(
  () => new Set(
    conflictRecords.value
      .filter(
        ({ status, resolved_by: resolvedBy }) =>
          status === 'resolved' && resolvedBy === 'agent',
      )
      .flatMap(record => [`${record.left_item_kind}:${record.left_item_id}`, `${record.right_item_kind}:${record.right_item_id}`]),
  ),
)
const visibleItems = computed(() =>
  items.value.filter(
    (item) =>
      matchesActiveFilters(item)
      && (activeReviewState.value === 'all'
        ? preferenceListState(item) !== 'historical'
        : preferenceListState(item) === activeReviewState.value),
  ),
)
// A plain list shows the first page; "show more" adds the next one.
const PAGE = 100
const shownLimit = ref(PAGE)
const shownItems = computed(() => visibleItems.value.slice(0, shownLimit.value))
watch([activeAspect, activeScope, activeReviewState, conflictsOnly], () => { shownLimit.value = PAGE })
const visibleConflicts = computed(() =>
  conflicts.value.filter(
    ({ left, right }) => matchesActiveFilters(left) || matchesActiveFilters(right),
  ),
)
const aspectOptions = computed(() => [
  ['all', t('preferences.profile.filters.all')],
  ['taste', t('preferences.profile.filters.taste')],
  ['personality', t('preferences.profile.filters.personality')],
  ['judgment_preference', t('preferences.profile.filters.judgment')],
] as const)
const scopeOptions = computed(() => {
  const projectNames = new Map(
    (store.state?.personalProjects ?? []).map(
      (project) => [project.project_id, project.profile.name],
    ),
  )
  const projectIds = [
    ...new Set(
      items.value
        .filter(
          ({ preferenceScope, preferenceProjectId }) =>
            preferenceScope === 'project' && Boolean(preferenceProjectId),
        )
        .map(({ preferenceProjectId }) => preferenceProjectId as string),
    ),
  ].sort((left, right) =>
    (projectNames.get(left) ?? left).localeCompare(
      projectNames.get(right) ?? right,
      currentLocale(),
    ),
  )
  return [
    {
      value: 'all',
      label: t('preferences.profile.scopes.all'),
      meta: t('common.counts.items', { count: items.value.length }),
    },
    {
      value: 'global',
      label: t('preferences.profile.scopes.global'),
      meta: t('common.counts.items', {
        count: items.value.filter(
          (item) => knownScope(item) && item.preferenceScope === 'global',
        ).length,
      }),
    },
    ...projectIds.map((projectId) => ({
      value: `project:${projectId}`,
      label: projectNames.get(projectId) ?? projectId,
      meta: t('preferences.profile.scopes.projectMeta', {
        count: items.value.filter(
          ({ preferenceScope, preferenceProjectId }) =>
            preferenceScope === 'project'
            && preferenceProjectId === projectId,
        ).length,
      }),
      search: projectId,
    })),
  ]
})
const stateCount = (state: PreferenceListState) => items.value.filter(item => preferenceListState(item) === state).length
const confirmedCount = computed(() => stateCount('confirmed'))
const observedCount = computed(() => stateCount('pending'))
const agentConfirmedCount = computed(() => stateCount('agent_confirmed'))
const historicalCount = computed(() => stateCount('historical'))
// The same stat row as every memory page; each count is also its filter.
const stats = computed<UiStat[]>(() => [
  { key: 'confirmed', label: t('preferences.profile.summary.confirmed'), value: confirmedCount.value, tone: 'success',
    pressed: !conflictsOnly.value && activeReviewState.value === 'confirmed',
    ariaLabel: t('preferences.profile.summary.confirmedAria', { count: confirmedCount.value }) },
  { key: 'agent_confirmed', label: t('preferences.profile.summary.agentConfirmed'), value: agentConfirmedCount.value, tone: 'accent',
    pressed: !conflictsOnly.value && activeReviewState.value === 'agent_confirmed',
    ariaLabel: t('preferences.profile.summary.agentConfirmedAria', { count: agentConfirmedCount.value }) },
  { key: 'pending', label: t('preferences.profile.summary.pending'), value: observedCount.value, tone: 'warning',
    pressed: !conflictsOnly.value && activeReviewState.value === 'pending',
    ariaLabel: t('preferences.profile.summary.pendingAria', { count: observedCount.value }) },
  { key: 'historical', label: t('preferences.profile.summary.history'), value: historicalCount.value, term: 'memory.history',
    pressed: !conflictsOnly.value && activeReviewState.value === 'historical',
    ariaLabel: t('preferences.profile.summary.historyAria', { count: historicalCount.value }) },
  { key: 'conflict', label: t('preferences.profile.summary.conflicts'), value: conflicts.value.length,
    tone: conflicts.value.length ? 'danger' : 'neutral', pressed: conflictsOnly.value,
    ariaLabel: conflicts.value.length ? t('preferences.profile.summary.conflictAria', { count: conflicts.value.length })
      : t('preferences.profile.summary.noConflictsAria') },
])
const aspectSegments = computed(() => aspectOptions.value.map(([value, label]) => ({ value, label })))
// The filters that narrow the list, by the names their controls show; without
// one, the list differs from the total only by leaving history out.
const filterName = computed(() => [
  activeAspect.value === 'all' ? '' : aspectOptions.value.find(([value]) => value === activeAspect.value)?.[1],
  activeScope.value === 'all' ? '' : scopeOptions.value.find(({ value }) => value === activeScope.value)?.label,
].filter(Boolean).join(' / ') || t('common.status.current'))
const countText = computed(() => {
  if (conflictsOnly.value) return t('preferences.profile.filters.conflictsCount', { visible: visibleConflicts.value.length, total: conflicts.value.length })
  if (activeReviewState.value !== 'all') return t('preferences.profile.filters.reviewCount', { count: visibleItems.value.length,
    status: activeReviewState.value === 'pending' ? t('preferences.profile.summary.pending')
      : activeReviewState.value === 'agent_confirmed' ? t('preferences.profile.summary.agentConfirmed')
        : activeReviewState.value === 'historical' ? t('preferences.profile.summary.history')
          : t('preferences.profile.summary.confirmed') })
  return visibleItems.value.length === items.value.length
    ? t('preferences.profile.filters.personalUnderstanding', { count: items.value.length })
    : t('preferences.profile.filters.visibleCount', { filter: filterName.value, visible: visibleItems.value.length, total: items.value.length })
})
function selectStat(key: string) {
  if (key === 'conflict') toggleConflictWorkbench()
  else toggleReviewState(key as PreferenceListState)
}
const isSelected = (item: KnowledgeItem) => selectedItem.value?.id === item.id && selectedItem.value?.itemKind === item.itemKind
// Details open in a quick look over the list (D-03); its row lifts meanwhile.
function openItem(item: KnowledgeItem) {
  closeForms()
  void peek.open(item)
}

function closeForms() {
  confirmingItem.value = null
  editingItem.value = null
  activeConflict.value = null
}
function clearPrivateContent() {
  graph.value = null
  conflictRecords.value = []
  snapshotReady.value = false
  deferringConflictId.value = ''
  closeForms()
}
function clearReadTimers() { clearTimeout(slowTimer); clearTimeout(deadlineTimer) }
function safeFocus() { void nextTick(() => pageElement.value?.querySelector<HTMLElement>('[data-profile-reload], .personal-profile-open, [role="combobox"]')?.focus()) }
function revokeAccess() {
  ++loadVersion
  loadController?.abort()
  clearReadTimers()
  loading.value = false
  clearPrivateContent()
  void peek.close()
  loadFailed.value = true
  safeFocus()
}

watch(
  () => store.activePersonalSpace?.id,
  (spaceId, previousSpaceId) => {
    if (spaceId !== previousSpaceId) {
      ++loadVersion
      loadController?.abort()
      loading.value = false
      clearPrivateContent()
      clearReadTimers()
      loadFailed.value = false
      activeScope.value = 'all'
    }
    if (spaceId) void load(spaceId)
    else {
      loadVersion += 1
      loadController?.abort()
      loadController = null
      loading.value = false
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  clearReadTimers()
  loadVersion += 1
  loadController?.abort()
  loadController = null
})
watch(
  [activeAspect, activeScope, activeReviewState, conflictsOnly],
  () => {
    if (
      !replacing
      && selectedItem.value
      && (!visibleItems.value.some(item => knowledgeItemKey(item) === knowledgeItemKey(selectedItem.value!)) || conflictsOnly.value)
    ) {
      void peek.close()
      closeForms()
      safeFocus()
    }
  },
)
watch(scopeOptions, (options) => {
  if (!options.some(({ value }) => value === activeScope.value)) activeScope.value = 'all'
})

async function load(spaceId = store.activePersonalSpace?.id) {
  if (!spaceId || loading.value) return
  loadController?.abort()
  clearReadTimers()
  const requestVersion = ++loadVersion
  const controller = new AbortController()
  loadController = controller
  loading.value = true
  snapshotReady.value = false
  loadFailed.value = false
  readStatus.value = null
  takingLong.value = false
  closeForms()
  slowTimer = setTimeout(() => { if (requestVersion === loadVersion) takingLong.value = true }, 8000)
  deadlineTimer = setTimeout(() => {
    if (requestVersion !== loadVersion) return
    ++loadVersion
    controller.abort()
    loading.value = false
    takingLong.value = false
    loadFailed.value = true
    loadController = null
    safeFocus()
  }, 30000)
  try {
    const conflictQuery = new URLSearchParams({
      personalSpaceId: spaceId,
      limit: '500',
    })
    const guardAccess = <T,>(request: Promise<T>) => request.catch(error => {
      if (requestVersion === loadVersion && [401, 403].includes(Number(error?.status))) revokeAccess()
      throw error
    })
    const [nextGraph, nextConflictRecords] = await Promise.all([
      guardAccess(readPersonalProfileGraph(spaceId, controller.signal)),
      guardAccess(getJson<PreferenceConflictRecord[]>(
        `/api/preference-conflicts?${conflictQuery}`,
        { signal: controller.signal },
      )),
    ])
    if (requestVersion !== loadVersion || controller.signal.aborted) return
    if (!Array.isArray(nextConflictRecords)) throw new Error('Invalid conflict snapshot')
    graph.value = nextGraph
    conflictRecords.value = Array.isArray(nextConflictRecords) ? nextConflictRecords : []
    reconcileKnowledgeWrites(spaceId, personalProfileItems(nextGraph))
    snapshotReady.value = true
  } catch (error) {
    if (requestVersion !== loadVersion || controller.signal.aborted) return
    const status = Number((error as { status?: number })?.status) || null
    readStatus.value = status
    if (status === 401 || status === 403) { revokeAccess(); return }
    loadFailed.value = true
  } finally {
    if (requestVersion !== loadVersion || controller.signal.aborted) return
    loading.value = false
    takingLong.value = false
    clearReadTimers()
    if (loadController === controller) loadController = null
  }
}

function statusLabel(item: KnowledgeItem) {
  const review = reviewStateLabel(item)
  // A historical preference says why it is history first (rec#5 C8-1).
  const label = item.invalidAt ? `${versionStatusLabel(item.versionStatus ?? 'inactive')} · ${review}` : review
  const conflict = conflicts.value.find(
    ({ left, right }) => knowledgeItemKey(left) === knowledgeItemKey(item) || knowledgeItemKey(right) === knowledgeItemKey(item),
  )
  if (conflict?.aiRecord) {
    return `${label} · ${t('preferences.profile.statusSuffix.aiPending')}`
  }
  if (conflict) {
    return `${label} · ${t('preferences.profile.statusSuffix.conflict')}`
  }
  if (aiResolvedIds.value.has(knowledgeItemKey(item))) {
    return `${label} · ${t('preferences.profile.statusSuffix.aiResolved')}`
  }
  return label
}


function scopeLabel(item: KnowledgeItem) {
  if (!knownScope(item)) return t('preferences.detail.scopeUnknown')
  if (item.preferenceScope === 'global') {
    return t('preferences.shared.personalGlobal')
  }
  const project = store.state?.personalProjects?.find(
    ({ project_id }) => project_id === item.preferenceProjectId,
  )
  return t('preferences.shared.projectOnly', {
    project: project?.profile.name ?? item.preferenceProjectId ?? '',
  })
}
function knownScope(item: KnowledgeItem) {
  // Inspect the returned source, not the model's legacy global fallback.
  return item.raw.preference_scope === 'global' || (item.raw.preference_scope === 'project' && Boolean(item.preferenceProjectId))
}

function matchesActiveFilters(item: KnowledgeItem) {
  if (activeAspect.value !== 'all' && item.profileAspect !== activeAspect.value) return false
  if (activeScope.value === 'global' && (!knownScope(item) || item.preferenceScope !== 'global')) return false
  if (activeScope.value.startsWith('project:')) {
    const projectId = activeScope.value.slice('project:'.length)
    return item.preferenceScope === 'project' && item.preferenceProjectId === projectId
  }
  return true
}

function conflictScopeLabel(conflict: PreferenceConflict) {
  if (!knownScope(conflict.left) || !knownScope(conflict.right)) return t('preferences.detail.scopeUnknown')
  if (conflict.scopeKey === 'global') return t('preferences.shared.personalGlobal')
  const projectId = conflict.scopeKey.slice('project:'.length)
  const project = store.state?.personalProjects?.find(
    ({ project_id }) => project_id === projectId,
  )
  return t('preferences.shared.projectOnly', {
    project: project?.profile.name ?? projectId,
  })
}

async function openReplacement(item: KnowledgeItem) {
  const spaceId = store.activePersonalSpace?.id
  const version = loadVersion
  const current = () => spaceId === store.activePersonalSpace?.id && version === loadVersion
  replacing = true
  try {
    activeAspect.value = item.profileAspect ?? 'all'
    activeScope.value = item.preferenceScope === 'project' && item.preferenceProjectId
      ? `project:${item.preferenceProjectId}`
      : 'global'
    conflictsOnly.value = false
    activeReviewState.value = 'all'
    // The filter watcher resets pagination and the aspect goes into the URL.
    // Complete both before locating the target; otherwise a replacement after
    // row 100 vanishes on the next tick, or the aspect and the item overwrite
    // each other in the URL.
    await nextTick()
    await aspectSync
    if (!current()) return
    const index = visibleItems.value.findIndex(candidate => knowledgeItemKey(candidate) === knowledgeItemKey(item))
    if (index < 0) return
    shownLimit.value = Math.max(PAGE, index + 1)
    await peek.open(item)
  } finally {
    replacing = false
  }
  await nextTick()
  if (!current()) return
  // The quick look now shows the replacement; its row is in view behind it.
  pageElement.value?.querySelector<HTMLElement>('.personal-profile-row.selected')
    ?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' })
}


function editConflictItem(item: KnowledgeItem) {
  activeConflict.value = null
  editingItem.value = item
}

function toggleReviewState(state: PreferenceListState) {
  const nextState = !conflictsOnly.value && activeReviewState.value === state
    ? 'all'
    : state
  conflictsOnly.value = false
  activeReviewState.value = nextState
  const first = nextState === 'all' ? undefined : visibleItems.value.at(0)
  if (first) void peek.open(first)
}

function toggleConflictWorkbench(forceOpen = false) {
  const nextState = forceOpen || !conflictsOnly.value
  conflictsOnly.value = nextState
  if (nextState) {
    activeReviewState.value = 'all'
    void peek.close()
  }
}

async function deferConflictToAi(conflict: PreferenceConflict) {
  if (!snapshotReady.value || deferringConflictId.value || !knownScope(conflict.left) || !knownScope(conflict.right)) return
  const version = loadVersion
  const personalSpaceId = store.activePersonalSpace?.id
  if (!personalSpaceId || conflict.aiRecord) return
  deferringConflictId.value = conflict.id
  snapshotReady.value = false
  deferTakingLong.value = false
  const slow = setTimeout(() => { if (version === loadVersion) deferTakingLong.value = true }, 8000)
  let deadline: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('unconfirmed')), 30000) })
  try {
    const record = await Promise.race([postJson<PreferenceConflictRecord>(
      '/api/preference-conflicts/defer',
      {
        personalSpaceId,
        conflictId: conflict.id,
        preferenceKey: conflict.preferenceKey,
        preferenceScope: conflict.left.preferenceScope ?? 'global',
        preferenceProjectId: conflict.left.preferenceProjectId,
        leftItemId: conflict.left.id,
        leftItemKind: conflict.left.itemKind,
        rightItemId: conflict.right.id,
        rightItemKind: conflict.right.itemKind,
        reason: t('preferences.profile.deferReason'),
      },
    ), timeout])
    if (version !== loadVersion || personalSpaceId !== store.activePersonalSpace?.id) return
    snapshotReady.value = true
    conflictRecords.value = [
      record,
      ...conflictRecords.value.filter(({ id }) => id !== record.id),
    ]
    store.notify(t('preferences.profile.deferNotice'))
  } catch (error) {
    if (version !== loadVersion || personalSpaceId !== store.activePersonalSpace?.id) return
    if ([401,403].includes(Number((error as { status?: number })?.status))) revokeAccess()
    else store.reportError(new Error(t('preferences.detail.unconfirmed')))
  } finally {
    clearTimeout(slow)
    clearTimeout(deadline)
    if (version === loadVersion) deferTakingLong.value = false
    if (version === loadVersion) deferringConflictId.value = ''
  }
}
</script>

<template>
  <section ref="pageElement" class="view vue-personal-profile">
    <div class="profile-canvas">
    <UiStatRow v-if="graph" :items="stats" :label="t('preferences.profile.summaryAria')" @select="selectStat" />

    <UiToolbar>
      <UiSegmented v-model="activeAspect" data-profile-aspects :options="aspectSegments" :label="t('preferences.profile.filters.aspectAria')" />
      <UiSelect
        v-model="activeScope"
        class="personal-profile-scope-filter"
        control-id="personal-profile-scope"
        :label="t('preferences.profile.filters.scopeLabel')"
        :options="scopeOptions"
      />
      <template #end>
        <span v-if="graph" data-profile-count data-term="memory.preferenceCount">{{ countText }}</span>
        <UiIconButton icon="refresh" size="sm" :label="t('common.actions.refresh')" :disabled="loading" @click="load()" />
      </template>
    </UiToolbar>

    <p v-if="loadFailed" class="preference-read-error" role="alert" data-profile-read-error>
      {{ graph ? t('preferences.detail.stale') : t('preferences.detail.loadFailed') }}
      <span v-if="readStatus"> ({{ readStatus }})</span>
      <Button variant="outline" data-profile-reload :disabled="loading" @click="load()">{{ t('preferences.detail.reload') }}</Button>
    </p>
    <p v-if="deferTakingLong" role="status">{{ t('preferences.detail.writeLong', { action: t('preferences.profile.workbench.deferring') }) }}</p>
    <p v-if="takingLong" role="status">{{ t('preferences.detail.readLong') }}</p>
    <GrowthLoading v-if="loading && graph && !showInitialLoading" variant="inline" :label="t('preferences.profile.directory.loading')" />
    <GrowthLoading
      v-if="showInitialLoading"
      :label="t('preferences.profile.directory.loading')"
    />
    <div v-else-if="initialLoading" class="view-loading" aria-busy="true" />
    <section
      v-else-if="graph && conflictsOnly"
      class="preference-conflict-workbench"
      :aria-label="t('preferences.profile.workbench.aria')"
    >
      <header>
        <div>
          <h2>{{ t('preferences.profile.workbench.title') }}</h2>
        </div>
      </header>
      <div class="preference-conflict-list">
        <article
          v-for="(conflict, index) in visibleConflicts"
          :key="conflict.id"
          class="preference-conflict-card"
        >
          <div class="preference-conflict-card-heading">
            <div>
              <span>{{ t('preferences.profile.workbench.group', { index: index + 1 }) }}</span>
              <h3>{{ conflict.preferenceKey }}</h3>
            </div>
            <div>
              <span>{{ conflictScopeLabel(conflict) }}</span>
              <strong>
                {{
                  conflict.aiRecord
                    ? t('preferences.profile.workbench.aiPending')
                    : conflict.recommendedAction === 'merge'
                      ? t('preferences.profile.workbench.mergeSuggested')
                      : t('preferences.profile.workbench.humanReview')
                }}
              </strong>
            </div>
          </div>
          <div class="preference-conflict-pair">
            <section>
              <span>{{ t('preferences.profile.workbench.older') }}</span>
              <strong>{{ conflict.left.title }}</strong>
              <p>{{ preferenceValue(conflict.left) }}</p>
              <small>{{ formatTime(latestItemValue(conflict.left)) }}</small>
            </section>
            <i aria-hidden="true">↔</i>
            <section>
              <span>{{ t('preferences.profile.workbench.newer') }}</span>
              <strong>{{ conflict.right.title }}</strong>
              <p>{{ preferenceValue(conflict.right) }}</p>
              <small>{{ formatTime(latestItemValue(conflict.right)) }}</small>
            </section>
          </div>
          <footer>
            <div>
              <span>{{ t('preferences.profile.workbench.reason') }}</span>
              <p>{{ conflict.reason }}</p>
              <small v-if="conflict.difference.rightOnly.length">
                {{
                  t('preferences.profile.workbench.additions', {
                    values: conflict.difference.rightOnly.join('、'),
                  })
                }}
              </small>
            </div>
            <div class="preference-conflict-actions">
              <Button variant="outline" size="sm"
                  :loading="deferringConflictId === conflict.id" :loading-label="t('preferences.profile.workbench.deferring')"
                  :disabled="!snapshotReady || !knownScope(conflict.left) || !knownScope(conflict.right) || Boolean(conflict.aiRecord) || deferringConflictId === conflict.id"
                @click="deferConflictToAi(conflict)"
              >
                {{
                  conflict.aiRecord
                    ? t('preferences.profile.workbench.deferred')
                    : deferringConflictId === conflict.id
                      ? t('preferences.profile.workbench.deferring')
                      : t('preferences.profile.workbench.defer')
                }}
              </Button>
              <Button size="sm" :disabled="!snapshotReady || !knownScope(conflict.left) || !knownScope(conflict.right)" @click="activeConflict = conflict">
                {{ t('preferences.profile.workbench.handleNow') }}
              </Button>
            </div>
          </footer>
        </article>
      </div>
      <div v-if="!visibleConflicts.length" class="empty-state">
        {{ conflicts.length
              ? t('preferences.profile.workbench.noFiltered')
              : t('preferences.profile.workbench.empty')
        }}
      </div>
    </section>

    <UiEmpty v-else-if="graph && !visibleItems.length" class="ui-list"
      :text="items.length ? t('preferences.profile.directory.noFiltered') : t('preferences.profile.directory.empty')" />
    <div v-else-if="graph" class="ui-list personal-profile-list" :aria-label="t('preferences.profile.directory.aria')">
      <article
        v-for="item in shownItems"
        :key="knowledgeItemKey(item)"
        :data-return-focus="knowledgeItemKey(item)"
        class="personal-profile-row"
        :class="{
          selected: isSelected(item),
          'pending-review': knowledgeReviewState(item) === 'pending',
          'ai-resolved-conflict': aiResolvedIds.has(knowledgeItemKey(item)),
        }"
      >
        <button class="personal-profile-open" type="button" aria-haspopup="dialog" :aria-label="t('preferences.detail.open', { title: item.title })" @click="openItem(item)">
          <span class="profile-aspect-mark" :class="item.profileAspect">{{ profileAspectLabel(item.profileAspect) }}</span>
          <span class="personal-profile-copy"><strong role="heading" aria-level="2">{{ item.title }}</strong><small v-if="distinctSummary(item)">{{ distinctSummary(item) }}</small></span>
          <span class="personal-profile-origin">
            <strong :class="{ 'has-conflict': conflictingIds.has(knowledgeItemKey(item)) }">{{ statusLabel(item) }}</strong>
            <small>
              {{ scopeLabel(item) }} ·
              {{ t('preferences.profile.directory.sourceCount', { count: item.evidence.length }) }}
            </small>
          </span>
          <time :title="formatTime(latestItemValue(item))">{{ formatTime(latestItemValue(item), 'minute') }}</time>
        </button>
      </article>
      <Button v-if="shownItems.length < visibleItems.length" variant="ghost" class="personal-profile-more" data-profile-more
        @click="shownLimit += PAGE">
        {{ t('preferences.profile.directory.showMore', { count: Math.min(PAGE, visibleItems.length - shownItems.length) }) }}
      </Button>
    </div>
    <KnowledgePeek
      mode="preference"
      :item="selectedItem"
      :suspended="Boolean(editingItem || confirmingItem)"
      :graph="graph"
      :editable="Boolean(selectedItem) && snapshotReady && knownScope(selectedItem!)"
      :preference-scope-label="selectedItem ? scopeLabel(selectedItem) : ''"
      :preference-status-label="selectedItem ? statusLabel(selectedItem) : ''"
      @confirm="confirmingItem = $event"
      @edit="editingItem = $event"
      @open-replacement="openReplacement"
      @close="peek.close()"
      @close-auto-focus="peek.returnFocus"
    />
    <KnowledgeEditDialog
      :item="editingItem"
      :personal-space-id="store.activePersonalSpace?.id ?? ''"
      :personal-project-id="null"
      :projects="store.state?.personalProjects ?? []"
      :replacement-items="items"
      @access-denied="revokeAccess"
      @reload="load()"
      @close="editingItem = null"
      @saved="load()"
    />
    <KnowledgeConfirmDialog
      :item="confirmingItem"
      :personal-space-id="store.activePersonalSpace?.id ?? ''"
      :personal-project-id="null"
      @access-denied="revokeAccess"
      @reload="load()"
      @close="confirmingItem = null"
      @saved="load()"
    />
    <PreferenceConflictDialog
      :conflict="activeConflict"
      :personal-space-id="store.activePersonalSpace?.id ?? ''"
      :projects="store.state?.personalProjects ?? []"
      @close="activeConflict = null"
      @resolved="load()"
      @edit="editConflictItem"
    />
    </div>
  </section>
</template>

<style scoped>








.preference-conflict-workbench {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 18px 0 4px;
}

.preference-conflict-workbench > header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  padding: 0 2px 14px;
}

.preference-conflict-workbench h2,
.preference-conflict-workbench p {
  margin: 0;
}

.preference-conflict-workbench h2 {
  color: var(--color-ink);
  font-size: 17px;
}

.preference-conflict-workbench > header > p {
  max-width: 520px;
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.55;
  text-align: right;
}

.preference-conflict-list {
  display: grid;
  gap: 12px;
}

.preference-conflict-card {
  display: grid;
  gap: 12px;
  padding: 15px;
  border: 1px solid var(--color-border);
  border-radius: 11px;
  background: var(--color-surface);
  box-shadow: var(--shadow-md);
}

.preference-conflict-card-heading,
.preference-conflict-card footer {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}

.preference-conflict-card-heading > div {
  display: grid;
  gap: 3px;
}

.preference-conflict-card-heading > div:last-child {
  justify-items: end;
}

.preference-conflict-card-heading span,
.preference-conflict-card footer span {
  color: var(--color-muted);
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
}

.preference-conflict-card-heading h3 {
  margin: 0;
  color: var(--color-ink);
  font-size: 14px;
}

.preference-conflict-card-heading strong {
  color: var(--color-muted);
  font-size: 12px;
}

.preference-conflict-pair {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 26px minmax(0, 1fr);
  align-items: stretch;
  gap: 8px;
}

.preference-conflict-pair > section {
  min-width: 0;
  display: grid;
  align-content: start;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  background: var(--color-surface);
}

.preference-conflict-pair > section:first-child {
  border-color: var(--color-border);
  background: var(--color-surface);
}

.preference-conflict-pair > section:last-child {
  border-color: var(--color-border);
  background: var(--color-surface);
}

.preference-conflict-pair span,
.preference-conflict-pair small {
  color: var(--color-muted);
  font-size: 12px;
}

.preference-conflict-pair strong {
  color: var(--color-ink);
  font-size: 12px;
}

.preference-conflict-pair p {
  color: var(--color-ink);
  font-size: 12px;
  line-height: 1.55;
}

.preference-conflict-pair > i {
  align-self: center;
  color: var(--color-muted);
  font-size: 14px;
  font-style: normal;
  text-align: center;
}

.preference-conflict-card footer {
  padding-top: 11px;
  border-top: 1px solid var(--color-border);
}

.preference-conflict-card footer > div {
  display: grid;
  gap: 4px;
}

.preference-conflict-card footer p {
  color: var(--color-muted);
  font-size: 12px;
}

.preference-conflict-card footer small {
  color: var(--color-muted);
  font-size: 12px;
}

.preference-conflict-card footer button {
  flex: 0 0 auto;
}

.preference-conflict-card footer .preference-conflict-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.personal-profile-row.ai-resolved-conflict {
  border-color: var(--color-border-strong);
  background: var(--color-surface);
}

.personal-profile-row.ai-resolved-conflict .personal-profile-origin strong {
  color: var(--color-ink);
}

@media (max-width: 860px) {
  .preference-conflict-workbench > header,
  .preference-conflict-card-heading,
  .preference-conflict-card footer {
    align-items: stretch;
    flex-direction: column;
  }

  .preference-conflict-workbench > header > p {
    text-align: left;
  }

  .preference-conflict-card-heading > div:last-child {
    justify-items: start;
  }

  .preference-conflict-pair {
    grid-template-columns: 1fr;
  }

  .preference-conflict-card footer .preference-conflict-actions {
    justify-content: flex-start;
    flex-wrap: wrap;
  }
}

/* Each preference is a tile; wider canvases add columns instead of stretching the tile.
   Aspect and date head the tile, the preference reads in the middle and its
   status sits at the foot, so tiles in a row line up. */
.personal-profile-row { display: grid; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); }
.personal-profile-open {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: auto 1fr auto;
  grid-template-areas: "aspect time" "copy copy" "origin origin"; align-items: start; gap: 10px 12px;
  width: 100%; height: 100%; padding: 16px 18px; border: 0; color: inherit; background: transparent; font: inherit; text-align: left; cursor: pointer;
}
.personal-profile-open > .profile-aspect-mark { grid-area: aspect; }
.personal-profile-open > time { grid-area: time; }
.personal-profile-open > .personal-profile-copy { grid-area: copy; }
.personal-profile-open > .personal-profile-origin { grid-area: origin; align-self: end; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px;
  padding-top: 10px; border-top: 1px solid var(--color-border); justify-items: start; text-align: left; }
.personal-profile-open:hover, .personal-profile-row.selected .personal-profile-open { background: var(--color-surface-hover); }
.personal-profile-open:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }
.personal-profile-copy { display: grid; gap: 4px; min-width: 0; }
.personal-profile-origin { min-width: 0; }
.personal-profile-copy strong { color: var(--color-ink); font-size: 14px; font-weight: 600; }
.personal-profile-copy small { display: -webkit-box; overflow: hidden; color: var(--color-ink-soft); font-size: 13px; line-height: 1.55; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.personal-profile-open time { align-self: center; white-space: nowrap; }
.profile-aspect-mark { justify-self: start; max-width: 100%; text-align: center; }
.personal-profile-origin strong { color: var(--color-ink-soft); font-size: 12px; font-weight: 600; }
.personal-profile-origin small, .personal-profile-open time { color: var(--color-faint); font-size: 12px; }
.personal-profile-more { grid-column: 1 / -1; width: 100%; color: var(--color-accent); }
.personal-profile-scope-filter { width: min(240px, 28vw); }
</style>

<style scoped>
.vue-personal-profile { padding-bottom: calc(80px + env(safe-area-inset-bottom) + 16px); min-width: 0; scrollbar-gutter: stable; }
/* One centred work canvas (D-03); a preference opens in a quick look over it. */
.profile-canvas { display: flex; flex-direction: column; gap: 14px; width: 100%; max-width: var(--layout-max); margin-inline: auto; }
.personal-profile-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); gap: 12px; overflow: visible; border: 0; border-radius: 0; background: transparent; }
.personal-profile-row { min-width: 0; scroll-margin-top: 80px; }
/* The open row lifts as a card while its quick look is up (never a side bar). */
.personal-profile-row.selected { position: relative; z-index: 1; border-color: var(--color-border-strong); background: var(--color-surface); box-shadow: var(--shadow-md); }
.personal-profile-row.selected .personal-profile-open { background: transparent; }
.personal-profile-copy strong, .personal-profile-origin { overflow-wrap: anywhere; white-space: normal; }
.personal-profile-open { min-height: 44px; border-radius: inherit; }
.preference-read-error { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; color: var(--color-ink); }
@media (max-width: 720px) { .personal-profile-scope-filter { width: 100%; } }
</style>
