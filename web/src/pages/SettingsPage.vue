<script setup lang="ts">
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { apiErrorReason, getJson, putJson } from '@/api/client'
import { Switch } from '@/components/ui/switch'
import { normalizedConfiguration, setConversationLauncherConfiguration } from '@/features/knowledge/conversation-launcher-settings'
import JudgmentPolicySettings from '@/features/judgment/JudgmentPolicySettings.vue'
import ClientConnectionSettings from '@/features/settings/ClientConnectionSettings.vue'
import ClientLinksSettings from '@/features/settings/ClientLinksSettings.vue'
import PeerSettings from '@/features/settings/PeerSettings.vue'
import DiagnosticsSettings from '@/features/settings/DiagnosticsSettings.vue'
import AgentNamingStyleField from '@/features/settings/AgentNamingStyleField.vue'
import CaptureProjectSettings from '@/features/capture/CaptureProjectSettings.vue'
import SettingsRestartNotice from '@/features/settings/SettingsRestartNotice.vue'
import SettingsSaveCapsule from '@/features/settings/SettingsSaveCapsule.vue'
import { waitForSettingsApply } from '@/features/settings/settings-apply'
import { useSettingsAutoSave } from '@/features/settings/settings-autosave'
import { PERSONAL_PORT_KEYS, pendingRestartFields, withoutRestartChanges } from '@/features/settings/settings-restart'
import { captureSourceOff, withCaptureSource } from '@/features/capture/capture-sources'
import { fieldErrorMessage } from '@/features/settings/settings-field-error'
import { matchingSections, settingSearchTerm, useSettingsSearch } from '@/features/settings/settings-search'
import {
  CONVERSATION_SOURCE_APPLICATIONS,
  sourceApplicationName,
} from '@/features/knowledge/source-adapters'
import { currentLocale, i18n, setLocale, t, type AppLocale } from '@/i18n'
import { formatDateTime } from '@/lib/date-time'
import { motionPreference, setMotionPreference } from '@/lib/motion-preference'
import { useConsoleStore } from '@/stores/console'
import type {
  ConversationSourceApplication,
  ResourceComponent,
  ResourceSnapshot,
  RuntimePorts,
  RuntimeSettings,
  SystemSettingsResult,
} from '@/types'
import { OptionSelect } from '@/components/ui/select'

const store = useConsoleStore()
const route = useRoute()
const router = useRouter()
const settings = ref<SystemSettingsResult | null>(null)
const form = ref<RuntimeSettings | null>(null)
const formElement = ref<HTMLFormElement | null>(null)
const resources = ref<ResourceSnapshot | null>(null)
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
  : new Set())

// A few topic tabs over one form (D-03): the tab is part of the URL, every tab
// stays mounted so unsaved edits survive switching, and a search looks
// through all of them at once.
const SETTINGS_TABS = ['memory', 'clients', 'network', 'system'] as const
type SettingsTab = typeof SETTINGS_TABS[number]
const tabFrom = (value: unknown): SettingsTab => SETTINGS_TABS.find(tab => tab === value) ?? 'memory'
const activeTab = ref<SettingsTab>(tabFrom(route.query.tab))
watch(() => route.query.tab, value => { activeTab.value = tabFrom(value) })
watch(activeTab, tab => {
  if (tabFrom(route.query.tab) === tab) return
  const { tab: _previous, ...query } = route.query
  void router.replace({ query: tab === 'memory' ? query : { ...query, tab } })
})
// Low-frequency items sit in Accordion sections. A search match or an invalid
// field opens its section; the person's own choices are kept apart so a
// cleared search closes only what the search opened. The 客户端 tab is made of
// collapsible sections only, so its first one starts open: a tab never opens
// on nothing but closed headings. Open sections are not remembered between visits.
const DEFAULT_OPEN_SECTIONS = ['launchers']
const openedSections = ref<string[]>([...DEFAULT_OPEN_SECTIONS])
const searchSections = ref<string[]>([])
const openSections = computed({
  get: () => [...new Set([...openedSections.value, ...searchSections.value])],
  set: (value: string[]) => {
    openedSections.value = value
    searchSections.value = searchSections.value.filter(section => value.includes(section))
  },
})
const loadingResources = ref(false)
const loadError = ref('')
const searchRoot = ref<HTMLElement | null>(null)
// A link from an Agent (?setting=ports) opens the page already filtered to that setting.
const searchQuery = ref(settingSearchTerm(new URLSearchParams(window.location.search).get('setting'), t))
const searchMatches = ref(0)
const searching = computed(() => Boolean(searchQuery.value.trim()))
useSettingsSearch(searchRoot, searchQuery, count => {
  searchMatches.value = count
  searchSections.value = searchRoot.value ? matchingSections(searchRoot.value, searchQuery.value) : []
})
const resourceError = ref('')
const saveController = new AbortController()
let refreshTimer: ReturnType<typeof setInterval> | null = null

