<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

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
const pageTitle = computed(() => {
  if (profile.value?.status === 'active') return t('writingTaste.page.activeTitle')
  if (profile.value?.status === 'preview_ready') return t('writingTaste.page.previewTitle')
  return t('writingTaste.page.collectingTitle')
})
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
  <section class="view writing-taste-view">
    <RouterLink class="writing-taste-back" to="/preferences">
      <span aria-hidden="true">←</span>
      {{ t('writingTaste.page.back') }}
    </RouterLink>

    <GrowthLoading v-if="loading && profile && !showInitialLoading" variant="inline" :label="t('writingTaste.page.loading')" />
    <GrowthLoading v-if="showInitialLoading" :label="t('writingTaste.page.loading')" />

    <div v-else-if="initialLoading" class="view-loading" aria-busy="true" />
    <div v-else-if="!profile" class="writing-taste-unavailable">
      <p :role="loadFailed ? 'alert' : undefined">{{ t(loadFailed ? 'common.errors.loadFailed' : 'writingTaste.page.profileUnavailable') }}</p>
      <button v-if="store.activePersonalSpace" type="button" class="secondary-action" @click="load()">{{ t('common.actions.retry') }}</button>
    </div>

    <template v-else>
      <header class="writing-taste-hero" :class="`status-${profile.status}`">
        <div class="writing-taste-hero__copy">
          <span class="writing-taste-status">
            <i aria-hidden="true" />
            {{ t(`writingTaste.status.${profile.status}`) }}
          </span>
          <h2>{{ pageTitle }}</h2>
          <p>{{ pageCopy }}</p>
        </div>
        <div class="writing-taste-hero__score" aria-hidden="true">
          <strong>{{ profile.readiness.rule_count }}</strong>
          <span>/ {{ profile.readiness.thresholds.rule_count }}</span>
          <small>{{ t('writingTaste.criteria.rules') }}</small>
        </div>
      </header>

      <section
        class="writing-taste-readiness"
        :aria-label="t('writingTaste.page.readinessAria')"
      >
        <article
          v-for="criterion in profile.readiness.criteria"
          :key="criterion.key"
          :class="{ met: criterion.met }"
        >
          <span aria-hidden="true">{{ criterion.met ? '✓' : '·' }}</span>
          <div>
            <strong>{{ t(`writingTaste.criteria.${criterion.key}`) }}</strong>
            <small>{{ criterionValue(criterion) }}</small>
          </div>
        </article>
      </section>

      <section class="writing-taste-rules">
        <header>
          <h2>{{ t('writingTaste.page.rulesTitle') }}</h2>
          <span>{{ profile.rules.length }}</span>
        </header>

        <div v-if="profile.rules.length" class="writing-taste-rule-list">
          <article
            v-for="rule in profile.rules"
            :key="`${rule.item_kind}:${rule.item_id}`"
            class="writing-taste-rule"
            :class="{
              'has-conflict': rule.has_conflict,
              'is-hypothesis': rule.evidence_status === 'Working hypothesis',
            }"
          >
            <div class="writing-taste-rule__status">
              <span :class="rule.evidence_status.replaceAll(' ', '-').toLowerCase()">
                {{ t(`writingTaste.evidenceStatus.${rule.evidence_status}`) }}
              </span>
              <span>{{ scopeLabel(rule) }}</span>
              <span v-if="rule.has_conflict" class="conflict">
                {{ t('writingTaste.page.conflict') }}
              </span>
            </div>

            <div class="writing-taste-rule__body">
              <h3>{{ rule.title }}</h3>
              <p>{{ rule.instruction }}</p>
              <UiDisclosure v-if="rule.reason || rule.contexts.length" :title="t('ui.details')">
                <p v-if="rule.reason">{{ rule.reason }}</p>
                <p v-if="rule.contexts.length">{{ t('writingTaste.page.contexts', { contexts: rule.contexts.join('、') }) }}</p>
              </UiDisclosure>
            </div>

            <footer>
              <div>
                <span>{{ t('writingTaste.page.evidence', { evidence: rule.evidence_count }) }}</span>
                <span>{{ t('writingTaste.page.sessions', { sessions: rule.session_count }) }}</span>
                <span v-if="rule.updated_at">
                  {{ t('writingTaste.page.updated', { time: formatTime(rule.updated_at) }) }}
                </span>
              </div>
              <div v-if="itemForRule(rule)" class="writing-taste-rule__actions">
                <button class="secondary-action" type="button" @click="editRule(rule)">
                  {{ t('writingTaste.page.edit') }}
                </button>
                <button
                  v-if="rule.evidence_status !== 'Confirmed'"
                  class="primary-action"
                  type="button"
                  @click="confirmRule(rule)"
                >
                  {{ t('writingTaste.page.confirm') }}
                </button>
              </div>
            </footer>
          </article>
        </div>

        <div v-else class="writing-taste-empty">
          {{ t('writingTaste.page.rulesEmpty') }}
        </div>
      </section>

      <section v-if="profile.ready && profile.agent_markdown" class="writing-taste-agent-preview">
        <div>
          <h2>{{ t('writingTaste.page.agentPreviewTitle') }}</h2>
        </div>
        <button class="secondary-action" type="button" @click="showAgentPreview = !showAgentPreview">
          {{ showAgentPreview
            ? t('writingTaste.page.hideAgentPreview')
            : t('writingTaste.page.showAgentPreview') }}
        </button>
        <pre v-if="showAgentPreview">{{ profile.agent_markdown }}</pre>
      </section>
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
.writing-taste-view {
  overflow: auto;
  padding: 18px 32px 40px;
  background: var(--color-surface-subtle);
}

