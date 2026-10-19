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
import KnowledgeInspector from '@/features/knowledge/KnowledgeInspector.vue'
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
  type KnowledgeReviewState,
} from '@/features/knowledge/model'
import { currentLocale, t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
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
watch(activeAspect, aspect => {
  if (!route || !router) return
  const current = typeof route.query.aspect === 'string' ? route.query.aspect : 'all'
  if (current === aspect) return
  const query = { ...route.query }
  if (aspect === 'all') delete query.aspect
  else query.aspect = aspect
  void router.replace({ query })
})
const activeScope = ref('all')
const activeReviewState = ref<'all' | KnowledgeReviewState>('all')
const conflictsOnly = ref(false)
const selectedItem = ref<KnowledgeItem | null>(null)
const confirmingItem = ref<KnowledgeItem | null>(null)
const editingItem = ref<KnowledgeItem | null>(null)
const activeConflict = ref<PreferenceConflict | null>(null)
const conflictRecords = ref<PreferenceConflictRecord[]>([])
const deferringConflictId = ref('')
const deferTakingLong = ref(false)
let loadVersion = 0
let loadController: AbortController | null = null

const items = computed(() => personalProfileItems(graph.value))
const conflicts = computed(() =>
  detectPreferenceConflicts(items.value, conflictRecords.value),
)
const conflictingIds = computed(
  () => new Set(conflicts.value.flatMap(({ left, right }) => [itemKey(left), itemKey(right)])),
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
      && (
        activeReviewState.value === 'all'
        || knowledgeReviewState(item) === activeReviewState.value
      ),
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
const confirmedCount = computed(
  () => items.value.filter((item) => knowledgeReviewState(item) === 'confirmed').length,
)
const observedCount = computed(
  () => items.value.filter((item) => knowledgeReviewState(item) === 'pending').length,
)
const agentConfirmedCount = computed(
  () => items.value.filter(
    (item) => knowledgeReviewState(item) === 'agent_confirmed',
  ).length,
)
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
  { key: 'conflict', label: t('preferences.profile.summary.conflicts'), value: conflicts.value.length,
    tone: conflicts.value.length ? 'danger' : 'neutral', pressed: conflictsOnly.value,
    ariaLabel: conflicts.value.length ? t('preferences.profile.summary.conflictAria', { count: conflicts.value.length })
      : t('preferences.profile.summary.noConflictsAria') },
])
const aspectSegments = computed(() => aspectOptions.value.map(([value, label]) => ({ value, label })))
const countText = computed(() => {
  if (conflictsOnly.value) return t('preferences.profile.filters.conflictsCount', { visible: visibleConflicts.value.length, total: conflicts.value.length })
  if (activeReviewState.value !== 'all') return t('preferences.profile.filters.reviewCount', { count: visibleItems.value.length,
    status: activeReviewState.value === 'pending' ? t('preferences.profile.summary.pending')
      : activeReviewState.value === 'agent_confirmed' ? t('preferences.profile.summary.agentConfirmed') : t('preferences.profile.summary.confirmed') })
  return visibleItems.value.length === items.value.length
    ? t('preferences.profile.filters.personalUnderstanding', { count: items.value.length })
    : t('preferences.profile.filters.visibleCount', { visible: visibleItems.value.length, total: items.value.length })
})
function selectStat(key: string) {
  if (key === 'conflict') toggleConflictWorkbench()
  else toggleReviewState(key as KnowledgeReviewState)
}
const isSelected = (item: KnowledgeItem) => selectedItem.value?.id === item.id && selectedItem.value?.itemKind === item.itemKind
// Details open inline under their row; a second click closes them.
async function toggleItem(item: KnowledgeItem) {
  selectedItem.value = isSelected(item) ? null : item
  closeForms()
  if (selectedItem.value) {
    await nextTick()
    const row = pageElement.value?.querySelector('.personal-profile-row.selected')
    const bounds = row?.querySelector('.personal-profile-open')?.getBoundingClientRect()
    if (bounds && (bounds.top < 72 || bounds.bottom > window.innerHeight - 80)) row?.scrollIntoView?.({ block: 'start', behavior: 'instant' })
  }
}

