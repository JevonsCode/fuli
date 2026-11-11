<script setup lang="ts">
import { Button } from '@/components/ui/button'
import PageOutline from '@/components/PageOutline.vue'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { apiErrorReason, getJson, putJson } from '@/api/client'
import { normalizedConfiguration, setConversationLauncherConfiguration } from '@/features/knowledge/conversation-launcher-settings'
import AiAccessSettingsTab from '@/features/settings/AiAccessSettingsTab.vue'
import ClientsSettingsTab from '@/features/settings/ClientsSettingsTab.vue'
import ConnectionsSettingsTab from '@/features/settings/ConnectionsSettingsTab.vue'
import RecordingSettingsTab from '@/features/settings/RecordingSettingsTab.vue'
import SystemSettingsTab from '@/features/settings/SystemSettingsTab.vue'
import SettingsSaveCapsule from '@/features/settings/SettingsSaveCapsule.vue'
import { waitForSettingsApply } from '@/features/settings/settings-apply'
import { useSettingsAutoSave } from '@/features/settings/settings-autosave'
import { pendingRestartFields, withoutRestartChanges } from '@/features/settings/settings-restart'
import { fieldErrorMessage } from '@/features/settings/settings-field-error'
import { linkedCard, settingSearchTerm, useSettingsSearch } from '@/features/settings/settings-search'
import { DEFAULT_SETTINGS_TAB, SETTINGS_TABS, settingsTabFrom, type SettingsTab } from '@/features/settings/settings-tabs'
import { settingsPageTools } from '@/features/settings/settings-page-tools'
import { usePageTools } from '@/features/webmcp/usePageTools'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import type { RuntimeSettings, SystemSettingsResult } from '@/types'

// The settings page composes one tab per subject (features/settings/*SettingsTab.vue)
// over one form: it reads and autosaves the form, holds the restart settings for
// 应用并重启, checks the fields, and keeps the open tab and the search in the URL.
const store = useConsoleStore()
const route = useRoute()
const router = useRouter()
const settings = ref<SystemSettingsResult | null>(null)
const form = ref<RuntimeSettings | null>(null)
const formElement = ref<HTMLFormElement | null>(null)
const loading = ref(true)
// A restart setting being applied: FULI restarts, so the form waits.
const applying = ref(false)
const applyError = ref('')
// Every other setting saves itself (Jevons 11-01): typing after a pause, a switch
// or a choice at once. Restart settings stay as FULI runs now until applied.
const autoSave = useSettingsAutoSave({
  read: () => withoutRestartChanges(form.value!, settings.value!.active),
  save: persistSettings,
  ready: () => !applying.value && checkFields().every(field => field.hasAttribute('data-restart-field')),
})
const { state: autoSaveState, failure: saveFailure } = autoSave
const saveCapsuleState = computed(() => applying.value ? 'applying' : autoSaveState.value)
const pendingRestart = computed(() => form.value && settings.value
  ? pendingRestartFields(form.value, settings.value.active)
  : new Set<never>())

// A few topic tabs over one form (D-03): the tab is part of the URL, every tab
// stays mounted so unsaved edits survive switching, and a search looks
// through all of them at once. The router sends an old tab id to its new tab.
const activeTab = ref<SettingsTab>(settingsTabFrom(route.query.tab))
watch(() => route.query.tab, value => { activeTab.value = settingsTabFrom(value) })
watch(activeTab, tab => {
  if (settingsTabFrom(route.query.tab) === tab) return
  const { tab: _previous, ...query } = route.query
  void router.replace({ query: tab === DEFAULT_SETTINGS_TAB ? query : { ...query, tab } })
})
const loadError = ref('')
const searchRoot = ref<HTMLElement | null>(null)
const settingsRoot = ref<HTMLElement | null>(null)
// A link from an Agent (?setting=ports) opens the page already filtered to that setting.
const searchQuery = ref(settingSearchTerm(new URLSearchParams(window.location.search).get('setting'), t))
const searchMatches = ref(0)
const searching = computed(() => Boolean(searchQuery.value.trim()))
useSettingsSearch(searchRoot, searchQuery, count => { searchMatches.value = count })
// A link to a card (#conversation-launchers, ?setting=…) shows its tab, then
// scrolls to the card and marks it until the person moves on.
const revealedCard = ref<HTMLElement | null>(null)
async function revealLinkedCard() {
  await nextTick()
  const card = searchRoot.value && linkedCard(searchRoot.value, window.location.hash)
  if (!card) return
  const tab = card.closest<HTMLElement>('[data-settings-tab]')?.dataset.settingsTab
  if (!searching.value && tab) activeTab.value = settingsTabFrom(tab)
  await nextTick()
  card.scrollIntoView?.({ block: 'start' })
  card.setAttribute('data-settings-linked', '')
  revealedCard.value = card
}
watch([activeTab, searchQuery], () => {
  revealedCard.value?.removeAttribute('data-settings-linked')
  revealedCard.value = null
})
const saveController = new AbortController()

