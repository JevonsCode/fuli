<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { getJson } from '@/api/client'
import { readPersonalProfileGraph } from '@/api/personal-profile-graph'
import GrowthLoading from '@/components/GrowthLoading.vue'
import UiDisclosure from '@/components/UiDisclosure.vue'
import { useMinimumLoadingDisplay } from '@/composables/useMinimumLoadingDisplay'
import KnowledgeConfirmDialog from '@/features/knowledge/KnowledgeConfirmDialog.vue'
import KnowledgeEditDialog from '@/features/knowledge/KnowledgeEditDialog.vue'
import { formatTime, personalProfileItems } from '@/features/knowledge/model'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { UiButton, UiChip, UiEmpty, UiIconButton, UiStatRow, UiToolbar, type UiStat } from '@/ui'
import type {
  KnowledgeGraph,
  KnowledgeItem,
  WritingTasteProfile,
  WritingTasteReadinessCriterion,
  WritingTasteRule,
} from '@/types'

const store = useConsoleStore()
const profile = ref<WritingTasteProfile | null>(null)
const graph = ref<KnowledgeGraph | null>(null)
const loading = ref(false)
const loadFailed = ref(false)
const confirmingItem = ref<KnowledgeItem | null>(null)
const editingItem = ref<KnowledgeItem | null>(null)
const showAgentPreview = ref(false)
let loadVersion = 0
let loadController: AbortController | null = null

const initialLoading = computed(() => loading.value && !profile.value)
const showInitialLoading = useMinimumLoadingDisplay(initialLoading)
const profileItems = computed(() => personalProfileItems(graph.value))
const itemsByKey = computed(() => new Map(
  profileItems.value.map((item) => [`${item.itemKind}:${item.id}`, item]),
))
// One stat row like every memory page: the profile state, then each readiness criterion.
const stats = computed<UiStat[]>(() => {
  if (!profile.value) return []
  const status = profile.value.status
  return [
    { key: 'status', label: t('writingTaste.page.statusLabel'), value: t(`writingTaste.status.${status}`),
      tone: status === 'active' ? 'success' : status === 'preview_ready' ? 'accent' : 'warning' },
    ...profile.value.readiness.criteria.map((criterion): UiStat => ({
      key: criterion.key, label: t(`writingTaste.criteria.${criterion.key}`), value: criterionValue(criterion),
      tone: criterion.met ? 'success' : 'neutral',
    })),
  ]
})
const evidenceTone = (rule: WritingTasteRule) => rule.evidence_status === 'Confirmed' ? 'accent' : rule.evidence_status === 'Working hypothesis' ? 'warning' : 'neutral'
const pageCopy = computed(() => {
  if (profile.value?.status === 'active') return t('writingTaste.page.activeCopy')
  if (profile.value?.status === 'preview_ready') return t('writingTaste.page.previewCopy')
  return t('writingTaste.page.collectingCopy')
})

watch(
  () => store.activePersonalSpace?.id,
  (spaceId) => {
    profile.value = null
    graph.value = null
    confirmingItem.value = null
    editingItem.value = null
    showAgentPreview.value = false
    void load(spaceId)
  },
  { immediate: true, flush: 'sync' },
)

async function load(spaceId = store.activePersonalSpace?.id) {
  const version = ++loadVersion
  loadController?.abort()
  loadController = null
  loadFailed.value = false
  if (!spaceId) {
    loading.value = false
    return
  }
  const controller = new AbortController()
  loadController = controller
  loading.value = true
  try {
    const tasteQuery = new URLSearchParams({
      personalSpaceId: spaceId,
      limit: '500',
    })
    const [nextProfile, nextGraph] = await Promise.all([
      getJson<WritingTasteProfile>(`/api/writing-taste-profile?${tasteQuery}`, { signal: controller.signal }),
      readPersonalProfileGraph(spaceId, controller.signal),
    ])
    if (version !== loadVersion) return
    profile.value = isWritingTasteProfile(nextProfile) ? nextProfile : null
    graph.value = isKnowledgeGraph(nextGraph) ? nextGraph : null
    refreshDialogItems()
  } catch (error) {
    if (version !== loadVersion) return
    profile.value = null
    graph.value = null
    loadFailed.value = true
  } finally {
    if (version === loadVersion) {
      loading.value = false
      loadController = null
    }
  }
}

onBeforeUnmount(() => {
  loadVersion += 1
  loadController?.abort()
})

function itemForRule(rule: WritingTasteRule) {
  return itemsByKey.value.get(`${rule.item_kind}:${rule.item_id}`) ?? null
}

function confirmRule(rule: WritingTasteRule) {
  confirmingItem.value = itemForRule(rule)
}

function editRule(rule: WritingTasteRule) {
  editingItem.value = itemForRule(rule)
}

function scopeLabel(rule: WritingTasteRule) {
  if (rule.preference_scope !== 'project' || !rule.preference_project_id) {
    return t('writingTaste.page.globalScope')
  }
  const project = store.state?.personalProjects?.find(
    ({ project_id }) => project_id === rule.preference_project_id,
  )
  return t('writingTaste.page.projectScope', {
    project: project?.profile.name ?? rule.preference_project_id,
  })
}

function criterionValue(criterion: WritingTasteReadinessCriterion) {
  if (criterion.key === 'conflicts') {
    return t('writingTaste.criteria.conflictsProgress', { current: criterion.current })
  }
  return t('writingTaste.criteria.progress', {
    current: criterion.current,
    target: criterion.target,
  })
}