const locale = computed({
  get: () => currentLocale(),
  set: (value: AppLocale) => setLocale(value),
})
const refreshIntervals = [5, 10, 30, 60] as const
const conversationApplications = CONVERSATION_SOURCE_APPLICATIONS
const localeOptions = computed(() => [
  { value: 'zh-CN', label: t('settings.behavior.zh') },
  { value: 'en-US', label: t('settings.behavior.en') },
])
const refreshOptions = computed(() => refreshIntervals.map((seconds) => ({
  value: String(seconds),
  label: t('settings.resources.refreshUnit', { seconds }),
})))
const runtimeModeOptions = computed(() => [
  { value: 'native', label: t('settings.behavior.runtimeModes.native') },
  { value: 'container', label: t('settings.behavior.runtimeModes.container') },
])
const conversationIdFormatOptions = computed(() => [
  { value: 'any', label: t('settings.conversationLaunchers.idFormats.any') },
  { value: 'uuid', label: t('settings.conversationLaunchers.idFormats.uuid') },
])
const captureEnabled = computed(() => store.state?.capturePolicy?.enabled !== false)
// Capture is per client; a client that is off still reads memory through its tools.
const CAPTURE_CLIENTS = [['claude_code', 'Claude Code'], ['codex', 'Codex'], ['cursor', 'Cursor'], ['opencode', 'OpenCode']] as const
const captureSources = computed(() => store.state?.capturePolicy ?? {})
const answerFromConfirmed = computed(() => store.state?.recallPolicy?.answerFromConfirmed !== false)
const agentAccessEnabled = computed(() =>
  store.state?.agentAccessPolicy?.enabled !== false,
)
const memoryMax = computed(() => Math.max(
  1,
  ...(resources.value?.memory.components.map(({ bytes }) => bytes) ?? [1]),
))
const diskMax = computed(() => Math.max(
  1,
  ...(resources.value?.disk.components.map(({ bytes }) => bytes) ?? [1]),
))
const showsRuntimeMode = computed(() => settings.value?.active.graphRuntimeMode === 'container' || form.value?.graphRuntimeMode === 'container')
const recommendsNativeRuntime = computed(() =>
  form.value?.graphRuntimeMode === 'container'
  && Number.isFinite(resources.value?.memory.hostTotalBytes)
  && Number(resources.value?.memory.hostTotalBytes) <= 16 * 1024 ** 3,
)

onMounted(async () => {
  if (store.runtimeStatus === 'idle') void store.refresh()
  await Promise.all([loadSettings(), loadResources()])
  loading.value = false
})

onBeforeUnmount(() => {
  stopPolling()
  saveController.abort()
})

// Typing in a field marks the change it makes as text, so it waits for a pause.
let typing = false
function noteTyping(event: Event) {
  const field = event.target
  typing = field instanceof HTMLTextAreaElement || (field instanceof HTMLInputElement && field.type !== 'checkbox' && field.type !== 'radio')
}
// Checked once the page shows the change: a launcher switched on shows its
// fields, filled in, only after this render.
watch(form, () => {
  const change = typing ? 'text' : 'choice'
  typing = false
  void nextTick(() => autoSave.changed(change))
}, { deep: true })

watch(
  () => form.value?.resourceRefreshSeconds,
  () => startPolling(),
)

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
  try { await Promise.all([loadSettings(), loadResources()]) } finally { loading.value = false; retrying.value = false }
}

async function loadResources() {
  if (applying.value || loadingResources.value || document.visibilityState === 'hidden') return
  loadingResources.value = true
  try {
    resources.value = await getJson<ResourceSnapshot>('/api/system/resources')
    resourceError.value = ''
  } catch (error) {
    resourceError.value = error instanceof Error
      ? error.message
      : t('settings.resources.unavailable')
  } finally {
    loadingResources.value = false
  }
}

// What the server holds becomes the form and is not sent again.
function adoptSettings(result: SystemSettingsResult) {
  settings.value = result
  form.value = { ...structuredClone(result.configured), conversationLaunchers: normalizedConfiguration(result.configured.conversationLaunchers) }
  autoSave.remember(withoutRestartChanges(form.value, result.active))
  setConversationLauncherConfiguration(result.configured.conversationLaunchers)
}

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

function startPolling() {
  stopPolling()
  const seconds = form.value?.resourceRefreshSeconds
  if (!seconds) return
  refreshTimer = setInterval(() => void loadResources(), seconds * 1000)
}

function stopPolling() {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = null
}

function toggleClientCapture(source: string, capture: boolean) {
  void store.updateCapturePolicy(captureEnabled.value, withCaptureSource(captureSources.value, source, capture))
}

function toggleCapture(enabled: boolean) {
  void store.updateCapturePolicy(enabled)
}

function toggleAgentAccess(enabled: boolean) {
  void store.updateAgentAccessPolicy(enabled)
}

function toggleAnswerFromConfirmed(enabled: boolean) {
  void store.updateRecallPolicy(enabled)
}

function updateLocale(value: string) {
  if (value === 'zh-CN' || value === 'en-US') setLocale(value)
}

function toggleReducedMotion(reduced: boolean) {
  setMotionPreference(reduced ? 'reduced' : 'system')
}