.writing-taste-view > :not(.vue-dialog) {
  width: min(980px, 100%);
  margin-inline: auto;
}

.writing-taste-back {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 14px;
  color: var(--color-muted);
  text-decoration: none;
  font-size: 12px;
  font-weight: 700;
}

.writing-taste-back:hover {
  color: var(--color-ink);
}

.writing-taste-hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 24px;
  padding: 24px 26px;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: var(--color-surface);
  box-shadow: 0 12px 32px rgba(45, 61, 52, 0.06);
}

.writing-taste-hero.status-preview_ready,
.writing-taste-hero.status-active {
  border-color: var(--color-success-soft);
}

.writing-taste-hero__copy {
  display: grid;
  gap: 7px;
}

.writing-taste-status {
  display: inline-flex;
  align-items: center;
  justify-self: start;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 999px;
  color: var(--color-muted);
  background: var(--color-surface-subtle);
  font-size: 12px;
  font-weight: 800;
}

.writing-taste-status i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-muted);
}

.writing-taste-hero h2,
.writing-taste-hero p {
  margin: 0;
}

.writing-taste-hero h2 {
  color: var(--color-ink);
  font-size: 22px;
  letter-spacing: -0.015em;
}

.writing-taste-hero p {
  max-width: 680px;
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.65;
}

.writing-taste-hero__score {
  min-width: 104px;
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: baseline;
  padding: 14px 16px;
  border-left: 1px solid var(--color-border);
  color: var(--color-muted);
}

.writing-taste-hero__score strong {
  color: var(--color-ink);
  font-size: 28px;
}

.writing-taste-hero__score span {
  font-size: 12px;
}

.writing-taste-hero__score small {
  grid-column: 1 / -1;
  font-size: 12px;
}

.writing-taste-readiness {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 8px;
  margin-top: 12px;
}

.writing-taste-readiness article {
  min-width: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-control);
  color: var(--color-muted);
  background: var(--color-surface);
}

.writing-taste-readiness article.met {
  color: var(--color-muted);
  border-color: var(--color-border-strong);
  background: var(--color-surface);
}

.writing-taste-readiness article > span {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--color-surface-subtle);
  font-size: 12px;
  font-weight: 800;
}

.writing-taste-readiness article.met > span {
  color: var(--color-surface);
  background: var(--color-muted);
}

.writing-taste-readiness article div {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.writing-taste-readiness strong,
.writing-taste-readiness small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.writing-taste-readiness strong {
  color: var(--color-ink);
  font-size: 12px;
}

.writing-taste-readiness small {
  font-size: 12px;
}

.writing-taste-rules {
  margin-top: 24px;
}

.writing-taste-rules > header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 2px 10px;
}

