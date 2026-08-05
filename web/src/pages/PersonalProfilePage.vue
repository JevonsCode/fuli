<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { getJson, postJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import SearchableSelect from '@/components/SearchableSelect.vue'
import VirtualDirectoryList from '@/components/VirtualDirectoryList.vue'
import { useMinimumLoadingDisplay } from '@/composables/useMinimumLoadingDisplay'
import KnowledgeConfirmDialog from '@/features/knowledge/KnowledgeConfirmDialog.vue'
import KnowledgeInspector from '@/features/knowledge/KnowledgeInspector.vue'
import KnowledgeEditDialog from '@/features/knowledge/KnowledgeEditDialog.vue'
import PreferenceConflictDialog from '@/features/preferences/PreferenceConflictDialog.vue'
import WritingTasteMilestone from '@/features/preferences/WritingTasteMilestone.vue'
import {
  detectPreferenceConflicts,
  preferenceConflictRecordItemIds,
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
  quadrantLabel,
  reviewStateLabel,
  type KnowledgeReviewState,
} from '@/features/knowledge/model'
import { currentLocale, t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import type { KnowledgeGraph, KnowledgeItem, WritingTasteProfile } from '@/types'

const store = useConsoleStore()
const graph = ref<KnowledgeGraph | null>(null)
const writingTaste = ref<WritingTasteProfile | null>(null)
const loading = ref(false)
const showInitialLoading = useMinimumLoadingDisplay(computed(() =>
  loading.value && !graph.value,
))
const activeAspect = ref('all')
const activeScope = ref('all')
const activeReviewState = ref<'all' | KnowledgeReviewState>('all')
const conflictsOnly = ref(false)
const selectedItem = ref<KnowledgeItem | null>(null)
const confirmingItem = ref<KnowledgeItem | null>(null)
const editingItem = ref<KnowledgeItem | null>(null)
const activeConflict = ref<PreferenceConflict | null>(null)
const conflictRecords = ref<PreferenceConflictRecord[]>([])
const deferringConflictId = ref('')

const items = computed(() => personalProfileItems(graph.value))
const conflicts = computed(() =>
  detectPreferenceConflicts(items.value, conflictRecords.value),
)
const conflictingIds = computed(
  () => new Set(conflicts.value.flatMap(({ left, right }) => [left.id, right.id])),
)
const aiResolvedIds = computed(
  () => new Set(
    conflictRecords.value
      .filter(
        ({ status, resolved_by: resolvedBy }) =>
          status === 'resolved' && resolvedBy === 'agent',
      )
      .flatMap(preferenceConflictRecordItemIds),
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
const profileListResetKey = computed(() => JSON.stringify([
  activeAspect.value,
  activeScope.value,
  activeReviewState.value,
  conflictsOnly.value,
]))
const selectedItemIndex = computed(() => selectedItem.value
  ? visibleItems.value.findIndex(({ id, itemKind }) =>
      id === selectedItem.value?.id && itemKind === selectedItem.value?.itemKind)
  : -1,
)
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
          ({ preferenceScope }) => preferenceScope !== 'project',
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
const summaryGuidance = computed(() => {
  if (conflictsOnly.value) {
    return t('preferences.profile.summaryGuidance.conflicts')
  }
  if (activeReviewState.value === 'pending') {
    return t('preferences.profile.summaryGuidance.pending')
  }
  if (activeReviewState.value === 'confirmed') {
    return t('preferences.profile.summaryGuidance.confirmed')
  }
  if (activeReviewState.value === 'agent_confirmed') {
    return t('preferences.profile.summaryGuidance.agentConfirmed')
  }
  return t('preferences.profile.summaryGuidance.default')
})

watch(
  () => store.activePersonalSpace?.id,
  (spaceId) => {
    if (spaceId) void load(spaceId)
  },
  { immediate: true },
)
watch(
  [activeAspect, activeScope, activeReviewState, conflictsOnly],
  () => {
    if (
      selectedItem.value
      && !visibleItems.value.some(({ id }) => id === selectedItem.value?.id)
    ) {
      selectedItem.value = null
    }
  },
)
watch(scopeOptions, (options) => {
  if (!options.some(({ value }) => value === activeScope.value)) activeScope.value = 'all'
})

async function load(spaceId = store.activePersonalSpace?.id) {
  if (!spaceId) return
  loading.value = true
  try {
    const query = new URLSearchParams({ spaceId, limit: '500' })
    const conflictQuery = new URLSearchParams({
      personalSpaceId: spaceId,
      limit: '500',
    })
    const writingTasteQuery = new URLSearchParams({
      personalSpaceId: spaceId,
      limit: '500',
    })
    const [nextGraph, nextConflictRecords, nextWritingTaste] = await Promise.all([
      getJson<KnowledgeGraph>(`/api/graph?${query}`),
      getJson<PreferenceConflictRecord[]>(
        `/api/preference-conflicts?${conflictQuery}`,
      ),
      getJson<WritingTasteProfile>(
        `/api/writing-taste-profile?${writingTasteQuery}`,
      ).catch(() => null),
    ])
    graph.value = nextGraph
    conflictRecords.value = Array.isArray(nextConflictRecords)
      ? nextConflictRecords
      : []
    writingTaste.value = isWritingTasteProfile(nextWritingTaste)
      ? nextWritingTaste
      : null
    if (selectedItem.value) {
      selectedItem.value = items.value.find(({ id }) => id === selectedItem.value?.id) ?? null
    }
  } catch (error) {
    graph.value = null
    writingTaste.value = null
    store.reportError(error)
  } finally {
    loading.value = false
  }
}

function isWritingTasteProfile(value: unknown): value is WritingTasteProfile {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WritingTasteProfile>
  return ['collecting', 'preview_ready', 'active'].includes(candidate.status ?? '')
    && Boolean(candidate.readiness)
    && Array.isArray(candidate.rules)
}

function statusLabel(item: KnowledgeItem) {
  const label = reviewStateLabel(item)
  const conflict = conflicts.value.find(
    ({ left, right }) => left.id === item.id || right.id === item.id,
  )
  if (conflict?.aiRecord) {
    return `${label} · ${t('preferences.profile.statusSuffix.aiPending')}`
  }
  if (conflict) {
    return `${label} · ${t('preferences.profile.statusSuffix.conflict')}`
  }
  if (aiResolvedIds.value.has(item.id)) {
    return `${label} · ${t('preferences.profile.statusSuffix.aiResolved')}`
  }
  return label
}

function itemKey(item: Pick<KnowledgeItem, 'itemKind' | 'id'>) {
  return `${item.itemKind}:${item.id}`
}

function scopeLabel(item: KnowledgeItem) {
  if (item.preferenceScope !== 'project' || !item.preferenceProjectId) {
    return t('preferences.shared.personalGlobal')
  }
  const project = store.state?.personalProjects?.find(
    ({ project_id }) => project_id === item.preferenceProjectId,
  )
  return t('preferences.shared.projectOnly', {
    project: project?.profile.name ?? item.preferenceProjectId,
  })
}

function matchesActiveFilters(item: KnowledgeItem) {
  if (activeAspect.value !== 'all' && item.profileAspect !== activeAspect.value) return false
  if (activeScope.value === 'global' && item.preferenceScope === 'project') return false
  if (activeScope.value.startsWith('project:')) {
    const projectId = activeScope.value.slice('project:'.length)
    return item.preferenceScope === 'project' && item.preferenceProjectId === projectId
  }
  return true
}

function conflictScopeLabel(conflict: PreferenceConflict) {
  if (conflict.scopeKey === 'global') return t('preferences.shared.personalGlobal')
  const projectId = conflict.scopeKey.slice('project:'.length)
  const project = store.state?.personalProjects?.find(
    ({ project_id }) => project_id === projectId,
  )
  return t('preferences.shared.projectOnly', {
    project: project?.profile.name ?? projectId,
  })
}

function openReplacement(item: KnowledgeItem) {
  activeAspect.value = item.profileAspect ?? 'all'
  activeScope.value = item.preferenceScope === 'project' && item.preferenceProjectId
    ? `project:${item.preferenceProjectId}`
    : 'global'
  conflictsOnly.value = false
  selectedItem.value = item
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
  const personalSpaceId = store.activePersonalSpace?.id
  if (!personalSpaceId || conflict.aiRecord) return
  deferringConflictId.value = conflict.id
  try {
    const record = await postJson<PreferenceConflictRecord>(
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
    )
    conflictRecords.value = [
      record,
      ...conflictRecords.value.filter(({ id }) => id !== record.id),
    ]
    store.notify(t('preferences.profile.deferNotice'))
  } catch (error) {
    store.reportError(error)
  } finally {
    deferringConflictId.value = ''
  }
}
</script>

<template>
  <section class="view vue-personal-profile">
    <div
      class="personal-profile-summary"
      :aria-label="t('preferences.profile.summaryAria')"
    >
      <button
        type="button"
        class="profile-summary-action state-confirmed"
        :aria-label="t('preferences.profile.summary.confirmedAria', { count: confirmedCount })"
        :aria-pressed="!conflictsOnly && activeReviewState === 'confirmed'"
        @click="toggleReviewState('confirmed')"
      >
        <strong>{{ confirmedCount }}</strong>{{ t('preferences.profile.summary.confirmed') }}
        <small>{{ t('preferences.profile.summary.viewRecords') }}</small>
      </button>
      <button
        type="button"
        class="profile-summary-action state-agent-confirmed"
        :aria-label="t('preferences.profile.summary.agentConfirmedAria', { count: agentConfirmedCount })"
        :aria-pressed="!conflictsOnly && activeReviewState === 'agent_confirmed'"
        @click="toggleReviewState('agent_confirmed')"
      >
        <strong>{{ agentConfirmedCount }}</strong>{{ t('preferences.profile.summary.agentConfirmed') }}
        <small>{{ t('preferences.profile.summary.belowHuman') }}</small>
      </button>
      <button
        type="button"
        class="profile-summary-action state-pending"
        :aria-label="t('preferences.profile.summary.pendingAria', { count: observedCount })"
        :aria-pressed="!conflictsOnly && activeReviewState === 'pending'"
        @click="toggleReviewState('pending')"
      >
        <strong>{{ observedCount }}</strong>{{ t('preferences.profile.summary.pending') }}
        <small v-if="observedCount">{{ t('preferences.profile.summary.reviewAndConfirm') }}</small>
        <small v-else>{{ t('preferences.profile.summary.viewRecords') }}</small>
      </button>
      <button
        type="button"
        class="profile-summary-action state-conflict"
        :aria-label="conflicts.length
          ? t('preferences.profile.summary.conflictAria', { count: conflicts.length })
          : t('preferences.profile.summary.noConflictsAria')"
        :aria-pressed="conflictsOnly"
        @click="toggleConflictWorkbench()"
      >
        <strong>{{ conflicts.length }}</strong>{{ t('preferences.profile.summary.conflicts') }}
        <small>
          {{
            conflicts.length
              ? t('preferences.profile.summary.reviewAndHandle')
              : t('preferences.profile.summary.viewRecords')
          }}
        </small>
      </button>
      <p>{{ summaryGuidance }}</p>
    </div>

    <WritingTasteMilestone :profile="writingTaste" />

    <section
      v-if="conflicts.length && !conflictsOnly && activeReviewState === 'all'"
      class="preference-conflict-alert"
      :aria-label="t('preferences.profile.alert.aria')"
    >
      <div class="preference-conflict-alert-icon" aria-hidden="true">!</div>
      <div>
        <span>{{ t('preferences.profile.alert.kicker') }}</span>
        <h2>{{ t('preferences.profile.alert.title', { count: conflicts.length }) }}</h2>
        <p>{{ t('preferences.profile.alert.copy') }}</p>
      </div>
      <button class="primary-action" type="button" @click="toggleConflictWorkbench(true)">
        {{ t('preferences.profile.alert.action') }}
      </button>
    </section>

    <div class="personal-profile-toolbar">
      <div class="personal-profile-filter-groups">
        <div
          class="personal-profile-filters"
          role="group"
          :aria-label="t('preferences.profile.filters.aspectAria')"
        >
          <button
            v-for="[value, label] in aspectOptions"
            :key="value"
            type="button"
            :aria-pressed="activeAspect === value"
            @click="activeAspect = value"
          >
            {{ label }}
          </button>
        </div>
        <SearchableSelect
          v-model="activeScope"
          class="personal-profile-scope-filter"
          control-id="personal-profile-scope"
          :label="t('preferences.profile.filters.scopeLabel')"
          :options="scopeOptions"
          :search-placeholder="t('preferences.profile.filters.scopeSearch')"
        />
      </div>
      <div class="personal-profile-toolbar-actions">
        <span v-if="conflictsOnly" class="muted">
          {{
            t('preferences.profile.filters.conflictsCount', {
              visible: visibleConflicts.length,
              total: conflicts.length,
            })
          }}
        </span>
        <span v-else-if="activeReviewState !== 'all'" class="muted">
          {{
            t('preferences.profile.filters.reviewCount', {
              count: visibleItems.length,
              status: activeReviewState === 'pending'
                ? t('preferences.profile.summary.pending')
                : activeReviewState === 'agent_confirmed'
                  ? t('preferences.profile.summary.agentConfirmed')
                  : t('preferences.profile.summary.confirmed'),
            })
          }}
        </span>
        <span v-else class="muted">
          {{
            visibleItems.length === items.length
              ? t('preferences.profile.filters.personalUnderstanding', { count: items.length })
              : t('preferences.profile.filters.visibleCount', {
                visible: visibleItems.length,
                total: items.length,
              })
          }}
        </span>
        <button class="toolbar-action" type="button" @click="load()">
          {{ t('common.actions.refresh') }}
        </button>
      </div>
    </div>

    <GrowthLoading
      v-if="showInitialLoading"
      :label="t('preferences.profile.directory.loading')"
    />
    <section
      v-else-if="conflictsOnly"
      class="preference-conflict-workbench"
      :aria-label="t('preferences.profile.workbench.aria')"
    >
      <header>
        <div>
          <p class="eyebrow">CONFLICT WORKBENCH</p>
          <h2>{{ t('preferences.profile.workbench.title') }}</h2>
        </div>
        <p>{{ t('preferences.profile.workbench.copy') }}</p>
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
              <button
                class="secondary-action"
                type="button"
                :disabled="Boolean(conflict.aiRecord) || deferringConflictId === conflict.id"
                @click="deferConflictToAi(conflict)"
              >
                {{
                  conflict.aiRecord
                    ? t('preferences.profile.workbench.deferred')
                    : deferringConflictId === conflict.id
                      ? t('preferences.profile.workbench.deferring')
                      : t('preferences.profile.workbench.defer')
                }}
              </button>
              <button class="primary-action" type="button" @click="activeConflict = conflict">
                {{ t('preferences.profile.workbench.handleNow') }}
              </button>
            </div>
          </footer>
        </article>
      </div>
      <div v-if="loading || !visibleConflicts.length" class="empty-state">
        {{
          loading
            ? t('preferences.profile.workbench.loading')
            : conflicts.length
              ? t('preferences.profile.workbench.noFiltered')
              : t('preferences.profile.workbench.empty')
        }}
      </div>
    </section>

    <div v-else class="personal-profile-layout">
      <!-- @vue-generic {import('@/types').KnowledgeItem} -->
      <VirtualDirectoryList
        class="personal-profile-directory"
        :items="visibleItems"
        :row-height="76"
        :active-index="selectedItemIndex"
        :reset-key="profileListResetKey"
        :item-key="itemKey"
        :label="t('preferences.profile.directory.aria')"
      >
        <template #header>
          <div class="personal-profile-table-head" aria-hidden="true">
            <span>{{ t('preferences.profile.directory.aspect') }}</span>
            <span>{{ t('preferences.profile.directory.content') }}</span>
            <span>{{ t('preferences.profile.directory.statusScopeSource') }}</span>
            <span>{{ t('preferences.profile.directory.updated') }}</span>
          </div>
        </template>

        <template #default="{ item }">
          <button
            class="personal-profile-row"
            :class="{
              selected: selectedItem?.id === item.id,
              'pending-review': knowledgeReviewState(item) === 'pending',
              'ai-resolved-conflict': aiResolvedIds.has(item.id),
            }"
            type="button"
            @click="selectedItem = item"
          >
            <span class="profile-aspect-mark" :class="item.profileAspect">{{ profileAspectLabel(item.profileAspect) }}</span>
            <span class="personal-profile-copy"><strong>{{ item.title }}</strong><small>{{ item.body }}</small></span>
            <span class="personal-profile-origin">
              <strong :class="{ 'has-conflict': conflictingIds.has(item.id) }">{{ statusLabel(item) }}</strong>
              <small>
                {{ quadrantLabel(item.originQuadrant) }} · {{ scopeLabel(item) }} ·
                {{ t('preferences.profile.directory.sourceCount', { count: item.evidence.length }) }}
              </small>
            </span>
            <time>{{ formatTime(latestItemValue(item)) }}</time>
          </button>
        </template>

        <template #empty>
          <div class="empty-state">
            {{
              items.length
                ? t('preferences.profile.directory.noFiltered')
                : t('preferences.profile.directory.empty')
            }}
          </div>
        </template>
      </VirtualDirectoryList>
      <KnowledgeInspector
        class="personal-profile-inspector"
        :item="selectedItem"
        :graph="graph"
        editable
        @confirm="confirmingItem = $event"
        @edit="editingItem = $event"
        @open-replacement="openReplacement"
      />
    </div>
    <KnowledgeEditDialog
      :item="editingItem"
      :personal-space-id="store.activePersonalSpace?.id ?? ''"
      :personal-project-id="null"
      :projects="store.state?.personalProjects ?? []"
      :replacement-items="items"
      @close="editingItem = null"
      @saved="load()"
    />
    <KnowledgeConfirmDialog
      :item="confirmingItem"
      :personal-space-id="store.activePersonalSpace?.id ?? ''"
      :personal-project-id="null"
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
.preference-conflict-alert {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 13px;
  margin-top: 12px;
  padding: 12px 14px;
  border: 1px solid #d6ddd8;
  border-radius: 11px;
  background: #f7f9f7;
  box-shadow: 0 7px 20px rgba(49, 66, 56, 0.05);
}

.preference-conflict-alert-icon {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border-radius: 50%;
  background: #52685b;
  color: #fff;
  font-size: 16px;
  font-weight: 800;
}

.preference-conflict-alert > div:nth-child(2) {
  display: grid;
  gap: 2px;
}

.preference-conflict-alert span {
  color: #65736b;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.preference-conflict-alert h2,
.preference-conflict-alert p {
  margin: 0;
}

.preference-conflict-alert h2 {
  color: #344239;
  font-size: 14px;
}

.preference-conflict-alert p {
  color: #6f7972;
  font-size: 10px;
  line-height: 1.5;
}

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
  color: #2e3d35;
  font-size: 17px;
}

.preference-conflict-workbench > header > p {
  max-width: 520px;
  color: #778079;
  font-size: 10px;
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
  border: 1px solid #d9dfdb;
  border-radius: 11px;
  background: #fff;
  box-shadow: 0 7px 20px rgba(45, 61, 52, 0.04);
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
  color: #7d8780;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
}

.preference-conflict-card-heading h3 {
  margin: 0;
  color: #344239;
  font-size: 14px;
}

.preference-conflict-card-heading strong {
  color: #53685b;
  font-size: 10px;
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
  border: 1px solid #e0e5e1;
  border-radius: 8px;
  background: #fff;
}

.preference-conflict-pair > section:first-child {
  border-color: #c7ddec;
  background: #f5fafe;
}

.preference-conflict-pair > section:last-child {
  border-color: #d8ceeb;
  background: #faf8fd;
}

.preference-conflict-pair span,
.preference-conflict-pair small {
  color: #7d8780;
  font-size: 9px;
}

.preference-conflict-pair strong {
  color: #35423a;
  font-size: 11px;
}

.preference-conflict-pair p {
  color: #566159;
  font-size: 10px;
  line-height: 1.55;
}

.preference-conflict-pair > i {
  align-self: center;
  color: #9b9486;
  font-size: 14px;
  font-style: normal;
  text-align: center;
}

.preference-conflict-card footer {
  padding-top: 11px;
  border-top: 1px solid #e5e9e6;
}

.preference-conflict-card footer > div {
  display: grid;
  gap: 4px;
}

.preference-conflict-card footer p {
  color: #5d625d;
  font-size: 10px;
}

.preference-conflict-card footer small {
  color: #758079;
  font-size: 9px;
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

.preference-conflict-card footer .preference-conflict-actions .secondary-action {
  color: #5e665f;
  background: #f5f7f5;
}

.personal-profile-row.ai-resolved-conflict {
  border-color: #b8d5c3;
  background: #f6fbf8;
}

.personal-profile-row.ai-resolved-conflict .personal-profile-origin strong {
  color: #39724f;
}

.personal-profile-inspector :deep(.inspector-classification.state-pending),
.personal-profile-inspector :deep(.inspector-classification.state-needs_review) {
  border-color: #d8dfda;
  background: #f5f7f5;
}

.personal-profile-inspector :deep(.inspector-classification.state-pending strong),
.personal-profile-inspector :deep(.inspector-classification.state-needs_review strong) {
  color: #53645a;
}

@media (max-width: 860px) {
  .preference-conflict-alert {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .preference-conflict-alert > button {
    grid-column: 1 / -1;
  }

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
</style>