function closeForms() {
  confirmingItem.value = null
  editingItem.value = null
  activeConflict.value = null
}
function clearPrivateContent() {
  graph.value = null
  conflictRecords.value = []
  selectedItem.value = null
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
      selectedItem.value
      && (!visibleItems.value.some(item => itemKey(item) === itemKey(selectedItem.value!)) || conflictsOnly.value)
    ) {
      selectedItem.value = null
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
    if (selectedItem.value) {
      selectedItem.value = items.value.find(item => itemKey(item) === itemKey(selectedItem.value!)) ?? null
      if (!selectedItem.value) safeFocus()
    }
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
  const label = reviewStateLabel(item)
  const conflict = conflicts.value.find(
    ({ left, right }) => itemKey(left) === itemKey(item) || itemKey(right) === itemKey(item),
  )
  if (conflict?.aiRecord) {
    return `${label} · ${t('preferences.profile.statusSuffix.aiPending')}`
  }
  if (conflict) {
    return `${label} · ${t('preferences.profile.statusSuffix.conflict')}`
  }
  if (aiResolvedIds.value.has(itemKey(item))) {
    return `${label} · ${t('preferences.profile.statusSuffix.aiResolved')}`
  }
  return label
}

function itemKey(item: Pick<KnowledgeItem, 'itemKind' | 'id'>) {
  return `${item.itemKind}:${item.id}`
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
  activeAspect.value = item.profileAspect ?? 'all'
  activeScope.value = item.preferenceScope === 'project' && item.preferenceProjectId
    ? `project:${item.preferenceProjectId}`
    : 'global'
  conflictsOnly.value = false
  activeReviewState.value = 'all'
  // The filter watcher resets pagination. Complete that update before locating
  // the target; otherwise a replacement after row 100 vanishes on the next tick.
  await nextTick()
  if (spaceId !== store.activePersonalSpace?.id || version !== loadVersion) return
  const index = visibleItems.value.findIndex(candidate => itemKey(candidate) === itemKey(item))
  if (index < 0) return
  shownLimit.value = Math.max(PAGE, index + 1)
  selectedItem.value = item
  await nextTick()
  if (spaceId !== store.activePersonalSpace?.id || version !== loadVersion) return
  const trigger = pageElement.value?.querySelector<HTMLElement>('.personal-profile-row.selected .personal-profile-open')
  trigger?.focus({ preventScroll: true })
  trigger?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' })
}


function editConflictItem(item: KnowledgeItem) {
  activeConflict.value = null
  editingItem.value = item
}

function toggleReviewState(state: KnowledgeReviewState) {
  const nextState = !conflictsOnly.value && activeReviewState.value === state
    ? 'all'
    : state
  conflictsOnly.value = false
  activeReviewState.value = nextState
  if (nextState !== 'all') {
    selectedItem.value = visibleItems.value.at(0) ?? null
  }
}