.writing-taste-rules > header h2 {
  margin: 0;
  color: var(--color-ink);
  font-size: 15px;
}

.writing-taste-rules > header span {
  min-width: 20px;
  padding: 2px 6px;
  border-radius: 999px;
  color: var(--color-muted);
  background: var(--color-surface-subtle);
  text-align: center;
  font-size: 12px;
  font-weight: 800;
}

.writing-taste-rule-list {
  display: grid;
  gap: 9px;
}

.writing-taste-rule {
  display: grid;
  gap: 10px;
  padding: 15px 17px;
  border: 1px solid var(--color-border);
  border-radius: 11px;
  background: var(--color-surface);
}

.writing-taste-rule.is-hypothesis {
  background: var(--color-surface);
}

.writing-taste-rule.has-conflict {
  border-color: var(--color-border-strong);
}

.writing-taste-rule__status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.writing-taste-rule__status span {
  padding: 2px 7px;
  border-radius: 999px;
  color: var(--color-muted);
  background: var(--color-surface-subtle);
  font-size: 12px;
  font-weight: 800;
}

.writing-taste-rule__status .confirmed,
.writing-taste-rule__status .observed {
  color: var(--color-success);
  background: var(--color-success-soft);
}

.writing-taste-rule__status .conflict {
  color: var(--color-danger);
  background: var(--color-danger-soft);
}

.writing-taste-rule__body {
  display: grid;
  gap: 5px;
}

.writing-taste-rule h3,
.writing-taste-rule p {
  margin: 0;
}

.writing-taste-rule h3 {
  color: var(--color-ink);
  font-size: 13px;
}

.writing-taste-rule p {
  color: var(--color-ink);
  font-size: 12px;
  line-height: 1.65;
}

.writing-taste-rule__body small {
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.5;
}

.writing-taste-rule footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding-top: 9px;
  border-top: 1px solid var(--color-border);
}

.writing-taste-rule footer > div:first-child {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  color: var(--color-muted);
  font-size: 12px;
}

.writing-taste-rule__actions {
  display: flex;
  gap: 7px;
}

.writing-taste-rule__actions button,
.writing-taste-agent-preview button {
  padding: 6px 10px;
  font-size: 12px;
}

.writing-taste-empty,
.writing-taste-unavailable {
  display: grid;
  min-height: 180px;
  place-items: center;
  border: 1px dashed var(--color-border);
  border-radius: 11px;
  color: var(--color-muted);
  font-size: 12px;
}

.writing-taste-agent-preview {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
  margin-top: 22px;
  padding: 16px 18px;
  border: 1px solid var(--color-border);
  border-radius: 11px;
  background: var(--color-surface-subtle);
}

.writing-taste-agent-preview h2,
.writing-taste-agent-preview p {
  margin: 0;
}

.writing-taste-agent-preview h2 {
  color: var(--color-ink);
  font-size: 13px;
}

.writing-taste-agent-preview p {
  margin-top: 4px;
  color: var(--color-muted);
  font-size: 12px;
  line-height: 1.5;
}

.writing-taste-agent-preview pre {
  grid-column: 1 / -1;
  max-height: 360px;
  overflow: auto;
  margin: 0;
  padding: 14px;
  border-radius: var(--radius-control);
  color: var(--color-surface-subtle);
  background: var(--color-ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: 10px/1.65 ui-monospace, SFMono-Regular, Menlo, monospace;
}

@media (max-width: 980px) {
  .writing-taste-readiness {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 680px) {
  .writing-taste-view {
    padding-inline: 18px;
  }

  .writing-taste-hero {
    grid-template-columns: 1fr;
  }

  .writing-taste-hero__score {
    border-top: 1px solid var(--color-border);
    border-left: 0;
  }

  .writing-taste-readiness {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .writing-taste-rule footer,
  .writing-taste-agent-preview {
    align-items: start;
    flex-direction: column;
    grid-template-columns: 1fr;
  }

  .writing-taste-agent-preview pre {
    grid-column: 1;
  }
}
</style>
