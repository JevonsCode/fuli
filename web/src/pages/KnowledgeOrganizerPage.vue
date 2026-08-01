<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import { getJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import VirtualDirectoryList from '@/components/VirtualDirectoryList.vue'
import {
  isLoadingPreviewEnabled,
  useMinimumLoadingDisplay,
} from '@/composables/useMinimumLoadingDisplay'
import KnowledgeBatchConfirmDialog from '@/features/knowledge/KnowledgeBatchConfirmDialog.vue'
import KnowledgeConfirmDialog from '@/features/knowledge/KnowledgeConfirmDialog.vue'
import KnowledgeEditDialog from '@/features/knowledge/KnowledgeEditDialog.vue'
import KnowledgeInspector from '@/features/knowledge/KnowledgeInspector.vue'
import {
  appendKnowledgeGraphPage,
  batchConfirmationGroups,
  confirmationBasisSummary,
  formatTime,
  knowledgeItems,
  knowledgeReviewState,
  latestItemValue,
  quadrantLabel,
  reviewStateLabel,
  type KnowledgeReviewState,
} from '@/features/knowledge/model'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import type { KnowledgeGraph, KnowledgeItem } from '@/types'

const store = useConsoleStore()
const graph = ref<KnowledgeGraph | null>(null)
const loading = ref(false)
const loadingMore = ref(false)
const query = ref('')
const activeQuadrant = ref('all')
const activeReviewState = ref<'all' | KnowledgeReviewState>('all')
const selectedItem = ref<KnowledgeItem | null>(null)
const confirmingItem = ref<KnowledgeItem | null>(null)
const editingItem = ref<KnowledgeItem | null>(null)
const batchDialogOpen = ref(false)
const loadingPreview = isLoadingPreviewEnabled()
const showInitialLoading = useMinimumLoadingDisplay(computed(() =>
  loadingPreview || (loading.value && !graph.value),
))

const PAGE_SIZE = 100
const ROW_HEIGHT = 68
let loadVersion = 0

const quadrantChoices = computed(() => [
  {
    value: 'known_unknown',
    short: t('knowledge.workspace.organizer.quadrants.known_unknown.short'),
    coordinate: t('knowledge.workspace.organizer.quadrants.known_unknown.coordinate'),
  },
  {
    value: 'known_known',
    short: t('knowledge.workspace.organizer.quadrants.known_known.short'),
    coordinate: t('knowledge.workspace.organizer.quadrants.known_known.coordinate'),
  },
  {
    value: 'unknown_unknown',
    short: t('knowledge.workspace.organizer.quadrants.unknown_unknown.short'),
    coordinate: t('knowledge.workspace.organizer.quadrants.unknown_unknown.coordinate'),
  },
  {
    value: 'unknown_known',
    short: t('knowledge.workspace.organizer.quadrants.unknown_known.short'),
    coordinate: t('knowledge.workspace.organizer.quadrants.unknown_known.coordinate'),
  },
] as const)

const reviewChoices = computed<Array<{
  value: KnowledgeReviewState
  label: string
  hint: string
}>>(() => [
  {
    value: 'pending',
    label: t('knowledge.domain.reviewStates.pending'),
    hint: t('knowledge.workspace.organizer.review.pendingHint'),
  },
  {
    value: 'agent_confirmed',
    label: t('knowledge.domain.reviewStates.agent_confirmed'),
    hint: t('knowledge.workspace.organizer.review.agentConfirmedHint'),
  },
  {
    value: 'confirmed',
    label: t('knowledge.domain.reviewStates.confirmed'),
    hint: t('knowledge.workspace.organizer.review.confirmedHint'),
  },
])

const items = computed(() => knowledgeItems(graph.value))
const confirmationGroups = computed(() => batchConfirmationGroups(items.value))
const quadrantCounts = computed(() =>
  Object.fromEntries(
    [...quadrantChoices.value.map(({ value }) => value), 'unclassified']
      .map((value) => [value, items.value.filter((item) => item.originQuadrant === value).length]),
  ),
)
const hasActiveQuadrant = computed(() => activeQuadrant.value !== 'all')
const activeQuadrantItems = computed(() =>
  hasActiveQuadrant.value
    ? items.value.filter((item) => item.originQuadrant === activeQuadrant.value)
    : items.value,
)
const activeReviewCounts = computed(() =>
  Object.fromEntries(
    reviewChoices.value.map(({ value }) => [
      value,
      activeQuadrantItems.value.filter((item) => knowledgeReviewState(item) === value).length,
    ]),
  ) as Record<KnowledgeReviewState, number>,
)
const visibleItems = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  return items.value.filter((item) => {
    if (activeQuadrant.value !== 'all' && item.originQuadrant !== activeQuadrant.value) return false
    if (
      activeReviewState.value !== 'all'
      && knowledgeReviewState(item) !== activeReviewState.value
    ) return false
    if (!needle) return true
    return [
      item.title,
      item.body,
      item.type,
      quadrantLabel(item.originQuadrant),
      reviewStateLabel(item),
      ...item.evidence.flatMap((evidence) => [
        evidence.name,
        evidence.summary,
        evidence.source_description,
      ]),
    ]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase()
      .includes(needle)
  })
})
const virtualListResetKey = computed(() =>
  `${query.value}\u0000${activeQuadrant.value}\u0000${activeReviewState.value}`,
)
const selectedItemIndex = computed(() => selectedItem.value
  ? visibleItems.value.findIndex(({ id, itemKind }) =>
      id === selectedItem.value?.id && itemKind === selectedItem.value?.itemKind)
  : -1,
)