function refreshDialogItems() {
  if (confirmingItem.value) {
    confirmingItem.value = itemsByKey.value.get(
      `${confirmingItem.value.itemKind}:${confirmingItem.value.id}`,
    ) ?? null
  }
  if (editingItem.value) {
    editingItem.value = itemsByKey.value.get(
      `${editingItem.value.itemKind}:${editingItem.value.id}`,
    ) ?? null
  }
}

function isWritingTasteProfile(value: unknown): value is WritingTasteProfile {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WritingTasteProfile>
  return ['collecting', 'preview_ready', 'active'].includes(candidate.status ?? '')
    && Boolean(candidate.readiness)
    && Array.isArray(candidate.rules)
}

function isKnowledgeGraph(value: unknown): value is KnowledgeGraph {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<KnowledgeGraph>
  return Array.isArray(candidate.nodes) && Array.isArray(candidate.edges)
}
</script>

<template>
  <section class="view page-stack writing-taste-view">
    <GrowthLoading v-if="loading && profile && !showInitialLoading" variant="inline" :label="t('writingTaste.page.loading')" />
    <GrowthLoading v-if="showInitialLoading" :label="t('writingTaste.page.loading')" />

    <div v-else-if="initialLoading" class="view-loading" aria-busy="true" />
    <div v-else-if="!profile" class="writing-taste-unavailable" :role="loadFailed ? 'alert' : undefined">
      <UiEmpty :text="t(loadFailed ? 'common.errors.loadFailed' : 'writingTaste.page.profileUnavailable')">
        <UiButton v-if="store.activePersonalSpace" size="sm" data-retry @click="load()">{{ t('common.actions.retry') }}</UiButton>
      </UiEmpty>
    </div>

    <template v-else>
      <UiStatRow :items="stats" :label="t('writingTaste.page.readinessAria')" />
      <p class="page-lede">{{ pageCopy }}</p>

      <UiToolbar>
        <h2 class="list-title">{{ t('writingTaste.page.rulesTitle') }}<span>{{ profile.rules.length }}</span></h2>
        <template #end>
          <UiButton v-if="profile.ready && profile.agent_markdown" variant="ghost" size="sm" data-agent-preview-toggle @click="showAgentPreview = !showAgentPreview">
            {{ showAgentPreview ? t('writingTaste.page.hideAgentPreview') : t('writingTaste.page.showAgentPreview') }}
          </UiButton>
          <UiIconButton icon="refresh" size="sm" :label="t('common.actions.refresh')" :disabled="loading" @click="load()" />
        </template>
      </UiToolbar>

      <pre v-if="showAgentPreview && profile.agent_markdown" class="ui-list writing-taste-agent-preview" data-agent-preview :aria-label="t('writingTaste.page.agentPreviewTitle')">{{ profile.agent_markdown }}</pre>

      <div v-if="profile.rules.length" class="ui-list">
        <article v-for="rule in profile.rules" :key="`${rule.item_kind}:${rule.item_id}`" class="ui-list-row" data-writing-rule>
          <div class="ui-list-main">
            <strong class="ui-list-heading">{{ rule.title }}</strong>
            <p class="ui-list-text">{{ rule.instruction }}</p>
            <UiDisclosure v-if="rule.reason || rule.contexts.length" :title="t('ui.details')">
              <p v-if="rule.reason">{{ rule.reason }}</p>
              <p v-if="rule.contexts.length">{{ t('writingTaste.page.contexts', { contexts: rule.contexts.join('、') }) }}</p>
            </UiDisclosure>
            <div class="ui-list-meta">
              <UiChip :tone="evidenceTone(rule)">{{ t(`writingTaste.evidenceStatus.${rule.evidence_status}`) }}</UiChip>
              <UiChip v-if="rule.has_conflict" tone="danger">{{ t('writingTaste.page.conflict') }}</UiChip>
              <span>{{ scopeLabel(rule) }}</span>
              <span>{{ t('writingTaste.page.evidence', { evidence: rule.evidence_count }) }}</span>
              <span>{{ t('writingTaste.page.sessions', { sessions: rule.session_count }) }}</span>
              <span v-if="rule.updated_at">{{ t('writingTaste.page.updated', { time: formatTime(rule.updated_at) }) }}</span>
            </div>
          </div>
          <div v-if="itemForRule(rule)" class="ui-list-actions">
            <UiButton variant="ghost" size="sm" data-rule-edit @click="editRule(rule)">{{ t('writingTaste.page.edit') }}</UiButton>
            <UiButton v-if="rule.evidence_status !== 'Confirmed'" size="sm" data-rule-confirm @click="confirmRule(rule)">{{ t('writingTaste.page.confirm') }}</UiButton>
          </div>
        </article>
      </div>
      <UiEmpty v-else class="ui-list" :text="t('writingTaste.page.rulesEmpty')" />
    </template>

    <KnowledgeEditDialog
      :item="editingItem"
      :personal-space-id="store.activePersonalSpace?.id ?? ''"
      :personal-project-id="null"
      :projects="store.state?.personalProjects ?? []"
      :replacement-items="profileItems"
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
  </section>
</template>

<style scoped>
.writing-taste-agent-preview { margin: 0; padding: 14px 16px; overflow: auto; color: var(--color-ink-soft); font-family: var(--font-mono); font-size: 12px; line-height: 1.6; white-space: pre-wrap; }
</style>