function updateRefreshInterval(value: string) {
  const seconds = refreshIntervals.find((option) => String(option) === value)
  if (seconds === undefined || !form.value) return
  form.value.resourceRefreshSeconds = seconds
}

function updateRuntimeMode(value: string) {
  if (!form.value || (value !== 'native' && value !== 'container')) return
  form.value.graphRuntimeMode = value
}

function conversationApplicationLabel(application: ConversationSourceApplication) {
  const translated = t(`settings.conversationLaunchers.applications.${application}`)
  return translated === `settings.conversationLaunchers.applications.${application}`
    ? sourceApplicationName(application)
    : translated
}

function activePort(key: keyof RuntimePorts) {
  return settings.value?.active.ports[key] ?? '—'
}

function componentLabel(component: ResourceComponent) {
  const id = component.id.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
  const key = `settings.resources.components.${id}`
  return i18n.global.te(key) ? t(key) : component.label
}

function formatBytes(bytes: number | null | undefined) {
  if (!Number.isFinite(bytes)) return '—'
  const value = Number(bytes)
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let amount = value
  let index = 0
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024
    index += 1
  }
  const digits = index === 0 ? 0 : amount >= 100 ? 0 : amount >= 10 ? 1 : 2
  return `${amount.toFixed(digits)} ${units[index]}`
}

function barWidth(bytes: number, maximum: number) {
  return `${Math.max(3, Math.round((bytes / maximum) * 100))}%`
}

function formatTime(value: string | undefined) {
  return formatDateTime(value, locale.value, { hour: '2-digit', minute: '2-digit', second: '2-digit' }, { missing: '—' })
}
// Checked here rather than by the browser, whose bubble is off-system and
// follows the browser's language: what is wrong shows right under each field,
// and a field that cannot be saved keeps what the person typed.
type ValidatedField = HTMLInputElement | HTMLTextAreaElement
const fieldErrors = ref<Record<string, string>>({})
const errorFor = (key: string) => fieldErrors.value[key] ?? ''
const fieldErrorId = (key: string) => `settings-field-error-${key.replace(/\W/g, '-')}`
// The invalid fields, each now saying what is wrong.
function checkFields(): ValidatedField[] {
  const fields = [...(formElement.value?.querySelectorAll<ValidatedField>(':is(input, textarea)[data-settings-field]') ?? [])]
  const invalid = fields.filter(field => !field.validity.valid)
  fieldErrors.value = Object.fromEntries(invalid.map(field => [field.dataset.settingsField ?? '', fieldErrorMessage(field)]))
  return invalid
}
</script>