onMounted(async () => {
  if (store.runtimeStatus === 'idle') void store.refresh()
  await loadSettings()
  loading.value = false
  if (window.location.hash || searchQuery.value) void revealLinkedCard()
})

onBeforeUnmount(() => saveController.abort())

// Typing in a field marks the change it makes as text, so it waits for a pause.
// Only the form's own fields count: the cards' own forms inside the tabs
// (a client added by hand, an external knowledge source) save themselves.
let typing = false
function noteTyping(event: Event) {
  const field = event.target
  typing = (field instanceof HTMLTextAreaElement || (field instanceof HTMLInputElement && field.type !== 'checkbox' && field.type !== 'radio'))
    && field.hasAttribute('data-settings-field')
}
// Checked once the page shows the change: a launcher switched on shows its
// fields, filled in, only after this render.
watch(form, () => {
  const change = typing ? 'text' : 'choice'
  typing = false
  void nextTick(() => autoSave.changed(change))
}, { deep: true })

async function loadSettings() {
  try {
    const result = await getJson<SystemSettingsResult>('/api/system/settings')
    adoptSettings(result)
    loadError.value = ''
    const url = new URL(window.location.href)
    if (result.apply?.status === 'applying') {
      applying.value = true
      await finishApplying(result).catch(error => { if (!saveController.signal.aborted) store.reportError(error) })
      applying.value = false
    } else if (result.apply?.status === 'applied' && url.searchParams.get('settingsApplied') === result.apply.id) {
      store.notify(t('settings.saved'))
      url.searchParams.delete('settingsApplied')
      window.history.replaceState(window.history.state, '', url)
    }
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : t('settings.loadError')
  }
}

// A failed first read offers to read again; the page stays empty until it succeeds.
const retrying = ref(false)
async function retryLoad() {
  retrying.value = true
  loading.value = true
  try { await loadSettings() } finally { loading.value = false; retrying.value = false }
}

// What the server holds becomes the form and is not sent again.
function adoptSettings(result: SystemSettingsResult) {
  settings.value = result
  form.value = { ...structuredClone(result.configured), conversationLaunchers: normalizedConfiguration(result.configured.conversationLaunchers) }
  autoSave.remember(withoutRestartChanges(form.value, result.active))
  setConversationLauncherConfiguration(result.configured.conversationLaunchers)
}

// The browser's AI agent can change the settings that need no restart (WebMCP).
usePageTools(() => settingsPageTools({ saved: adoptSettings }))

const putSettings = (value: RuntimeSettings) => putJson<SystemSettingsResult>('/api/system/settings', value)

// An automatic save leaves the form alone: the person may still be typing.
async function persistSettings(value: RuntimeSettings) {
  const result = await putSettings(value)
  settings.value = result
  setConversationLauncherConfiguration(result.configured.conversationLaunchers)
}

// The person's 应用并重启: the whole form, restart settings included.
async function applyRestartSettings() {
  if (!form.value || applying.value) return
  applyError.value = ''
  if (checkFields().length) {
    applyError.value = t('settings.restart.invalid')
    return
  }
  applying.value = true
  try {
    const result = await putSettings(form.value)
    adoptSettings(result)
    if (result.restartRequired) {
      if (!result.apply) throw new Error(t('settings.applyUnavailable'))
      await finishApplying(result)
    } else {
      store.notify(t('settings.saved'))
    }
  } catch (error) {
    if (saveController.signal.aborted) return
    applyError.value = apiErrorReason(error, t('settings.saveError'))
  } finally {
    applying.value = false
  }
}

async function finishApplying(result: SystemSettingsResult) {
  if (!result.apply) return
  const completed = await waitForSettingsApply(result.apply, saveController.signal)
  if (completed.url) { window.location.assign(completed.url); return }
  adoptSettings(completed.settings ?? result)
  store.notify(t('settings.saved'))
  void store.refresh()
}

// Checked here rather than by the browser, whose bubble is off-system and
// follows the browser's language: what is wrong shows right under each field,
// and a field that cannot be saved keeps what the person typed.
type ValidatedField = HTMLInputElement | HTMLTextAreaElement
const fieldErrors = ref<Record<string, string>>({})
// The invalid fields, each now saying what is wrong.
function checkFields(): ValidatedField[] {
  const fields = [...(formElement.value?.querySelectorAll<ValidatedField>(':is(input, textarea)[data-settings-field]') ?? [])]
  const invalid = fields.filter(field => !field.validity.valid)
  fieldErrors.value = Object.fromEntries(invalid.map(field => [field.dataset.settingsField ?? '', fieldErrorMessage(field)]))
  return invalid
}
</script>

