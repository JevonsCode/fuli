<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import DreamingCard from '@/features/model-settings/DreamingCard.vue'
import ModelList from '@/features/model-settings/ModelList.vue'
import ModelRoleCard from '@/features/model-settings/ModelRoleCard.vue'
import ModelRoleDialog from '@/features/model-settings/ModelRoleDialog.vue'
import ModelUsage from '@/features/model-settings/ModelUsage.vue'
import ModelUseDetails from '@/features/model-settings/ModelUseDetails.vue'
import RetrievalTermsCard from '@/features/model-settings/RetrievalTermsCard.vue'
import RoleSuggestions from '@/features/model-settings/RoleSuggestions.vue'
import { useRoleSuggestions } from '@/features/model-settings/useRoleSuggestions'
import {
  SEMANTIC_ROLE, modelGuideUrl, readModelRoles, roleName,
  type ConfigConflict, type ModelRoleId, type ModelRoleView, type ModelRolesPayload,
} from '@/features/model-settings/model'
import { taskState, useRole, type ModelUseId } from '@/features/model-settings/model-uses'
import { currentLocale, t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { usePageRefresh } from '@/layouts/page-refresh'
import { UiNotice } from '@/ui'

// 模型与用量 as one flat model center (rec#8, rec#38, 11-06): first
// every connected model once with who uses it, then every use as a card with
// its state, its model, the one line of what is enough and its quick action
// (接入 or 编辑); its facts, trust and history open in 「查看详情」. Then what
// the roles suggested and their usage. A save is accepted only at the local
// process boundary (a loopback request).
const store = useConsoleStore()
const payload = ref<ModelRolesPayload | null>(null)
const loading = ref(true)
const loadError = ref('')
const editing = ref<ModelRoleId | null>(null)
const details = ref<ModelRoleId | null>(null)
const notice = ref('')
const stale = ref(false)
let reading: AbortController | null = null
// Read together with the role settings, so the section never appears and then goes;
// Tonborg's read follows the active space (useRoleSuggestions).
const activeSpace = computed(() => store.activePersonalSpace?.id ?? '')
const suggestions = useRoleSuggestions(activeSpace)
const { entries: suggestionEntries, loading: suggestionsLoading, error: suggestionsError, reviews, reviewsLoading, reviewsError } = suggestions

const projects = computed(() => store.state?.personalProjects ?? [])
const locked = computed(() => payload.value?.state === 'invalid')
const view = (role: ModelRoleId): ModelRoleView =>
  payload.value?.roles.find(entry => entry.role === role) ?? { role, state: 'not_configured', answeredBy: null }
const astroModel = computed(() => (view('assistant').state === 'enabled' ? view('assistant').connection?.model ?? null : null))
const detailsView = computed(() => (details.value ? view(details.value) : null))

// Whether the settings were read.
async function load() {
  reading?.abort()
  reading = new AbortController()
  loading.value = true
  loadError.value = ''
  try {
    payload.value = await readModelRoles(reading.signal)
    return true
  } catch (cause) {
    if ((cause as Error)?.name !== 'AbortError') loadError.value = apiErrorReason(cause)
    return false
  } finally {
    loading.value = false
  }
}

function edit(role: ModelRoleId) {
  notice.value = ''
  stale.value = false
  details.value = null
  editing.value = role
}

const openUse = (use: ModelUseId) => { details.value = useRole(use) }

// A save whose change could not be written to the change history says so (rec#11 D-42).
const historyNote = (next: ModelRolesPayload) => (next.history === 'not_recorded' ? t('modelSettings.history.notRecorded') : '')
// Bumped whenever the page has the settings after a change, so an open change history reads again.
const historyVersion = ref(0)

// The settings or a role's execution mode changed: saved here (next), or
// elsewhere and read again. Every change path ends here.
async function settingsChanged(next?: ModelRolesPayload) {
  if (next) payload.value = next
  else if (!await load()) return
  historyVersion.value += 1
}

function saved(next: ModelRolesPayload) {
  notice.value = [t('modelSettings.saved', { name: roleName(editing.value!) }), historyNote(next)].filter(Boolean).join(' ')
  editing.value = null
  void settingsChanged(next)
}

// A changed file closes the form; one that stopped validating keeps it open,
// read again and locked, until the file is repaired.
async function conflict(code: ConfigConflict) {
  if (code === 'model_config_changed') {
    editing.value = null
    stale.value = true
  }
  await settingsChanged()
}

function trustSaved(next: ModelRolesPayload) {
  notice.value = historyNote(next)
  void settingsChanged(next)
}

onMounted(() => {
  if (store.runtimeStatus === 'idle') void store.refresh()
  void load()
  void suggestions.load()
})
// The top bar's 刷新 reads the roles and the suggestions again; the roles stay while it reads.
usePageRefresh(() => Promise.all([load(), suggestionsLoading.value ? undefined : suggestions.load()]))
onBeforeUnmount(() => {
  reading?.abort()
  suggestions.stop()
})
</script>

<template>
  <section class="view model-settings-view" :aria-label="t('modelSettings.title')">
    <div class="model-settings-column">

      <GrowthLoading v-if="loading && !payload" :label="t('modelSettings.loading')" />
      <div v-else-if="loadError && !payload" class="ui-empty rounded-lg border bg-card" role="alert">
        <p class="m-0 text-destructive">{{ t('modelSettings.loadFailed') }} {{ loadError }}</p>
        <Button class="mt-3" size="sm" variant="outline" @click="load">{{ t('modelSettings.retry') }}</Button>
      </div>

      <template v-else-if="payload">
        <section class="ui-section" aria-labelledby="model-list-title">
          <div class="ui-section-label">
            <h2 id="model-list-title" class="list-title">{{ t('modelSettings.models.title') }}</h2>
            <GrowthLoading v-if="loading" variant="inline" :label="t('modelSettings.loading')" />
          </div>
          <UiNotice v-if="payload.state === 'invalid'" tone="error" data-model-config-invalid>
            {{ t('modelSettings.invalid', { error: payload.error ?? '' }) }}
          </UiNotice>
          <UiNotice v-if="stale" tone="error" data-model-stale>{{ t('modelSettings.changed') }}</UiNotice>
          <UiNotice v-if="notice" tone="success">{{ notice }}</UiNotice>
          <ModelList :payload="payload" @open="openUse" />
        </section>

        <section class="ui-section model-uses" aria-labelledby="model-uses-title">
          <div class="ui-section-label">
            <h2 id="model-uses-title" class="list-title">{{ t('modelSettings.uses.title') }}</h2>
            <a class="model-guide-link" :href="modelGuideUrl(currentLocale())" target="_blank" rel="noopener noreferrer"
              data-model-guide>{{ t('modelSettings.guide') }}</a>
          </div>
          <div class="model-use-grid">
            <ModelRoleCard :view="view(SEMANTIC_ROLE)" :locked="locked" :editing="editing === SEMANTIC_ROLE"
              @edit="edit(SEMANTIC_ROLE)" @details="details = SEMANTIC_ROLE" />
            <ModelRoleCard :view="view('assistant')" :locked="locked" :editing="editing === 'assistant'"
              @edit="edit('assistant')" @details="details = 'assistant'" />
            <DreamingCard :status="taskState(payload, 'dreaming')" :model="astroModel" @edit="edit('assistant')" />
            <RetrievalTermsCard :projects="projects" :status="taskState(payload, 'retrieval_terms')" :model="astroModel" @edit="edit('assistant')" />
            <ModelRoleCard v-for="role in (['jefa', 'tonborg', 'bole'] as const)" :key="role" :view="view(role)" :locked="locked"
              :editing="editing === role" @edit="edit(role)" @details="details = role" />
          </div>
        </section>

        <RoleSuggestions :entries="suggestionEntries" :loading="suggestionsLoading" :error="suggestionsError"
          :reviews="reviews" :reviews-loading="reviewsLoading" :reviews-error="reviewsError" @retry="suggestions.load" @recovery-pending="suggestions.blockForRecovery" />

        <ModelUsage />

        <ModelUseDetails :view="detailsView" :payload="payload" :history-version="historyVersion"
          @close="details = null" @edit="edit(details!)" @trust-saved="trustSaved" @changed="settingsChanged()" />
        <ModelRoleDialog :role="editing" :payload="payload" :projects="projects"
          @close="editing = null" @saved="saved" @conflict="conflict" />
      </template>
    </div>
  </section>
</template>

<style scoped>
.model-settings-view { padding-bottom: 96px; color: var(--color-ink); }
/* Sections keep one rhythm (rec#38). */
.model-settings-column { display: grid; gap: var(--space-8); width: 100%; }
/* The breadcrumb sits closer to the first section than sections sit to each other. */
.model-settings-column > .breadcrumb { margin-bottom: calc(var(--space-4) - var(--space-8)); }
.model-guide-link { font-size: var(--text-control); }
/* The use cards: one column on a narrow page, two on a laptop, three on a wide screen; 语义搜索 spans the row. */
.model-uses { container-type: inline-size; }
.model-use-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-4); }
.model-use-grid > [data-semantic-search] { grid-column: 1 / -1; }
@container (min-width: 680px) { .model-use-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (min-width: 1040px) { .model-use-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
</style>