<template>
  <section class="view settings-view" :aria-label="t('settings.aria')">
    <div ref="searchRoot" class="settings-content mx-auto grid w-full max-w-(--layout-max) gap-4">
      <GrowthLoading v-if="loading && !form" variant="compact" :label="t('settings.loading')" />
      <Tabs v-if="form" v-model="activeTab" :unmount-on-hide="false" class="settings-tabs gap-4" :data-searching="searching || undefined">
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
            <!-- Memory and access -->
            <TabsContent value="memory" :force-mount="searching || undefined" class="settings-panel" data-settings-tab="memory">
              <Card as="section" class="settings-card behavior-card" aria-labelledby="settings-capture-title">
                <CardHeader><CardTitle id="settings-capture-title" as="h2">{{ t('settings.groups.capture') }}</CardTitle></CardHeader>
                <div class="setting-list">
                  <label class="setting-row">
                    <span><strong>{{ t('settings.behavior.capture') }}</strong><small>{{ t('settings.behavior.captureMeta') }}</small></span>
                    <Switch :model-value="captureEnabled" :aria-label="t('settings.behavior.capture')" @update:model-value="toggleCapture" />
                  </label>
                  <template v-if="captureEnabled">
                    <p class="setting-note">{{ t('settings.behavior.captureClientsMeta') }}</p>
                    <label v-for="[source, label] in CAPTURE_CLIENTS" :key="source" class="setting-row setting-row-nested" :data-capture-source="source">
                      <span><strong>{{ label }}</strong></span>
                      <Switch :model-value="!captureSourceOff(captureSources, source)" :aria-label="label" @update:model-value="toggleClientCapture(source, $event)" />
                    </label>
                  </template>
                  <label class="setting-row" data-recall-answer-from-confirmed>
                    <span><strong>{{ t('settings.behavior.answerFromConfirmed') }}</strong><small>{{ t('settings.behavior.answerFromConfirmedMeta') }}</small></span>
                    <Switch :model-value="answerFromConfirmed" :aria-label="t('settings.behavior.answerFromConfirmed')" @update:model-value="toggleAnswerFromConfirmed" />
                  </label>
                </div>
              </Card>
              <Card as="section" class="settings-card" aria-labelledby="settings-capture-projects-title" data-capture-projects-card>
                <CardHeader>
                  <CardTitle id="settings-capture-projects-title" as="h2">{{ t('capture.settings.title') }}</CardTitle>
                  <CardDescription>{{ t('capture.settings.description') }}</CardDescription>
                </CardHeader>
                <CaptureProjectSettings class="px-5" />
              </Card>
              <Card as="section" class="settings-card" aria-labelledby="settings-access-title">
                <CardHeader><CardTitle id="settings-access-title" as="h2">{{ t('settings.groups.access') }}</CardTitle></CardHeader>
                <div class="setting-list">
                  <label class="setting-row">
                    <span><strong>{{ t('settings.behavior.agentAccess') }}</strong><small>{{ t('settings.behavior.agentAccessMeta') }}</small></span>
                    <Switch :model-value="agentAccessEnabled" :aria-label="t('settings.behavior.agentAccess')" @update:model-value="toggleAgentAccess" />
                  </label>
                </div>
              </Card>
              <Card v-if="form.agentNamingStyle !== undefined" as="section" class="settings-card" aria-labelledby="settings-agent-naming-title" data-agent-naming-card>
                <CardHeader>
                  <CardTitle id="settings-agent-naming-title" as="h2">{{ t('settings.agentNaming.title') }}</CardTitle>
                  <CardDescription id="settings-agent-naming-description">{{ t('settings.agentNaming.description') }}</CardDescription>
                </CardHeader>
                <AgentNamingStyleField v-model="form.agentNamingStyle" class="setting-list" />
              </Card>
              <Card v-if="form.topicPromotion !== undefined" as="section" class="settings-card" aria-labelledby="settings-topic-promotion-title" data-topic-promotion-card>
                <div class="setting-list">
                  <label class="setting-row">
                    <span><strong id="settings-topic-promotion-title">{{ t('settings.topicPromotion.title') }}</strong><small>{{ t('settings.topicPromotion.description') }}</small></span>
                    <Switch :model-value="form.topicPromotion === 'auto'" :aria-label="t('settings.topicPromotion.title')"
                      data-settings-field="topicPromotion" @update:model-value="form.topicPromotion = $event ? 'auto' : 'ask'" />
                  </label>
                </div>
              </Card>
              <section class="settings-card judgment-settings-card">
                <JudgmentPolicySettings />
              </section>
              <Card as="section" class="settings-card" aria-labelledby="settings-models-title">
                <CardHeader>
                  <CardTitle id="settings-models-title" as="h2">{{ t('modelSettings.title') }}</CardTitle>
                  <CardDescription>{{ t('modelSettings.settingsEntry') }}</CardDescription>
                  <CardAction>
                    <Button as-child size="sm" variant="outline">
                      <RouterLink to="/settings/models" data-open-model-settings>{{ t('modelSettings.open') }}</RouterLink>
                    </Button>
                  </CardAction>
                </CardHeader>
              </Card>
            </TabsContent>

            <!-- Clients -->
            <TabsContent value="clients" :force-mount="searching || undefined" class="settings-panel" data-settings-tab="clients">
              <ClientConnectionSettings />
              <ClientLinksSettings />
              <Card as="section" class="settings-card settings-advanced-card" aria-labelledby="settings-clients-advanced-title">
                <CardHeader><CardTitle id="settings-clients-advanced-title" as="h2">{{ t('settings.groups.advanced') }}</CardTitle></CardHeader>
                <Accordion v-model="openSections" type="multiple" :unmount-on-hide="false" class="settings-accordion">
                  <AccordionItem id="conversation-launchers" value="launchers" class="conversation-launcher-card" data-settings-section="launchers">
                    <AccordionTrigger>{{ t('settings.conversationLaunchers.title') }}</AccordionTrigger>
                    <AccordionContent>
                      <div class="conversation-launcher-list">
                        <article v-for="application in conversationApplications" :key="application" class="conversation-launcher-row">
                          <div class="conversation-launcher-heading">
                            <span>
                              <strong>{{ conversationApplicationLabel(application) }}</strong>
                              <small>{{ t('settings.conversationLaunchers.sourceId', { id: application }) }}</small>
                            </span>
                            <label class="conversation-launcher-switch">
                              <span>{{ t('settings.conversationLaunchers.enabled') }}</span>
                              <Switch v-model="form.conversationLaunchers[application].enabled" :aria-label="t('settings.conversationLaunchers.enabled')" />
                            </label>
                          </div>
                          <small v-if="form.conversationLaunchers[application].enabled && application === 'codex'" class="conversation-launcher-note">
                            {{ t('settings.conversationLaunchers.idFormatMeta') }}
                          </small>
                          <div v-if="form.conversationLaunchers[application].enabled" class="conversation-launcher-fields">
                            <label>
                              <span>{{ t('settings.conversationLaunchers.idFormat') }}</span>
                              <OptionSelect
                                v-model="form.conversationLaunchers[application].idFormat"
                                class="launcher-select"
                                :control-id="`settings-conversation-${application}-id-format`"
                                :options="conversationIdFormatOptions"
                                :label="t('settings.conversationLaunchers.idFormat')"
 />
                            </label>
                            <label>
                              <span>{{ t('settings.conversationLaunchers.appName') }}</span>
                              <input v-model.trim="form.conversationLaunchers[application].appName" type="text" maxlength="64" required
                                :data-settings-field="`launchers.${application}.appName`"
                                :aria-invalid="errorFor(`launchers.${application}.appName`) ? 'true' : undefined"
                                :aria-describedby="errorFor(`launchers.${application}.appName`) ? fieldErrorId(`launchers.${application}.appName`) : undefined" />
                              <small v-if="errorFor(`launchers.${application}.appName`)" :id="fieldErrorId(`launchers.${application}.appName`)" class="settings-field-error" data-settings-field-error>{{ errorFor(`launchers.${application}.appName`) }}</small>
                            </label>
                            <label class="conversation-launcher-template">
                              <span>
                                {{ t('settings.conversationLaunchers.urlTemplate') }}
                                <small><code>{id}</code></small>
                              </span>
                              <input v-model.trim="form.conversationLaunchers[application].urlTemplate" type="text" maxlength="1024" spellcheck="false" required
                                :data-settings-field="`launchers.${application}.urlTemplate`"
                                :aria-invalid="errorFor(`launchers.${application}.urlTemplate`) ? 'true' : undefined"
                                :aria-describedby="errorFor(`launchers.${application}.urlTemplate`) ? fieldErrorId(`launchers.${application}.urlTemplate`) : undefined" />
                              <small v-if="errorFor(`launchers.${application}.urlTemplate`)" :id="fieldErrorId(`launchers.${application}.urlTemplate`)" class="settings-field-error" data-settings-field-error>{{ errorFor(`launchers.${application}.urlTemplate`) }}</small>
                            </label>
                          </div>
                        </article>
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                  <AccordionItem v-if="form.notifications" id="notifications" value="notifications" class="notifications-card" data-settings-section="notifications">
                    <AccordionTrigger>{{ t('settings.notifications.title') }}</AccordionTrigger>
                    <AccordionContent>
                      <label class="notification-url">
                        <span><strong>{{ t('settings.notifications.needsPersonUrl') }}</strong><small>{{ t('settings.notifications.needsPersonUrlMeta') }}</small></span>
                        <input v-model.trim="form.notifications.needsPersonUrl" type="url" maxlength="2048" spellcheck="false"
                          placeholder="http://127.0.0.1:9123/fuli" data-needs-person-url data-settings-field="notifications.needsPersonUrl"
                          :aria-invalid="errorFor('notifications.needsPersonUrl') ? 'true' : undefined"
                          :aria-describedby="errorFor('notifications.needsPersonUrl') ? fieldErrorId('notifications.needsPersonUrl') : undefined" />
                        <small v-if="errorFor('notifications.needsPersonUrl')" :id="fieldErrorId('notifications.needsPersonUrl')" class="settings-field-error" data-settings-field-error>{{ errorFor('notifications.needsPersonUrl') }}</small>
                      </label>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </Card>
            </TabsContent>

            <!-- Network -->
            <TabsContent value="network" :force-mount="searching || undefined" class="settings-panel" data-settings-tab="network">
              <Card as="section" class="settings-card" aria-labelledby="settings-lan-title">
                <CardHeader><CardTitle id="settings-lan-title" as="h2">{{ t('settings.groups.lan') }}</CardTitle></CardHeader>
                <div class="setting-list">
                  <label class="setting-row">
                    <span><strong>{{ t('settings.behavior.lanAccess') }}</strong><small>{{ t('settings.behavior.lanAccessMeta') }}</small></span>
                    <Switch v-model="form.lanAccess" :aria-label="t('settings.behavior.lanAccess')" />
                  </label>
                </div>
                <SettingsRestartNotice v-if="pendingRestart.has('lanAccess')" class="settings-restart" :applying="applying" :error="applyError" @apply="applyRestartSettings" />
              </Card>
              <PeerSettings />
              <Card as="section" class="settings-card settings-advanced-card" aria-labelledby="settings-network-advanced-title">
                <CardHeader><CardTitle id="settings-network-advanced-title" as="h2">{{ t('settings.groups.advanced') }}</CardTitle></CardHeader>
                <Accordion v-model="openSections" type="multiple" :unmount-on-hide="false" class="settings-accordion">
                  <AccordionItem value="ports" class="ports-card" data-settings-section="ports">
                    <AccordionTrigger>{{ t('settings.ports.title') }}</AccordionTrigger>
                    <AccordionContent>
                      <div class="port-section">
                        <h3>{{ t('settings.ports.personal') }}</h3>
                        <div class="port-grid">
                          <label v-for="key in PERSONAL_PORT_KEYS" :key="key">
                            <span>{{ t(`settings.ports.${key}`) }}</span>
                            <input v-model.number="form.ports[key]" type="number" min="1" max="65535" required
                              :data-settings-field="`ports.${key}`" data-restart-field
                              :aria-invalid="errorFor(`ports.${key}`) ? 'true' : undefined"
                              :aria-describedby="errorFor(`ports.${key}`) ? fieldErrorId(`ports.${key}`) : undefined" />
                            <small v-if="errorFor(`ports.${key}`)" :id="fieldErrorId(`ports.${key}`)" class="settings-field-error" data-settings-field-error>{{ errorFor(`ports.${key}`) }}</small>
                            <small>{{ t('settings.ports.active', { port: activePort(key) }) }}</small>
                          </label>
                        </div>
                        <SettingsRestartNotice v-if="pendingRestart.has('ports')" :applying="applying" :error="applyError" @apply="applyRestartSettings" />
                      </div>
                      <div class="port-section development-section">
                        <div>
                          <h3>{{ t('settings.ports.development') }}</h3>
                          <span>{{ t('settings.ports.developing') }}</span>
                        </div>
                        <p>{{ t('settings.ports.developmentMeta') }}</p>
                      </div>
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </Card>
            </TabsContent>

            <!-- System -->
            <TabsContent value="system" :force-mount="searching || undefined" class="settings-panel" data-settings-tab="system">
              <Card as="section" class="settings-card" aria-labelledby="settings-interface-title">
                <CardHeader><CardTitle id="settings-interface-title" as="h2">{{ t('settings.groups.interface') }}</CardTitle></CardHeader>
                <div class="setting-list">
                  <div class="setting-row select-row">
                    <span><strong>{{ t('settings.behavior.language') }}</strong></span>
                    <OptionSelect
                      class="settings-select"
                      control-id="settings-language"
                      :model-value="locale"
                      :options="localeOptions"
                      :label="t('settings.behavior.language')"
                      @update:model-value="updateLocale"
 />
                  </div>
                  <label class="setting-row">
                    <span><strong>{{ t('settings.behavior.reduceMotion') }}</strong><small>{{ t('settings.behavior.reduceMotionMeta') }}</small></span>
                    <Switch data-reduce-motion :model-value="motionPreference === 'reduced'" :aria-label="t('settings.behavior.reduceMotion')" @update:model-value="toggleReducedMotion" />
                  </label>
                </div>
              </Card>
              <Card as="section" class="settings-card" aria-labelledby="settings-runtime-title">
                <CardHeader><CardTitle id="settings-runtime-title" as="h2">{{ t('settings.groups.runtime') }}</CardTitle></CardHeader>
                <div class="setting-list">
                  <!-- Native is the default runtime; the choice only matters while an
                       older container install still needs to move over. -->
                  <div v-if="showsRuntimeMode" class="setting-row select-row">
                    <span>
                      <strong>{{ t('settings.behavior.runtimeMode') }}</strong>
                      <small>{{ recommendsNativeRuntime
                        ? t('settings.behavior.runtimeRecommendation')
                        : t('settings.behavior.runtimeModeMeta', {
                          mode: t(`settings.behavior.runtimeModes.${settings?.active.graphRuntimeMode ?? form.graphRuntimeMode}`),
                        }) }}</small>
                    </span>
                    <OptionSelect
                      class="settings-select"
                      control-id="settings-runtime-mode"
                      :model-value="form.graphRuntimeMode"
                      :options="runtimeModeOptions"
                      :label="t('settings.behavior.runtimeMode')"
                      @update:model-value="updateRuntimeMode"
 />
                  </div>
                  <div class="setting-row select-row">
                    <span><strong>{{ t('settings.resources.refresh') }}</strong></span>
                    <OptionSelect
                      class="settings-select"
                      control-id="settings-refresh-interval"
                      :model-value="String(form.resourceRefreshSeconds)"
                      :options="refreshOptions"
                      :label="t('settings.resources.refresh')"
                      @update:model-value="updateRefreshInterval"
 />
                  </div>
                </div>
                <SettingsRestartNotice v-if="pendingRestart.has('graphRuntimeMode')" class="settings-restart" :applying="applying" :error="applyError" @apply="applyRestartSettings" />
              </Card>
              <Card as="section" class="settings-card" aria-labelledby="settings-data-format-title">
                <CardHeader>
                  <CardTitle id="settings-data-format-title" as="h2">{{ t('dataFormat.title') }}</CardTitle>
                  <CardDescription>{{ t('dataFormat.settingsEntry') }}</CardDescription>
                  <CardAction>
                    <Button as-child size="sm" variant="outline">
                      <RouterLink to="/settings/data-format" data-open-data-format>{{ t('dataFormat.open') }}</RouterLink>
                    </Button>
                  </CardAction>
                </CardHeader>
              </Card>
              <Card as="section" class="settings-card resource-card" aria-labelledby="settings-resources-title">
                <CardHeader>
                  <CardTitle id="settings-resources-title" as="h2">{{ t('settings.resources.title') }}</CardTitle>
                  <CardDescription v-if="resources">{{ t('settings.resources.measuredAt', { time: formatTime(resources.sampledAt) }) }}</CardDescription>
                  <CardAction>
                    <Button size="sm" variant="ghost" :disabled="loadingResources" @click="loadResources">
                      {{ t('common.actions.refresh') }}
                    </Button>
                  </CardAction>
                </CardHeader>
                <GrowthLoading v-if="loadingResources" :variant="resources ? 'inline' : 'compact'" :label="t('settings.resources.loading')" />
                <p v-if="resourceError" class="settings-error" role="alert">{{ resourceError }}</p>
                <template v-else-if="resources">
                  <div class="resource-totals">
                    <article>
                      <span>{{ t('settings.resources.memory') }}</span>
                      <strong>{{ formatBytes(resources.memory.usedBytes) }}</strong>
                      <small>{{ t('settings.resources.available', { value: formatBytes(resources.memory.hostFreeBytes) }) }}</small>
                    </article>
                    <article>
                      <span>{{ t('settings.resources.disk') }}</span>
                      <strong>{{ formatBytes(resources.disk.usedBytes) }}</strong>
                      <small>{{ t('settings.resources.available', { value: formatBytes(resources.disk.hostFreeBytes) }) }}</small>
                    </article>
                  </div>
                  <Accordion v-model="openSections" type="multiple" :unmount-on-hide="false" class="settings-accordion">
                    <AccordionItem value="usage" data-settings-section="usage">
                      <AccordionTrigger>{{ t('ui.usageDetails') }}</AccordionTrigger>
                      <AccordionContent>
                        <div class="resource-breakdowns">
                          <div class="resource-group">
                            <h3>{{ t('settings.resources.memory') }}</h3>
                            <div v-for="component in resources.memory.components" :key="component.id" class="resource-row">
                              <div><span>{{ componentLabel(component) }}</span><strong>{{ formatBytes(component.bytes) }}</strong></div>
                              <i><b :style="{ width: barWidth(component.bytes, memoryMax) }" /></i>
                            </div>
                          </div>
                          <div class="resource-group">
                            <h3>{{ t('settings.resources.disk') }}</h3>
                            <div v-for="component in resources.disk.components" :key="component.id" class="resource-row">
                              <div><span>{{ componentLabel(component) }}</span><strong>{{ formatBytes(component.bytes) }}</strong></div>
                              <i><b :style="{ width: barWidth(component.bytes, diskMax) }" /></i>
                            </div>
                          </div>
                        </div>
                        <div class="resource-notes">
                          <span>{{ t('settings.resources.diskMeasuredAt', { time: formatTime(resources.disk.measuredAt) }) }}</span>
                          <span v-if="resources.status === 'partial'">{{ t('settings.resources.partial') }}</span>
                          <span v-if="resources.disk.temporaryBytes">{{ t('settings.resources.temporary', { value: formatBytes(resources.disk.temporaryBytes) }) }}</span>
                          <span>{{ t(resources.exclusions.includes('shared-container-vm-overhead')
                            ? 'settings.resources.exclusionsContainer'
                            : 'settings.resources.exclusionsNative') }}</span>
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  </Accordion>
                </template>
              </Card>
              <DiagnosticsSettings />
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
.settings-search { flex: 0 1 300px; min-width: 180px; }
.settings-search input { box-sizing: border-box; width: 100%; min-height: var(--control-height-sm); padding-block: 4px; }
.settings-search-note, .settings-search-empty { margin: 0; color: var(--color-muted); font-size: 13px; }
.settings-form { display: grid; min-width: 0; gap: var(--space-4); }
.settings-fields { display: grid; min-width: 0; border: 0; margin: 0; padding: 0; }
.settings-panel { display: grid; gap: var(--space-4); }
/* While searching every tab shows; panels other than the active one follow it. */
.settings-tabs[data-searching] .settings-panel + .settings-panel { margin-top: var(--space-4); }