watch(
  () => store.activePersonalSpace?.id,
  (spaceId) => {
    if (spaceId) void load(spaceId)
  },
  { immediate: true },
)

watch(visibleItems, (visible) => {
  if (
    selectedItem.value
    && !visible.some(({ id, itemKind }) =>
      id === selectedItem.value?.id && itemKind === selectedItem.value?.itemKind)
  ) {
    selectedItem.value = null
  }
})

onBeforeUnmount(() => {
  loadVersion += 1
})

async function load(spaceId = store.activePersonalSpace?.id) {
  if (!spaceId) return
  const version = ++loadVersion
  loading.value = true
  loadingMore.value = false
  let receivedPage = false
  try {
    let offset = 0
    while (version === loadVersion) {
      const params = new URLSearchParams({
        spaceId,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      })
      const page = await getJson<KnowledgeGraph>(`/api/graph?${params}`)
      if (version !== loadVersion) return
      graph.value = receivedPage ? appendKnowledgeGraphPage(graph.value, page) : page
      receivedPage = true
      if (selectedItem.value) {
        selectedItem.value = items.value.find(({ id, itemKind }) =>
          id === selectedItem.value?.id && itemKind === selectedItem.value?.itemKind) ?? null
      }
      loading.value = false
      if (!page.truncated) break
      const nextOffset = page.next_offset
      if (!Number.isInteger(nextOffset) || (nextOffset as number) <= offset) {
        throw new Error(t('knowledge.workspace.organizer.paginationError'))
      }
      offset = nextOffset as number
      loadingMore.value = true
      await nextTick()
    }
  } catch (error) {
    if (!receivedPage) graph.value = null
    store.reportError(error)
  } finally {
    if (version === loadVersion) {
      loading.value = false
      loadingMore.value = false
    }
  }
}

function itemKey(item: Pick<KnowledgeItem, 'itemKind' | 'id'>) {
  return `${item.itemKind}:${item.id}`
}

function selectQuadrant(value: string) {
  activeQuadrant.value = activeQuadrant.value === value ? 'all' : value
}

function selectReviewState(value: 'all' | KnowledgeReviewState) {
  activeReviewState.value = value
}

function openReplacement(item: KnowledgeItem) {
  query.value = ''
  activeQuadrant.value = item.originQuadrant
  activeReviewState.value = 'all'
  selectedItem.value = item
}

</script>