<template>
  <section ref="settingsRoot" class="view settings-view" :aria-label="t('settings.aria')">
    <PageOutline :content="settingsRoot" />
    <div ref="searchRoot" class="settings-content grid w-full gap-4">
      <GrowthLoading v-if="loading && !form" :label="t('settings.loading')" />
      <Tabs v-if="form && settings" v-model="activeTab" :unmount-on-hide="false" class="settings-tabs gap-4" :data-searching="searching || undefined">
        <div class="settings-tabbar flex flex-wrap items-end gap-x-4 gap-y-2 border-b">
          <TabsList class="-mb-px w-auto flex-1 border-b-0" :aria-label="t('settings.tabs.label')">
            <TabsTrigger v-for="tab in SETTINGS_TABS" :key="tab" :value="tab" :data-settings-tab-trigger="tab">
              {{ t(`settings.tabs.${tab}`) }}
            </TabsTrigger>
          </TabsList>
          <label class="settings-search mb-1.5">
            <span class="ui-sr-only">{{ t('settings.search.label') }}</span>
            <input v-model="searchQuery" type="search" maxlength="80" :placeholder="t('settings.search.placeholder')" />
          </label>
        </div>
        <p v-if="searching && searchMatches" class="settings-search-note" role="status">{{ t('settings.searchEverywhere') }}</p>
        <p v-if="searching && !searchMatches" class="settings-search-empty" role="status">{{ t('settings.search.empty', { query: searchQuery.trim() }) }}</p>

        <!-- Enter in a field saves at once instead of after the pause. -->
        <form id="settings-form" ref="formElement" class="settings-form" novalidate :aria-busy="applying"
          @submit.prevent="autoSave.changed('choice')" @input.capture="noteTyping">
          <fieldset class="settings-fields" :disabled="applying">
            <TabsContent value="recording" :force-mount="searching || undefined" class="settings-panel" data-settings-tab="recording">
              <RecordingSettingsTab v-model:form="form" />
            </TabsContent>
            <TabsContent value="ai" :force-mount="searching || undefined" class="settings-panel" data-settings-tab="ai">
              <AiAccessSettingsTab />
            </TabsContent>
            <TabsContent value="clients" :force-mount="searching || undefined" class="settings-panel" data-settings-tab="clients">
              <ClientsSettingsTab v-model:form="form" :field-errors="fieldErrors" />
            </TabsContent>
            <TabsContent value="connections" :force-mount="searching || undefined" class="settings-panel" data-settings-tab="connections">
              <ConnectionsSettingsTab v-model:form="form" :active="settings.active" :pending-restart="pendingRestart" :applying="applying"
                :apply-error="applyError" :field-errors="fieldErrors" @apply="applyRestartSettings" />
            </TabsContent>
            <TabsContent value="system" :force-mount="searching || undefined" class="settings-panel" data-settings-tab="system">
              <SystemSettingsTab v-model:form="form" :runtime-mode="settings.active.graphRuntimeMode" :applying="applying" />
            </TabsContent>
          </fieldset>
          <p v-if="loadError" class="settings-error" role="alert">{{ loadError }}</p>
        </form>
      </Tabs>
      <SettingsSaveCapsule :state="saveCapsuleState" :failure="saveFailure" @retry="autoSave.retry" />
      <div v-if="!loading && !form" class="settings-load-error" role="alert">
        <p>{{ loadError || t('settings.loadError') }}</p>
        <Button size="sm" variant="outline" :disabled="retrying" @click="retryLoad">{{ t('common.actions.retry') }}</Button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.settings-view { scrollbar-gutter: stable; }
.settings-tabbar { position: relative; }
/* The tabs keep their row; once the tabs and a 180px search no longer fit side by side, the search wraps under them. */
.settings-tabbar > :first-child { flex: 1 1 auto; min-width: min(100%, max-content); }
/* One column no wider than the page: an auto column grew to the English tab row and scrolled the page sideways at 460pt (rec issue 102). */
.settings-content { grid-template-columns: minmax(0, 1fr); }
/* The client's narrowest window (460pt): 8px tab padding fits all five English tabs; narrower, the row scrolls on its own. */
@media (max-width: 520px) { .settings-tabbar :deep([role="tab"]) { padding-inline: 8px; } }
.settings-search { flex: 0 1 300px; min-width: 180px; }
.settings-search input { box-sizing: border-box; width: 100%; }
.settings-search-note, .settings-search-empty { margin: 0; color: var(--color-muted); font-size: 13px; }
.settings-form { display: grid; min-width: 0; gap: var(--space-4); }
.settings-fields { display: grid; min-width: 0; border: 0; margin: 0; padding: 0; }
/* While searching every tab shows; panels other than the active one follow it. */
.settings-tabs[data-searching] .settings-panel + .settings-panel { margin-top: var(--space-4); }
/* A search shows matching cards only; a group's own label would stand alone. */
.settings-tabs[data-searching] :deep([data-clients-more] > h2) { display: none; }

.settings-load-error {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px;
  padding: 16px 20px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface);
  color: var(--color-danger); font-size: 14px;
}
.settings-load-error p { margin: 0; }
</style>