/* Card groups: shadcn Card surface; FULI rows inside. */
.settings-card { min-width: 0; container-type: inline-size; }
.settings-card :deep([data-slot="card-header"]) { padding-inline: 24px; }
.setting-list, .settings-card > .settings-accordion { padding-inline: 24px; }
.judgment-settings-card { border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--card); padding: 24px; }
/* The two feature cards render their own disclosure; give them the same surface. */
.settings-panel > :deep(.connection-settings), .settings-panel > :deep(.peer-settings) {
  border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--card); padding: 20px 24px;
}
.settings-panel > :deep(.connection-settings) > summary, .settings-panel > :deep(.peer-settings) > summary { font-size: var(--text-section); }
.settings-accordion :deep([data-slot="accordion-trigger"]) { font-size: 14px; }

.resource-totals { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; padding-inline: 24px; }
.resource-totals article {
  display: grid; align-content: center; gap: 7px; min-height: 108px; padding: 18px 20px;
  border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--card);
}
.resource-totals span { color: var(--color-muted); font-size: 12px; }
.resource-totals strong { color: var(--color-ink); font-size: clamp(24px, 3vw, 32px); letter-spacing: -.04em; }
.resource-totals small { color: var(--color-muted); font-size: 12px; }
.resource-breakdowns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 28px; }
.resource-group { display: grid; gap: 13px; }
.resource-group h3, .port-section h3 { color: var(--color-ink); font-size: 12px; }
.resource-row { display: grid; gap: 6px; }
.resource-row > div { display: flex; justify-content: space-between; gap: 12px; color: var(--color-muted); font-size: 12px; }
.resource-row strong { color: var(--color-ink); font-weight: 650; }
.resource-row i { height: 5px; overflow: hidden; border-radius: 999px; background: var(--color-surface-subtle); }
.resource-row b { display: block; height: 100%; border-radius: inherit; background: var(--color-muted); }
.resource-notes { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 22px; color: var(--color-muted); font-size: 12px; }

