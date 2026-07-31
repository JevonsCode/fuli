<script setup lang="ts">
import { t } from '@/i18n'
import type { KnowledgeItem } from '@/types'
import {
  formatTime,
  humanChangeStatusLabel,
  knowledgeReviewState,
  latestItemValue,
  profileAspectLabel,
  projectMaterialTypeLabel,
  quadrantLabel,
  reviewStateLabel,
} from './model'

type DirectorySection = 'knowledge' | 'materials'
type ContentStatus = 'current' | 'historical' | 'all'

defineProps<{
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
  sourceLabel: (item: KnowledgeItem) => string
}>()

const emit = defineEmits<{
  'change-section': [section: DirectorySection]
  'update-status': [status: ContentStatus]
  'select-item': [item: KnowledgeItem]
}>()

function itemKey(item: Pick<KnowledgeItem, 'itemKind' | 'id'>) {
  return `${item.itemKind}:${item.id}`
}
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
          <span>{{ t('knowledge.workspace.workspace.view.knowledgeCopy') }}</span>
        </div>
        <div
          class="knowledge-status-filter"
          role="group"
          :aria-label="t('knowledge.workspace.workspace.view.knowledgeStatusAria')"
        >
          <button
            class="knowledge-status-option"
            data-status="current"
            type="button"
            :aria-pressed="contentStatus === 'current'"
            @click="emit('update-status', 'current')"
          >
            {{ t('common.status.current') }} <span>{{ currentItemCount }}</span>
          </button>
          <button
            class="knowledge-status-option"
            data-status="historical"
            type="button"
            :aria-pressed="contentStatus === 'historical'"
            @click="emit('update-status', 'historical')"
          >
            {{ t('common.status.invalid') }} <span>{{ historicalItemCount }}</span>
          </button>
          <button
            class="knowledge-status-option"
            data-status="all"
            type="button"
            :aria-pressed="contentStatus === 'all'"
            @click="emit('update-status', 'all')"
          >
            {{ t('common.status.all') }} <span>{{ allItems.length }}</span>
          </button>
        </div>
        <small class="directory-section-count">
          {{ t('common.counts.items', { count: visibleItems.length }) }}
        </small>
      </header>
      <div class="knowledge-table-head" aria-hidden="true">
        <span class="knowledge-column-content">{{ t('knowledge.workspace.workspace.view.columns.content') }}</span>
        <span class="knowledge-column-quadrant">{{ t('knowledge.workspace.workspace.view.columns.quadrant') }}</span>
        <span class="knowledge-column-review">{{ t('knowledge.workspace.workspace.view.columns.review') }}</span>
        <span class="knowledge-column-type">{{ t('knowledge.workspace.workspace.view.columns.type') }}</span>
        <span class="knowledge-column-source">{{ t('knowledge.workspace.workspace.view.columns.source') }}</span>
        <span class="knowledge-column-time">{{ t('knowledge.workspace.workspace.view.columns.updated') }}</span>
        <span class="knowledge-column-validity">{{ t('knowledge.workspace.workspace.view.columns.validity') }}</span>
      </div>
      <div class="knowledge-directory-list">
        <button
          v-for="item in visibleItems"
          :key="itemKey(item)"
          class="knowledge-row"
          :class="{
            selected: selectedItem?.itemKind === item.itemKind
              && selectedItem?.id === item.id,
          }"
          type="button"
          :data-item-key="itemKey(item)"
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
              {{ item.profileAspect
                ? `${profileAspectLabel(item.profileAspect)} · ${item.body}`
                : item.body }}
            </small>
          </span>
          <span class="knowledge-row-quadrant" :class="item.originQuadrant">
            {{ quadrantLabel(item.originQuadrant) }}
          </span>
          <span class="knowledge-review-state" :class="`state-${knowledgeReviewState(item)}`">
            {{ reviewStateLabel(item) }}
          </span>
          <span class="knowledge-row-type">{{ item.type }}</span>
          <span class="knowledge-row-source">{{ sourceLabel(item) }}</span>
          <span class="knowledge-row-time">{{ formatTime(latestItemValue(item)) }}</span>
          <span class="knowledge-status" :class="item.invalidAt ? 'historical' : 'current'">
            {{ item.invalidAt
              ? t('common.status.invalid')
              : t('knowledge.workspace.workspace.view.active') }}
          </span>
        </button>
      </div>
      <div v-if="!visibleItems.length" class="empty-state">
        {{
          allItems.length
            ? t('knowledge.workspace.workspace.view.noFilteredKnowledge')
            : t('knowledge.workspace.workspace.view.noKnowledge')
        }}
      </div>
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
          <span>{{ t('knowledge.workspace.workspace.view.materialCopy') }}</span>
        </div>
        <small class="directory-section-count">
          {{ t('common.counts.items', { count: visibleProjectMaterialItems.length }) }}
        </small>
      </header>
      <div class="project-material-list">
        <button
          v-for="item in visibleProjectMaterialItems"
          :key="itemKey(item)"
          class="project-material-row"
          :class="{
            selected: selectedItem?.itemKind === item.itemKind
              && selectedItem?.id === item.id,
          }"
          type="button"
          :data-item-key="itemKey(item)"
          @click="emit('select-item', item)"
        >
          <span class="project-material-copy">
            <strong>{{ item.itemKind === 'entity' ? item.title : item.type }}</strong>
            <small>{{ item.body }}</small>
          </span>
          <span class="project-material-type">{{ projectMaterialTypeLabel(item) }}</span>
          <span class="project-material-link">{{ t('knowledge.workspace.workspace.view.viewDetails') }}</span>
        </button>
      </div>
      <div v-if="!visibleProjectMaterialItems.length" class="empty-state">
        {{
          projectMaterialItems.length
            ? t('knowledge.workspace.workspace.view.noFilteredMaterials')
            : t('knowledge.workspace.workspace.view.noMaterials')
        }}
      </div>
    </div>
  </section>
</template>