function toggleConflictWorkbench(forceOpen = false) {
  const nextState = forceOpen || !conflictsOnly.value
  conflictsOnly.value = nextState
  if (nextState) {
    activeReviewState.value = 'all'
    selectedItem.value = null
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
  <section ref="pageElement" class="view page-stack vue-personal-profile">
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
        <span v-if="graph" data-profile-count>{{ countText }}</span>
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
        :key="itemKey(item)"
        class="personal-profile-row"
        :class="{
          selected: isSelected(item),
          'pending-review': knowledgeReviewState(item) === 'pending',
          'ai-resolved-conflict': aiResolvedIds.has(itemKey(item)),
        }"
      >
        <button :id="`preference-heading-${encodeURIComponent(itemKey(item))}`" class="personal-profile-open" type="button" :aria-label="t('preferences.detail.toggle', { title: item.title })" :aria-expanded="isSelected(item)" :aria-controls="`preference-detail-${encodeURIComponent(itemKey(item))}`" @click="toggleItem(item)">
          <span class="profile-aspect-mark" :class="item.profileAspect">{{ profileAspectLabel(item.profileAspect) }}</span>
          <span class="personal-profile-copy"><strong role="heading" aria-level="2">{{ item.title }}</strong><small v-if="!isSelected(item)">{{ item.body }}</small></span>
          <span v-if="!isSelected(item)" class="personal-profile-origin">
            <strong :class="{ 'has-conflict': conflictingIds.has(itemKey(item)) }">{{ statusLabel(item) }}</strong>
            <small>
              {{ scopeLabel(item) }} ·
              {{ t('preferences.profile.directory.sourceCount', { count: item.evidence.length }) }}
            </small>
          </span>
          <time v-if="!isSelected(item)">{{ formatTime(latestItemValue(item)) }}</time>
          <span v-else aria-hidden="true">⌃</span>
        </button>
        <KnowledgeInspector
          v-if="isSelected(item)"
          class="personal-profile-detail"
          :id="`preference-detail-${encodeURIComponent(itemKey(item))}`"
          :key="`${store.activePersonalSpace?.id}:${itemKey(item)}`"
          mode="preference"
          :item="item"
          :graph="graph"
          :editable="snapshotReady && knownScope(item)"
          :preference-scope-label="scopeLabel(item)"
          :preference-status-label="statusLabel(item)"
          @confirm="confirmingItem = $event"
          @edit="editingItem = $event"
          @open-replacement="openReplacement"
        />
      </article>
      <button v-if="shownItems.length < visibleItems.length" class="personal-profile-more" type="button" data-profile-more
        @click="shownLimit += PAGE">
        {{ t('preferences.profile.directory.showMore', { count: Math.min(PAGE, visibleItems.length - shownItems.length) }) }}
      </button>
    </div>
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

.personal-profile-detail :deep(.inspector-classification.state-pending),
.personal-profile-detail :deep(.inspector-classification.state-needs_review) {
  border-color: var(--color-warning-soft);
  background: var(--color-warning-soft);
}

.personal-profile-detail :deep(.inspector-classification.state-pending strong),
.personal-profile-detail :deep(.inspector-classification.state-needs_review strong) {
  color: var(--color-warning);
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

.personal-profile-row { display: grid; }
.personal-profile-row + .personal-profile-row { border-top: 1px solid var(--color-border); }
.personal-profile-open {
  display: grid; grid-template-columns: auto minmax(0, 1fr) minmax(140px, 220px) auto; align-items: center; gap: 14px;
  width: 100%; padding: 14px 16px; border: 0; color: inherit; background: transparent; font: inherit; text-align: left; cursor: pointer;
}
.personal-profile-open:hover, .personal-profile-row.selected .personal-profile-open { background: var(--color-surface-hover); }
.personal-profile-open:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }
.personal-profile-copy, .personal-profile-origin { display: grid; gap: 4px; min-width: 0; }
.personal-profile-copy strong { color: var(--color-ink); font-size: 14px; font-weight: 600; }
.personal-profile-copy small { display: -webkit-box; overflow: hidden; color: var(--color-ink-soft); font-size: 13px; line-height: 1.55; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.personal-profile-origin strong { color: var(--color-ink-soft); font-size: 12px; font-weight: 600; }
.personal-profile-origin small, .personal-profile-open time { color: var(--color-faint); font-size: 12px; }
.personal-profile-detail { margin: 0 16px 14px; padding: 14px 16px; border: 1px solid var(--color-border); border-left: 1px solid var(--color-border); border-radius: 10px; background: var(--color-surface); }
.personal-profile-more { width: 100%; padding: 12px; border: 0; border-top: 1px solid var(--color-border); color: var(--color-accent); background: transparent; font: inherit; font-size: 13px; cursor: pointer; }
.personal-profile-scope-filter { width: min(240px, 28vw); }
@media (max-width: 720px) {
  .personal-profile-open { grid-template-columns: auto minmax(0, 1fr); }
  .personal-profile-origin, .personal-profile-open time { grid-column: 2; }
}
</style>

<style scoped>
.vue-personal-profile { padding-bottom: calc(80px + env(safe-area-inset-bottom) + 16px); min-width: 0; }
.personal-profile-list { overflow: visible; }
.personal-profile-row { min-width: 0; scroll-margin-top: 80px; }
.personal-profile-row.selected { border: 1px solid var(--color-border-strong); border-radius: var(--radius-card, 12px); background: var(--color-surface); box-shadow: var(--shadow-md); }
.personal-profile-row.selected .personal-profile-open { grid-template-columns: auto minmax(0, 1fr) auto; background: transparent; }
.personal-profile-copy strong, .personal-profile-origin { overflow-wrap: anywhere; white-space: normal; }
.personal-profile-detail { margin: 0; padding: 0 16px 16px; border: 0; background: transparent; }
.personal-profile-open { min-height: 44px; }
.preference-read-error { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; color: var(--color-ink); }
@media (max-width: 720px) { .personal-profile-scope-filter { width: 100%; } }
</style>
