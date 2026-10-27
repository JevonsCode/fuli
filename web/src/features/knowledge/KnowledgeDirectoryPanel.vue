<script setup lang="ts">
import { computed } from 'vue'

import VirtualDirectoryList from '@/components/VirtualDirectoryList.vue'
import { t } from '@/i18n'
import { UiStatRow, type UiStat } from '@/ui'
import { versionStatusLabel } from '@/features/knowledge-quick-edit/model'
import type { KnowledgeItem } from '@/types'
import {
  distinctSummary,
  formatTime,
  humanChangeStatusLabel,
  knowledgeTypeLabel,
  knowledgeReviewState,
  latestItemValue,
  profileAspectLabel,
  projectMaterialTypeLabel,
  quadrantLabel,
  reviewStateLabel,
  knowledgeItemKey,
} from './model'

type DirectorySection = 'knowledge' | 'materials'
type ContentStatus = 'current' | 'historical' | 'all'

const props = defineProps<{
  personalProjectsOnly: boolean
  directorySection: DirectorySection
  knowledgeTabCount: string
  materialTabCount: string
  contentStatus: ContentStatus
  currentItemCount: number
  historicalItemCount: number
  allItems: KnowledgeItem[]
  visibleItems: KnowledgeItem[]
  projectMaterialItems: KnowledgeItem[]
  visibleProjectMaterialItems: KnowledgeItem[]
  selectedItem: KnowledgeItem | null
  listResetKey: unknown
  sourceLabel: (item: KnowledgeItem) => string
}>()

// The same stat row as every memory page: each validity count is its filter.
// Items that are no longer current form the 历史 group; each says why (rec#5 C8-1).
const statusStats = computed<UiStat[]>(() => [
  { key: 'current', label: t('common.status.current'), value: props.currentItemCount, tone: 'success', pressed: props.contentStatus === 'current', term: 'memory.current' },
  { key: 'historical', label: t('knowledge.workspace.workspace.view.history'), value: props.historicalItemCount, pressed: props.contentStatus === 'historical', term: 'memory.history' },
  { key: 'all', label: t('common.status.all'), value: props.allItems.length, pressed: props.contentStatus === 'all', term: 'memory.all' },
])

const emit = defineEmits<{
  'change-section': [section: DirectorySection]
  'update-status': [status: ContentStatus]
  'select-item': [item: KnowledgeItem]
}>()


const selectedKnowledgeIndex = computed(() => props.selectedItem
  ? props.visibleItems.findIndex((item) => knowledgeItemKey(item) === knowledgeItemKey(props.selectedItem!))
  : -1,
)
const selectedMaterialIndex = computed(() => props.selectedItem
  ? props.visibleProjectMaterialItems.findIndex(
      (item) => knowledgeItemKey(item) === knowledgeItemKey(props.selectedItem!),
    )
  : -1,
)
</script>

