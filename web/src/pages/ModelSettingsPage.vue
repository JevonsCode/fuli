<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import PageOutline from '@/components/PageOutline.vue'
import { Button } from '@/components/ui/button'
import BuiltinEmbeddingDialog from '@/features/model-settings/BuiltinEmbeddingDialog.vue'
import DreamingCard from '@/features/model-settings/DreamingCard.vue'
import { linkedModelDetails, type ModelDetailsPart } from '@/features/model-settings/details-link'
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
import { modelPageTools } from '@/features/model-settings/model-page-tools'
import { taskState, useRole, type ModelUseId } from '@/features/model-settings/model-uses'
import { runRoleCheck } from '@/features/model-settings/useRoleCheck'
import { usePageTools } from '@/features/webmcp/usePageTools'
import { currentLocale, t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { usePageRefresh } from '@/layouts/page-refresh'
import { UiNotice } from '@/ui'

// 模型与用量 as one flat model center (rec#8, rec#38, 11-06; compact cards and
// failure paths 11-11): first every connected model once with whether it
// works now, who uses it and 「测试连接」; then every use as a card of one
// height with its state, its model, one line of how it stands and its quick
// action. Lists, facts, trust and history open in 「查看详情」. A model that did
// not answer says why where it shows, with 「测试连接」 and, where something
// can run again, 「重试」; a test reads the settings again so every place
// agrees. Then what the roles suggested and their usage. A save is accepted
// only at the local process boundary (a loopback request).
const store = useConsoleStore()
const route = useRoute()
const router = useRouter()
const pageRoot = ref<HTMLElement | null>(null)
const payload = ref<ModelRolesPayload | null>(null)
const loading = ref(true)
const loadError = ref('')
const editing = ref<ModelRoleId | null>(null)
const details = ref<ModelRoleId | null>(null)
// 「内置模型」 of 语义搜索: the models FULI downloads and runs on this computer.
const builtinOpen = ref(false)
const stale = ref(false)
// The role whose just-saved model is being tested.
const testing = ref<ModelRoleId | null>(null)
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
// A link into a use's details (待决策's 「设置」 beside 交给 Tonborg 确认) opens
// them once the uses are read, with the part it is about marked; the address
// then drops the link, so a reload shows the page itself.
const linkedPart = ref<ModelDetailsPart | null>(null)
watch([payload, () => route.query.details], ([value]) => {
  const linked = value ? linkedModelDetails(route.query, route.hash) : null
  if (!linked) return
  details.value = linked.role
  linkedPart.value = linked.part
  const { details: _linked, ...query } = route.query
  void router.replace({ query, hash: '' })
}, { immediate: true })
function closeDetails() {
  details.value = null
  linkedPart.value = null
}

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
  stale.value = false
  closeDetails()
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

// A saved model that is on is tested at once, so 「已保存」 also says whether it
// answers; the failure stays on its card with 「测试连接」.
async function saved(next: ModelRolesPayload) {
  const role = editing.value!
  editing.value = null
  await settingsChanged(next)
  const message = [t('modelSettings.saved', { name: roleName(role) }), historyNote(next)].filter(Boolean).join(' ')
  const connection = next.roles.find(entry => entry.role === role && entry.state === 'enabled')?.connection
  if (!connection) return store.notify(message)
  testing.value = role
  const result = await runRoleCheck(role, connection.model)
  testing.value = null
  await load()
  if (result.ok) store.notify(`${message} ${result.text}`)
  else store.reportError(new Error(`${message} ${result.text}`))
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

// The browser's AI agent can do what this page does (WebMCP); its changes show here as they land.
usePageTools(() => modelPageTools({ changed: () => void settingsChanged() }))

function trustSaved(next: ModelRolesPayload) {
  const note = historyNote(next)
  if (note) store.notify(note)
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
    <div ref="pageRoot" class="model-settings-column">

      <GrowthLoading v-if="loading && !payload" :label="t('modelSettings.loading')" />
      <div v-else-if="loadError && !payload" class="ui-empty rounded-lg border bg-card" role="alert">
        <p class="m-0 text-destructive">{{ t('modelSettings.loadFailed') }} {{ loadError }}</p>
        <Button class="mt-3" size="sm" variant="outline" @click="load">{{ t('modelSettings.retry') }}</Button>
      </div>

      <template v-else-if="payload">
        <section class="ui-section" aria-labelledby="model-list-title">
          <div class="ui-section-label">
            <h2 id="model-list-title" class="list-title">{{ t('modelSettings.models.title') }}</h2>
            <GrowthLoading v-if="testing" variant="inline" :label="t('modelSettings.savedChecking', { name: roleName(testing) })" />
            <GrowthLoading v-else-if="loading" variant="inline" :label="t('modelSettings.loading')" />
          </div>
          <UiNotice v-if="payload.state === 'invalid'" tone="error" data-model-config-invalid>
            {{ t('modelSettings.invalid', { error: payload.error ?? '' }) }}
          </UiNotice>
          <UiNotice v-if="stale" tone="error" data-model-stale>{{ t('modelSettings.changed') }}</UiNotice>
          <ModelList :payload="payload" @open="openUse" @checked="load()" />
        </section>

        <section class="ui-section model-uses" aria-labelledby="model-uses-title">
          <div class="ui-section-label">
            <h2 id="model-uses-title" class="list-title">{{ t('modelSettings.uses.title') }}</h2>
            <a class="model-guide-link" :href="modelGuideUrl(currentLocale())" target="_blank" rel="noopener noreferrer"
              data-model-guide>{{ t('modelSettings.guide') }}</a>
          </div>
          <div class="model-use-grid">
            <ModelRoleCard :view="view(SEMANTIC_ROLE)" :locked="locked" :editing="editing === SEMANTIC_ROLE"
              @edit="edit(SEMANTIC_ROLE)" @details="details = SEMANTIC_ROLE" @checked="load()" @builtin="builtinOpen = true" />
            <ModelRoleCard :view="view('assistant')" :locked="locked" :editing="editing === 'assistant'"
              @edit="edit('assistant')" @details="details = 'assistant'" @checked="load()" />
            <DreamingCard :status="taskState(payload, 'dreaming')" :model="astroModel" @edit="edit('assistant')" @checked="load()" />
            <RetrievalTermsCard :projects="projects" :status="taskState(payload, 'retrieval_terms')" :model="astroModel" @edit="edit('assistant')" @checked="load()" />
            <ModelRoleCard v-for="role in (['jefa', 'tonborg', 'bole'] as const)" :key="role" :view="view(role)" :locked="locked"
              :editing="editing === role" @edit="edit(role)" @details="details = role" @checked="load()" />
          </div>
        </section>

        <RoleSuggestions :entries="suggestionEntries" :loading="suggestionsLoading" :error="suggestionsError"
          :reviews="reviews" :reviews-loading="reviewsLoading" :reviews-error="reviewsError" @retry="suggestions.load" @recovery-pending="suggestions.blockForRecovery" />

        <ModelUsage />

        <ModelUseDetails :view="detailsView" :payload="payload" :history-version="historyVersion" :linked-part="linkedPart"
          @close="closeDetails()" @edit="edit(details!)" @trust-saved="trustSaved" @changed="settingsChanged()" />
        <BuiltinEmbeddingDialog :open="builtinOpen" @close="builtinOpen = false" @changed="settingsChanged()"
          @own="builtinOpen = false; edit(SEMANTIC_ROLE)" />
        <ModelRoleDialog :role="editing" :payload="payload" :projects="projects"
          @close="editing = null" @saved="saved" @conflict="conflict" />
      </template>
    </div>
    <PageOutline :content="pageRoot" />
  </section>
</template>

<style scoped>
.model-settings-view { padding-bottom: 96px; color: var(--color-ink); }
/* Sections keep one rhythm (rec#38). */
.model-settings-column { display: grid; gap: var(--space-8); width: 100%; }
/* The breadcrumb sits closer to the first section than sections sit to each other. */
.model-settings-column > .breadcrumb { margin-bottom: calc(var(--space-4) - var(--space-8)); }
.model-guide-link { font-size: var(--text-control); -webkit-user-select: none; user-select: none; }
/* The use cards: one column on a narrow page, two on a laptop, three on a wide screen; 语义搜索 spans the row. */
.model-uses { container-type: inline-size; }
.model-use-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-4); }
.model-use-grid > [data-semantic-search] { grid-column: 1 / -1; }
@container (min-width: 680px) { .model-use-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (min-width: 1040px) { .model-use-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
</style>