.port-section { display: grid; gap: 13px; }
.port-section + .port-section { margin-top: 25px; padding-top: 22px; border-top: 1px solid var(--color-border); }
.development-section > div { display: flex; align-items: center; gap: 9px; }
.development-section > div > span {
  padding: 4px 8px; border-radius: 999px; color: var(--color-warning); background: var(--color-warning-soft); font-size: 12px; font-weight: 700;
}
.development-section > p { color: var(--color-muted); font-size: 12px; }
/* Short related fields sit side by side. */
.port-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.port-grid label { display: grid; gap: 7px; color: var(--color-muted); font-size: 12px; }
.port-grid input { width: 100%; min-width: 0; }
.port-grid small { color: var(--color-muted); font-size: 12px; }

.conversation-launcher-list { display: grid; }
.conversation-launcher-row { padding: 16px 0; border-top: 1px solid var(--color-border); }
.conversation-launcher-row:first-child { border-top: 0; padding-top: 0; }
.conversation-launcher-heading { min-height: 34px; display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.conversation-launcher-heading > span { display: grid; min-width: 0; gap: 4px; overflow-wrap: anywhere; }
.conversation-launcher-heading strong { color: var(--color-ink); font-size: 13px; }
.conversation-launcher-heading small { color: var(--color-muted); font-size: 12px; }
.conversation-launcher-switch { display: flex; flex: 0 0 auto; align-items: center; gap: 9px; color: var(--color-muted); font-size: 12px; }
.conversation-launcher-note { display: block; max-width: 760px; margin-top: 9px; color: var(--color-muted); font-size: 12px; line-height: 1.45; }
.conversation-launcher-fields {
  display: grid; align-items: start; grid-template-columns: minmax(0, .7fr) minmax(0, .8fr) minmax(0, 1.5fr); gap: 12px; margin-top: 14px;
}
.conversation-launcher-fields > label {
  min-width: 0; display: grid; grid-template-rows: auto 40px; align-content: start; gap: 7px; color: var(--color-muted); font-size: 12px;
}
.conversation-launcher-fields > label > span { min-width: 0; display: block; line-height: 18px; overflow-wrap: anywhere; }
.conversation-launcher-fields code { color: var(--color-muted); font-size: 12px; }
.conversation-launcher-fields :deep(.launcher-select) { width: 100%; height: 40px; min-width: 0; }
.conversation-launcher-fields input { width: 100%; min-width: 0; }
.notification-url { display: grid; gap: 10px; }
.notification-url > span { display: grid; gap: 4px; }
.notification-url small { color: var(--color-muted); font-size: 12px; }
.notification-url input { width: 100%; min-width: 0; }

.setting-list { display: grid; }
/* A divider between rows has the card's own rhythm on each side (16px, like the
   title-to-content gap), so the middle of a card is as roomy as its edges
   (Jevons 11-01). The card's padding already frames the first and last row. */
.setting-row {
  display: flex; align-items: center; justify-content: space-between; gap: 24px; padding-block: 16px;
  border-top: 1px solid var(--color-border); cursor: pointer;
}
.setting-row:first-child { padding-top: 0; border-top: 0; }
.setting-row:last-child { padding-bottom: 0; }
.setting-row > span { display: grid; min-width: 0; gap: 4px; }
.setting-row strong { color: var(--color-ink); font-size: 14px; }
.setting-row small { color: var(--color-muted); font-size: 12px; }
.setting-note { margin: 0; padding: 4px 0 4px 20px; color: var(--color-muted); font-size: 12px; }
.setting-row-nested { padding-left: 20px; border-top-style: dashed; }
.select-row .settings-select { flex: 0 0 180px; width: 180px; min-width: 0; }

.settings-restart { margin-inline: 24px; }
.settings-form .settings-field-error { color: var(--color-danger); font-size: 12px; line-height: 1.4; }
.settings-form :is(input, textarea)[aria-invalid="true"] { border-color: var(--color-danger); box-shadow: 0 0 0 3px var(--color-danger-soft); }

.settings-load-error {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px;
  padding: 16px 20px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface);
  color: var(--color-danger); font-size: 14px;
}
.settings-load-error p { margin: 0; }
.settings-error { padding: 11px 13px; border-radius: var(--radius-control); color: var(--color-danger); background: var(--color-surface); font-size: 12px; }

@container (max-width: 640px) {
  .port-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .conversation-launcher-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .conversation-launcher-template { grid-column: 1 / -1; }
  .resource-breakdowns { grid-template-columns: minmax(0, 1fr); }
}

@container (max-width: 420px) {
  .resource-totals, .port-grid, .conversation-launcher-fields { grid-template-columns: minmax(0, 1fr); }
  .conversation-launcher-template { grid-column: auto; }
  .select-row { align-items: flex-start; flex-direction: column; gap: 10px; }
  .select-row .settings-select { flex: auto; width: 100%; }
}

@media (max-width: 680px) {
  .settings-card :deep([data-slot="card-header"]), .setting-list, .settings-card > .settings-accordion, .resource-totals { padding-inline: var(--space-4); }
  .settings-restart { margin-inline: var(--space-4); }
}
</style>