<template>
  <section
    class="view knowledge-organizer"
  >
    <div class="organizer-toolbar">
      <label class="organizer-search">
        <span>{{ t('knowledge.workspace.organizer.filterKnowledge') }}</span>
        <input v-model="query" type="search" :placeholder="t('knowledge.workspace.organizer.searchPlaceholder')" />
      </label>

      <div class="quadrant-filter" :aria-label="t('knowledge.workspace.organizer.quadrantFilterAria')">
        <span>{{ t('knowledge.workspace.organizer.discoverySource') }}</span>
        <button
          type="button"
          data-quadrant="all"
          :class="{ active: activeQuadrant === 'all' }"
          :aria-pressed="activeQuadrant === 'all'"
          @click="activeQuadrant = 'all'"
        >
          {{ t('common.status.all') }} <strong>{{ items.length }}</strong>
        </button>
        <button
          v-for="choice in quadrantChoices"
          :key="choice.value"
          type="button"
          :data-quadrant="choice.value"
          :class="{ active: activeQuadrant === choice.value }"
          :aria-pressed="activeQuadrant === choice.value"
          :title="choice.coordinate"
          @click="selectQuadrant(choice.value)"
        >
          {{ choice.short }} <strong>{{ quadrantCounts[choice.value] }}</strong>
        </button>
      </div>

      <div class="review-state-filter" :aria-label="t('knowledge.workspace.organizer.reviewFilterAria')">
        <span>{{ t('knowledge.workspace.organizer.reviewStatus') }}</span>
        <button
          type="button"
          data-review-state="all"
          :class="{ active: activeReviewState === 'all' }"
          :aria-pressed="activeReviewState === 'all'"
          @click="selectReviewState('all')"
        >
          {{ t('common.status.all') }} <strong>{{ activeQuadrantItems.length }}</strong>
        </button>
        <button
          v-for="choice in reviewChoices"
          :key="choice.value"
          type="button"
          :data-review-state="choice.value"
          :class="[
            `state-${choice.value}`,
            { active: activeReviewState === choice.value },
          ]"
          :aria-pressed="activeReviewState === choice.value"
          :title="choice.hint"
          @click="selectReviewState(choice.value)"
        >
          {{ choice.label }} <strong>{{ activeReviewCounts[choice.value] }}</strong>
        </button>
      </div>

      <div class="organizer-toolbar-actions">
        <p class="organizer-result-summary">
          {{ t('knowledge.workspace.organizer.showing', {
            visible: visibleItems.length,
            total: activeQuadrantItems.length,
          }) }}
          <span v-if="activeReviewState !== 'all'">
            · {{ reviewChoices.find(({ value }) => value === activeReviewState)?.label }}
          </span>
        </p>
        <button
          v-if="confirmationGroups.length"
          class="toolbar-action batch-confirm-action"
          type="button"
          @click="batchDialogOpen = true"
        >
          {{ t('knowledge.workspace.organizer.batchConfirm', { count: confirmationGroups.length }) }}
        </button>
        <button class="toolbar-action" type="button" @click="load()">{{ t('common.actions.refresh') }}</button>
      </div>
    </div>

    <GrowthLoading
      v-if="showInitialLoading"
      :label="t('common.status.loadingKnowledge')"
    />
    <div
      v-else
      class="organizer-layout"
      :class="{ 'has-selection': selectedItem }"
    >
      <!-- @vue-generic {import('@/types').KnowledgeItem} -->
      <VirtualDirectoryList
        class="organizer-directory"
        :items="visibleItems"
        :row-height="ROW_HEIGHT"
        :active-index="selectedItemIndex"
        :reset-key="virtualListResetKey"
        :item-key="itemKey"
        min-width="var(--organizer-list-min-width)"
        :label="t('knowledge.workspace.organizer.directoryAria')"
      >
        <template #header>
          <div class="organizer-table-head" aria-hidden="true">
            <span>{{ t('knowledge.workspace.workspace.view.knowledgeContent') }}</span>
            <span>{{ t('knowledge.workspace.workspace.view.columns.quadrant') }}</span>
            <span>{{ t('knowledge.workspace.workspace.view.columns.review') }}</span>
            <span>{{ t('knowledge.workspace.organizer.confirmationBasis') }}</span>
            <span>{{ t('knowledge.workspace.organizer.updated') }}</span>
          </div>
        </template>

        <template #default="{ item }">
          <button
            type="button"
            class="organizer-row"
            :class="{ selected: selectedItem?.id === item.id }"
            @click="selectedItem = item"
          >
            <span class="organizer-item-copy">
              <strong>{{ item.title }}</strong>
              <small>{{ item.body }}</small>
            </span>
            <span class="quadrant-chip" :class="item.originQuadrant">
              {{ quadrantLabel(item.originQuadrant) }}
            </span>
            <span class="review-chip" :class="`state-${knowledgeReviewState(item)}`">
              {{ reviewStateLabel(item) }}
            </span>
            <span class="organizer-basis">{{ confirmationBasisSummary(item) }}</span>
            <time>{{ formatTime(latestItemValue(item)) }}</time>
          </button>
        </template>

        <template #footer>
          <div v-if="loadingMore" class="organizer-loading-inline">
            {{ t('knowledge.workspace.organizer.loadingMore') }}
          </div>
        </template>

        <template #empty>
          <div class="empty-state">
            {{ items.length
              ? t('knowledge.workspace.organizer.noFilteredContent')
              : t('knowledge.workspace.organizer.noContent') }}
          </div>
        </template>
      </VirtualDirectoryList>

      <KnowledgeInspector
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
    <KnowledgeBatchConfirmDialog
      v-if="batchDialogOpen"
      :groups="confirmationGroups"
      :personal-space-id="store.activePersonalSpace?.id ?? ''"
      @close="batchDialogOpen = false"
      @saved="load()"
    />
  </section>