<template>
  <section
    class="knowledge-directory-panel"
    :class="{ 'has-directory-tabs': personalProjectsOnly }"
    :aria-label="directorySection === 'materials'
      ? t('knowledge.workspace.workspace.view.materialDirectory')
      : t('knowledge.workspace.workspace.view.knowledgeDirectory')"
  >
    <div
      v-if="personalProjectsOnly"
      class="directory-kind-tabs"
      role="tablist"
      :aria-label="t('knowledge.workspace.workspace.view.directoryTypeAria')"
    >
      <button
        id="directory-tab-knowledge"
        class="directory-kind-tab"
        type="button"
        role="tab"
        aria-controls="directory-panel-knowledge"
        :aria-selected="directorySection === 'knowledge'"
        @click="emit('change-section', 'knowledge')"
      >
        <span>{{ t('knowledge.workspace.workspace.view.knowledgeContent') }}</span>
        <small>{{ knowledgeTabCount }}</small>
      </button>
      <button
        id="directory-tab-materials"
        class="directory-kind-tab"
        type="button"
        role="tab"
        aria-controls="directory-panel-materials"
        :aria-selected="directorySection === 'materials'"
        @click="emit('change-section', 'materials')"
      >
        <span>{{ t('knowledge.workspace.workspace.view.projectMaterials') }}</span>
        <small>{{ materialTabCount }}</small>
      </button>
    </div>

    <div
      v-if="directorySection === 'knowledge'"
      id="directory-panel-knowledge"
      class="directory-tab-panel"
      role="tabpanel"
      aria-labelledby="directory-tab-knowledge"
    >
      <header class="directory-section-heading">
        <div class="directory-section-copy">
          <strong>{{ t('knowledge.workspace.workspace.view.knowledgeContent') }}</strong>
        </div>
        <UiStatRow class="knowledge-status-filter" :items="statusStats" :label="t('knowledge.workspace.workspace.view.knowledgeStatusAria')"
          @select="key => emit('update-status', key as ContentStatus)" />
      </header>
      <!-- @vue-generic {import('@/types').KnowledgeItem} -->
      <VirtualDirectoryList
        class="knowledge-directory-virtual-list"
        scrolls-with="page"
        :items="visibleItems"
        :row-height="68"
        :active-index="selectedKnowledgeIndex"
        :reset-key="listResetKey"
        :item-key="knowledgeItemKey"
        :label="t('knowledge.workspace.workspace.view.knowledgeDirectory')"
      >
        <template #header>
          <div class="knowledge-table-head" aria-hidden="true">
            <span class="knowledge-column-content">{{ t('knowledge.workspace.workspace.view.columns.content') }}</span>
            <span class="knowledge-column-quadrant">{{ t('knowledge.workspace.workspace.view.columns.quadrant') }}</span>
            <span class="knowledge-column-review">{{ t('knowledge.workspace.workspace.view.columns.review') }}</span>
            <span class="knowledge-column-type">{{ t('knowledge.workspace.workspace.view.columns.type') }}</span>
            <span class="knowledge-column-source">{{ t('knowledge.workspace.workspace.view.columns.source') }}</span>
            <span class="knowledge-column-time">{{ t('knowledge.workspace.workspace.view.columns.updated') }}</span>
            <span class="knowledge-column-validity">{{ t('knowledge.workspace.workspace.view.columns.validity') }}</span>
          </div>
        </template>

        <template #default="{ item }">
          <button
            class="knowledge-row"
            :class="{
              selected: selectedItem?.itemKind === item.itemKind
                && selectedItem?.id === item.id,
            }"
            type="button"
            :data-item-key="knowledgeItemKey(item)"
            @click="emit('select-item', item)"
          >
            <span class="knowledge-row-content">
              <span class="knowledge-row-title">
                <strong>{{ item.title }}</strong>
                <em
                  v-if="
                    item.humanChangeStatus === 'unseen'
                    || item.humanChangeStatus === 'viewed'
                  "
                  class="human-change-badge"
                  :class="`state-${item.humanChangeStatus}`"
                >
                  {{ humanChangeStatusLabel(item.humanChangeStatus) }}
                </em>
              </span>
              <small>
                {{ [item.profileAspect ? profileAspectLabel(item.profileAspect) : '', distinctSummary(item)]
                  .filter(Boolean).join(' · ') }}
              </small>
            </span>
            <span class="knowledge-row-quadrant" :class="item.originQuadrant">
              {{ quadrantLabel(item.originQuadrant) }}
            </span>
            <span class="knowledge-review-state" :class="`state-${knowledgeReviewState(item)}`">
              {{ reviewStateLabel(item) }}
            </span>
            <span class="knowledge-row-type" :title="item.type">
              {{ knowledgeTypeLabel(item).label }}
              <small v-if="knowledgeTypeLabel(item).unknownType" data-unknown-type>{{ knowledgeTypeLabel(item).unknownType }}</small>
            </span>
            <span class="knowledge-row-source">{{ sourceLabel(item) }}</span>
            <!-- Minutes in a roomy table, the date alone in a narrow one; the full time on hover. -->
            <span class="knowledge-row-time" :title="formatTime(latestItemValue(item))">
              <span class="knowledge-time-minute">{{ formatTime(latestItemValue(item), 'minute') }}</span>
              <span class="knowledge-time-day">{{ formatTime(latestItemValue(item), 'day') }}</span>
            </span>
            <span class="knowledge-status" :class="item.invalidAt ? 'historical' : 'current'">
              {{ item.invalidAt
                ? versionStatusLabel(item.versionStatus ?? 'inactive')
                : t('knowledge.workspace.workspace.view.active') }}
            </span>
          </button>
        </template>

        <template #empty>
          <div class="empty-state">
            {{
              allItems.length
                ? t('knowledge.workspace.workspace.view.noFilteredKnowledge')
                : t('knowledge.workspace.workspace.view.noKnowledge')
            }}
          </div>
        </template>
      </VirtualDirectoryList>
    </div>

    <div
      v-else
      id="directory-panel-materials"
      class="directory-tab-panel"
      role="tabpanel"
      aria-labelledby="directory-tab-materials"
    >
      <header class="directory-section-heading">
        <div class="directory-section-copy">
          <strong>{{ t('knowledge.workspace.workspace.view.projectMaterials') }}</strong>
        </div>
        <small class="directory-section-count">
          {{ t('common.counts.items', { count: visibleProjectMaterialItems.length }) }}
        </small>
      </header>
      <!-- @vue-generic {import('@/types').KnowledgeItem} -->
      <VirtualDirectoryList
        class="project-material-virtual-list"
        scrolls-with="page"
        :items="visibleProjectMaterialItems"
        :row-height="48"
        :active-index="selectedMaterialIndex"
        :reset-key="listResetKey"
        :item-key="knowledgeItemKey"
        :label="t('knowledge.workspace.workspace.view.materialDirectory')"
      >
        <template #header>
          <div class="project-material-head" aria-hidden="true">
            <span>{{ t('knowledge.workspace.workspace.view.columns.name') }}</span>
            <span class="project-material-head-description">{{ t('knowledge.workspace.workspace.view.columns.description') }}</span>
            <span class="project-material-head-type">{{ t('knowledge.workspace.workspace.view.columns.type') }}</span>
            <span />
          </div>
        </template>

        <template #default="{ item }">
          <button
            class="project-material-row"
            :class="{
              selected: selectedItem?.itemKind === item.itemKind
                && selectedItem?.id === item.id,
            }"
            type="button"
            :data-item-key="knowledgeItemKey(item)"
            @click="emit('select-item', item)"
          >
            <span class="project-material-copy">
              <strong>{{ item.itemKind === 'entity' ? item.title : knowledgeTypeLabel(item).label }}</strong>
              <small>{{ item.body }}</small>
            </span>
            <span class="project-material-type">{{ projectMaterialTypeLabel(item) }}</span>
            <span class="project-material-link">{{ t('knowledge.workspace.workspace.view.viewDetails') }}</span>
          </button>
        </template>

        <template #empty>
          <div class="empty-state">
            {{
              projectMaterialItems.length
                ? t('knowledge.workspace.workspace.view.noFilteredMaterials')
                : t('knowledge.workspace.workspace.view.noMaterials')
            }}
          </div>
        </template>
      </VirtualDirectoryList>
    </div>
  </section>
</template>
