<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { getJson } from '@/api/client'
import KnowledgeBatchConfirmDialog from '@/features/knowledge/KnowledgeBatchConfirmDialog.vue'
import KnowledgeConfirmDialog from '@/features/knowledge/KnowledgeConfirmDialog.vue'
import KnowledgeEditDialog from '@/features/knowledge/KnowledgeEditDialog.vue'
import KnowledgeInspector from '@/features/knowledge/KnowledgeInspector.vue'
import {
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
import { useConsoleStore } from '@/stores/console'
import type { KnowledgeGraph, KnowledgeItem } from '@/types'

const store = useConsoleStore()
const graph = ref<KnowledgeGraph | null>(null)
const loading = ref(false)
const query = ref('')
const activeQuadrant = ref('all')
const activeReviewState = ref<'all' | KnowledgeReviewState>('all')
const selectedItem = ref<KnowledgeItem | null>(null)
const confirmingItem = ref<KnowledgeItem | null>(null)
const editingItem = ref<KnowledgeItem | null>(null)
const batchDialogOpen = ref(false)

const quadrantChoices = [
  { value: 'known_unknown', short: '明确问题', coordinate: '已意识 · 未掌握' },
  { value: 'known_known', short: '明确表达', coordinate: '已意识 · 已掌握' },
  { value: 'unknown_unknown', short: '盲点探索', coordinate: '未意识 · 未掌握' },
  { value: 'unknown_known', short: '隐性提炼', coordinate: '未意识 · 已掌握' },
] as const

const reviewChoices: Array<{
  value: KnowledgeReviewState
  label: string
  hint: string
}> = [
  { value: 'pending', label: '待确认', hint: '尚无有效的确认人和确认时间' },
  { value: 'agent_confirmed', label: 'Agent 已确认', hint: '实际使用达到策略阈值，权重低于人工确认' },
  { value: 'confirmed', label: '已确认', hint: '内容与象限归类均已确认' },
]

const items = computed(() => knowledgeItems(graph.value))
const confirmationGroups = computed(() => batchConfirmationGroups(items.value))
const quadrantCounts = computed(() =>
  Object.fromEntries(
    [...quadrantChoices.map(({ value }) => value), 'unclassified']
      .map((value) => [value, items.value.filter((item) => item.originQuadrant === value).length]),
  ),
)
const reviewCounts = computed(() =>
  Object.fromEntries(
    reviewChoices.map(({ value }) => [
      value,
      items.value.filter((item) => knowledgeReviewState(item) === value).length,
    ]),
  ) as Record<KnowledgeReviewState, number>,
)
const hasActiveQuadrant = computed(() => activeQuadrant.value !== 'all')
const activeQuadrantItems = computed(() =>
  hasActiveQuadrant.value
    ? items.value.filter((item) => item.originQuadrant === activeQuadrant.value)
    : items.value,
)
const activeReviewCounts = computed(() =>
  Object.fromEntries(
    reviewChoices.map(({ value }) => [
      value,
      activeQuadrantItems.value.filter((item) => knowledgeReviewState(item) === value).length,
    ]),
  ) as Record<KnowledgeReviewState, number>,
)
const attentionCount = computed(() =>
  reviewCounts.value.pending,
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

async function load(spaceId = store.activePersonalSpace?.id) {
  if (!spaceId) return
  loading.value = true
  try {
    const params = new URLSearchParams({ spaceId, limit: '500' })
    graph.value = await getJson<KnowledgeGraph>(`/api/graph?${params}`)
    if (selectedItem.value) {
      selectedItem.value = items.value.find(({ id }) => id === selectedItem.value?.id) ?? null
    }
  } catch (error) {
    graph.value = null
    store.reportError(error)
  } finally {
    loading.value = false
  }
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
    <div class="organizer-head">
      <div class="organizer-principle">
        <p class="eyebrow">HOW CLASSIFICATION WORKS</p>
        <h3>先看知识和确认状态，四象限只保留发现来源</h3>
        <p>
          待确认内容也可被 Agent 检索；实际使用达到阈值会标记为“Agent 已确认”，人工确认仍具有更高权重。
        </p>
      </div>

      <div class="organizer-attention">
        <strong>{{ attentionCount }}</strong>
        <span>条需要你处理</span>
        <small>旧数据缺少确认记录时也会进入这里</small>
      </div>
    </div>

    <template>
      <div class="organizer-toolbar">
        <label class="organizer-search">
          <span>筛选知识</span>
          <input v-model="query" type="search" placeholder="搜索内容、类型或来源" />
        </label>

        <div class="quadrant-filter" aria-label="发现来源筛选">
          <span>发现来源</span>
          <button
            type="button"
            data-quadrant="all"
            :class="{ active: activeQuadrant === 'all' }"
            :aria-pressed="activeQuadrant === 'all'"
            @click="activeQuadrant = 'all'"
          >
            全部 <strong>{{ items.length }}</strong>
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

        <div class="review-state-filter" aria-label="确认状态筛选">
          <span>确认状态</span>
          <button
            type="button"
            data-review-state="all"
            :class="{ active: activeReviewState === 'all' }"
            :aria-pressed="activeReviewState === 'all'"
            @click="selectReviewState('all')"
          >
            全部 <strong>{{ activeQuadrantItems.length }}</strong>
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

        <p class="organizer-result-summary">
          显示 {{ visibleItems.length }} / {{ activeQuadrantItems.length }} 条
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
          批量确认 · {{ confirmationGroups.length }} 组
        </button>
        <button class="toolbar-action" type="button" @click="load()">刷新</button>
      </div>

      <p v-if="graph?.truncated" class="organizer-truncated">
        当前知识量超过单次读取上限；本页统计只覆盖本次读取到的内容。
      </p>

      <div v-if="loading && !graph" class="view-loading">正在读取知识…</div>
      <div
        v-else
        class="organizer-layout"
        :class="{ 'has-selection': selectedItem }"
      >
        <section class="organizer-directory" aria-label="知识整理目录">
          <div class="organizer-table-head" aria-hidden="true">
            <span>知识内容</span>
            <span>发现时象限</span>
            <span>确认状态</span>
            <span>确认依据</span>
            <span>更新时间</span>
          </div>
          <div class="organizer-list">
            <button
              v-for="item in visibleItems"
              :key="`${item.itemKind}:${item.id}`"
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
          </div>
          <div v-if="!visibleItems.length" class="empty-state">
            {{ items.length ? '当前筛选条件下没有内容' : '个人空间还没有可整理的结构化知识' }}
          </div>
        </section>

        <KnowledgeInspector
          :item="selectedItem"
          :graph="graph"
          editable
          @confirm="confirmingItem = $event"
          @edit="editingItem = $event"
          @open-replacement="openReplacement"
        />
      </div>
    </template>

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

.organizer-head {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px 24px;
}

.organizer-principle {
  min-width: 0;
  align-self: center;
  padding: 0 2px;
}

.organizer-principle h3 {
  font-size: 16px;
}

.organizer-principle > p:last-child {
  max-width: 760px;
  margin-top: 5px;
  color: #6e7771;
  font-size: 11px;
  line-height: 1.55;
}

.organizer-attention {
  grid-column: 2;
  grid-row: 1;
  min-width: 152px;
  padding-left: 20px;
  border-left: 1px solid #dde2de;
  text-align: right;
}

.organizer-attention strong,
.organizer-attention span,
.organizer-attention small {
  display: block;
}

.organizer-attention strong {
  color: #6f582b;
  font-size: 23px;
  font-weight: 620;
}

.organizer-attention span {
  color: #5f675f;
  font-size: 10px;
  font-weight: 650;
}

.organizer-attention small {
  margin-top: 2px;
  color: #8a918b;
  font-size: 8px;
}

.organizer-loading-inline {
  color: #7b847e;
  font-size: 10px;
  text-align: center;
}

.organizer-toolbar {
  min-height: 34px;
  display: flex;
  align-items: center;
  gap: 8px;
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
  flex: 0 0 auto;
  height: 31px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid #d7ddd8;
  border-radius: 7px;
  background: #f1f4f1;
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

.organizer-toolbar .batch-confirm-action {
  margin-left: auto;
}

.organizer-toolbar .toolbar-action + .toolbar-action {
  margin-left: 0;
}

.organizer-truncated {
  margin: -4px 0 0;
  color: #806536;
  font-size: 9px;
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
  min-width: 0;
  overflow: auto;
  overscroll-behavior: contain;
}

.organizer-table-head,
.organizer-row {
  min-width: 920px;
  display: grid;
  grid-template-columns: minmax(230px, 1.35fr) 114px 130px minmax(160px, .8fr) 118px;
  align-items: center;
  gap: 12px;
}

.organizer-table-head {
  position: sticky;
  z-index: 2;
  top: 0;
  padding: 10px 15px;
  border-bottom: 1px solid #e0e4e0;
  color: #8b938d;
  background: #f7f8f6;
  font-size: 9px;
  font-weight: 680;
}

.organizer-row {
  width: 100%;
  min-height: 68px;
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
  overflow-wrap: anywhere;
}

@media (max-width: 1260px) {
  .review-state-filter > span,
  .quadrant-filter > span,
  .organizer-result-summary {
    display: none;
  }

  .organizer-table-head,
  .organizer-row {
    min-width: 760px;
    grid-template-columns: minmax(210px, 1fr) 108px 104px minmax(140px, .8fr) 104px;
  }
}

@media (max-width: 1040px) {
  .organizer-layout.has-selection {
    grid-template-columns: minmax(0, 1fr) 280px;
  }

  .organizer-table-head,
  .organizer-row {
    min-width: 470px;
    grid-template-columns: minmax(210px, 1fr) 108px 104px;
  }

  .organizer-table-head > :nth-child(n + 4),
  .organizer-basis,
  .organizer-row time {
    display: none;
  }

  .batch-confirm-action {
    overflow: hidden;
    max-width: 108px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>