</template>

<style scoped>
.knowledge-organizer {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 18px 24px 20px;
  overflow: hidden;
}

.organizer-toolbar {
  min-width: 0;
  min-height: 34px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  align-content: center;
  gap: 6px 8px;
}

.organizer-search {
  flex: 1 1 300px;
  min-width: 180px;
  max-width: 360px;
}

.organizer-search > span {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

.organizer-search input {
  width: 100%;
}

.review-state-filter,
.quadrant-filter {
  min-width: 0;
  max-width: 100%;
  flex: 0 1 auto;
  height: 31px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid #d7ddd8;
  border-radius: 7px;
  background: #f1f4f1;
  overflow-x: auto;
  overflow-y: hidden;
  white-space: nowrap;
}

.quadrant-filter {
  max-width: 470px;
  overflow-x: auto;
}

.review-state-filter > span,
.quadrant-filter > span {
  padding: 0 6px;
  color: #7a847d;
  font-size: 8px;
  font-weight: 650;
}

.review-state-filter button,
.quadrant-filter button {
  height: 25px;
  padding: 0 7px;
  border: 0;
  border-radius: 5px;
  color: #626d66;
  background: transparent;
  font-size: 9px;
  white-space: nowrap;
}

.review-state-filter button:hover,
.quadrant-filter button:hover {
  color: #35473d;
  background: rgba(255, 255, 255, .66);
}

.review-state-filter button.active,
.quadrant-filter button.active {
  color: #30483a;
  background: #fff;
  box-shadow: 0 1px 3px rgba(47, 61, 52, .12);
}

.review-state-filter button.state-pending.active {
  color: #765d2e;
}

.review-state-filter button.state-agent_confirmed.active {
  color: #4d5f78;
}

.review-state-filter button.state-confirmed.active {
  color: #356047;
}

.review-state-filter button strong,
.quadrant-filter button strong {
  margin-left: 2px;
  font-size: 8px;
  font-weight: 720;
}

.organizer-result-summary {
  flex: 0 0 auto;
  color: #7b847e;
  font-size: 9px;
  white-space: nowrap;
}

.organizer-toolbar-actions {
  min-width: 0;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  white-space: nowrap;
}

.organizer-toolbar-actions .toolbar-action {
  flex: 0 0 auto;
  white-space: nowrap;
}

.organizer-layout {
  min-height: 0;
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  border: 1px solid #cfd7d1;
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
}

.organizer-layout.has-selection {
  grid-template-columns: minmax(0, 1fr) 340px;
}

.organizer-layout:not(.has-selection) :deep(.graph-inspector) {
  display: none;
}

.organizer-directory {
  --organizer-list-min-width: 920px;

  min-width: 0;
  min-height: 0;
}

.organizer-table-head,
.organizer-row {
  display: grid;
  grid-template-columns: minmax(230px, 1.35fr) 114px 130px minmax(160px, .8fr) 118px;
  align-items: center;
  gap: 12px;
}

.organizer-table-head {
  padding: 10px 15px;
  border-bottom: 1px solid #e0e4e0;
  color: #8b938d;
  background: #f7f8f6;
  font-size: 9px;
  font-weight: 680;
}

.organizer-row {
  width: 100%;
  height: 100%;
  overflow: hidden;
  padding: 11px 15px;
  border: 0;
  border-bottom: 1px solid #e8ebe8;
  color: #4f5952;
  background: #fff;
  text-align: left;
}

.organizer-row:hover {
  background: #f8faf8;
}

.organizer-row.selected {
  background: #f1f6f3;
  box-shadow: inset 2px 0 #557863;
}

.organizer-item-copy {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.organizer-item-copy strong,
.organizer-item-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.organizer-item-copy strong {
  color: #2f3933;
  font-size: 11px;
  font-weight: 630;
}

.organizer-item-copy small,
.organizer-basis,
.organizer-row time {
  color: #7b847e;
  font-size: 9px;
}

.quadrant-chip,
.review-chip {
  width: fit-content;
  border-radius: 999px;
  padding: 4px 7px;
  font-size: 9px;
  font-weight: 650;
  white-space: nowrap;
}

.quadrant-chip {
  display: grid;
  gap: 1px;
  color: #59655e;
  background: #f0f2ef;
}

.quadrant-chip small {
  color: inherit;
  font-size: 7px;
  font-weight: 520;
  opacity: .75;
}

.quadrant-chip.known_known {
  color: #356047;
  background: #edf6f0;
}

.quadrant-chip.known_unknown {
  color: #77602f;
  background: #f7f2e5;
}

.quadrant-chip.unknown_known {
  color: #4d5f78;
  background: #eef2f7;
}

.quadrant-chip.unknown_unknown {
  color: #725d70;
  background: #f5eff4;
}

.review-chip.state-confirmed {
  color: #356047;
  background: #edf6f0;
}

.review-chip.state-agent_confirmed {
  color: #4d5f78;
  background: #eef2f7;
}

.review-chip.state-pending {
  color: #77602f;
  background: #f7f2e5;
}

.organizer-basis {
  display: -webkit-box;
  overflow-wrap: anywhere;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.organizer-loading-inline {
  min-width: 100%;
  padding: 10px 15px;
  color: #7b847e;
  font-size: 9px;
  text-align: center;
}

@media (max-width: 1260px) {
  .review-state-filter > span,
  .quadrant-filter > span,
  .organizer-result-summary {
    display: none;
  }

  .organizer-table-head,
  .organizer-row {
    grid-template-columns: minmax(210px, 1fr) 108px 104px minmax(140px, .8fr) 104px;
  }

  .organizer-directory {
    --organizer-list-min-width: 760px;
  }
}

@media (max-width: 1040px) {
  .organizer-search {
    max-width: none;
    flex-basis: 100%;
  }

  .review-state-filter,
  .quadrant-filter {
    flex: 1 1 auto;
  }

  .organizer-toolbar-actions {
    flex: 1 0 100%;
    justify-content: flex-end;
  }

  .organizer-layout.has-selection {
    grid-template-columns: minmax(0, 1fr) 280px;
  }

  .organizer-table-head,
  .organizer-row {
    grid-template-columns: minmax(210px, 1fr) 108px 104px;
  }

  .organizer-directory {
    --organizer-list-min-width: 470px;
  }

  .organizer-table-head > :nth-child(n + 4),
  .organizer-basis,
  .organizer-row time {
    display: none;
  }

}

@media (max-width: 720px) {
  .review-state-filter,
  .quadrant-filter {
    width: 100%;
    flex-basis: 100%;
  }
}
</style>
