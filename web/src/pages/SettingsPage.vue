<script setup lang="ts">
import GrowthLoading from '@/components/GrowthLoading.vue'
import UiDisclosure from '@/components/UiDisclosure.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { ApiError, getJson, putJson } from '@/api/client'
import UiSelect from '@/ui/UiSelect.vue'
import UiToggle from '@/ui/UiToggle.vue'
import { normalizedConfiguration, setConversationLauncherConfiguration } from '@/features/knowledge/conversation-launcher-settings'
import JudgmentPolicySettings from '@/features/judgment/JudgmentPolicySettings.vue'
import ClientConnectionSettings from '@/features/settings/ClientConnectionSettings.vue'
import PeerSettings from '@/features/settings/PeerSettings.vue'
import { waitForSettingsApply } from '@/features/settings/settings-apply'
import { settingSearchTerm, useSettingsSearch } from '@/features/settings/settings-search'
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

const store = useConsoleStore()
const settings = ref<SystemSettingsResult | null>(null)
const form = ref<RuntimeSettings | null>(null)
const resources = ref<ResourceSnapshot | null>(null)
const loading = ref(true)
const saving = computed(() => store.settingsSaving)
const loadingResources = ref(false)
const loadError = ref('')
const searchRoot = ref<HTMLElement | null>(null)
// A link from an Agent (?setting=ports) opens the page already filtered to that setting.
const searchQuery = ref(settingSearchTerm(new URLSearchParams(window.location.search).get('setting'), t))
const searchMatches = ref(0)
useSettingsSearch(searchRoot, searchQuery, count => { searchMatches.value = count })
const resourceError = ref('')
const saveController = new AbortController()
let refreshTimer: ReturnType<typeof setInterval> | null = null

const personalPortKeys: Array<keyof RuntimePorts> = [
  'console',
  'personalProvider',
  'personalNeo4jHttp',
  'personalNeo4jBolt',
]
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
const CAPTURE_CLIENTS = [['claude_code', 'Claude Code'], ['codex', 'Codex'], ['cursor', 'Cursor']] as const
const disabledCaptureSources = computed(() => store.state?.capturePolicy?.disabledSources ?? [])
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
  if (saving.value) store.settingsSaveState = 'idle'
})

watch(form, () => {
  if (store.settingsSaveState === 'saved') {
    store.settingsSaveState = 'idle'
    store.clearFeedback()
  }
}, { deep: true, flush: 'sync' })

watch(
  () => form.value?.resourceRefreshSeconds,
  () => startPolling(),
)

async function loadSettings() {
  try {
    const result = await getJson<SystemSettingsResult>('/api/system/settings')
    settings.value = result
    form.value = { ...structuredClone(result.configured), conversationLaunchers: normalizedConfiguration(result.configured.conversationLaunchers) }
    setConversationLauncherConfiguration(result.configured.conversationLaunchers)
    loadError.value = ''
    const url = new URL(window.location.href)
    if (result.apply?.status === 'applying') {
      store.settingsSaveState = 'applying'
      await finishApplying(result)
    } else if (result.apply?.status === 'applied' && url.searchParams.get('settingsApplied') === result.apply.id) {
      store.settingsSaveState = 'saved'
      store.notify(t('settings.saved'))
      url.searchParams.delete('settingsApplied')
      window.history.replaceState(window.history.state, '', url)
    }
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : t('settings.loadError')
  }
}

async function loadResources() {
  if (saving.value || loadingResources.value || document.visibilityState === 'hidden') return
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

async function saveSettings() {
  if (!form.value || saving.value) return
  store.settingsSaveState = 'saving'
  store.clearFeedback()
  try {
    const result = await putJson<SystemSettingsResult>('/api/system/settings', form.value)
    settings.value = result
    form.value = { ...structuredClone(result.configured), conversationLaunchers: normalizedConfiguration(result.configured.conversationLaunchers) }
    setConversationLauncherConfiguration(result.configured.conversationLaunchers)
    loadError.value = ''
    if (result.restartRequired) {
      if (!result.apply) throw new Error(t('settings.applyUnavailable'))
      store.settingsSaveState = 'applying'
      await finishApplying(result)
    } else {
      store.settingsSaveState = 'saved'
      store.notify(t('settings.saved'))
    }
  } catch (error) {
    if (saveController.signal.aborted) return
    store.settingsSaveState = 'error'
    let reason = error instanceof Error ? error.message : t('settings.saveError')
    if (error instanceof ApiError && error.detail) {
      try { reason = JSON.parse(error.detail).error || reason } catch { /* Plain-text API error. */ }
    }
    store.reportError(new Error(reason))
  }
}

async function finishApplying(result: SystemSettingsResult) {
  if (!result.apply) return
  try {
    const completed = await waitForSettingsApply(result.apply, saveController.signal)
    if (completed.url) { window.location.assign(completed.url); return }
    settings.value = completed.settings ?? result
    store.settingsSaveState = 'saved'
    store.notify(t('settings.saved'))
    void store.refresh()
  } catch (error) {
    if (saveController.signal.aborted) return
    store.settingsSaveState = 'error'
    store.reportError(error)
  }
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
  const others = disabledCaptureSources.value.filter(value => value !== source)
  void store.updateCapturePolicy(captureEnabled.value, capture ? others : [...others, source])
}

function toggleCapture(enabled: boolean) {
  void store.updateCapturePolicy(enabled)
}

function toggleAgentAccess(enabled: boolean) {
  void store.updateAgentAccessPolicy(enabled)
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
function revealInvalidField(event: Event) {
  const field = event.target as HTMLElement
  let section = field.closest('details')
  while (section) { section.open = true; section = section.parentElement?.closest('details') ?? null }
}
</script>

<template>
  <section class="view settings-view" :aria-label="t('settings.aria')">
    <div ref="searchRoot" class="settings-content">
      <label v-if="form" class="settings-search">
        <span class="ui-sr-only">{{ t('settings.search.label') }}</span>
        <input v-model="searchQuery" type="search" maxlength="80" :placeholder="t('settings.search.placeholder')" />
      </label>
      <p v-if="searchQuery.trim() && !searchMatches" class="settings-search-empty" role="status">{{ t('settings.search.empty', { query: searchQuery.trim() }) }}</p>
      <GrowthLoading v-if="loading && !form" variant="compact" :label="t('settings.loading')" />
      <form v-if="form" id="settings-form" class="settings-form" :aria-busy="saving" @submit.prevent="saveSettings" @invalid.capture="revealInvalidField">
        <fieldset class="settings-fields" :disabled="saving">
        <section class="settings-card behavior-card">
          <h3>{{ t('settings.behavior.title') }}</h3>
          <div class="setting-list">
            <label class="setting-row">
              <span><strong>{{ t('settings.behavior.capture') }}</strong><small>{{ t('settings.behavior.captureMeta') }}</small></span>
              <UiToggle :model-value="captureEnabled" :label="t('settings.behavior.capture')" @update:model-value="toggleCapture" />
            </label>
            <template v-if="captureEnabled">
              <p class="setting-note">{{ t('settings.behavior.captureClientsMeta') }}</p>
              <label v-for="[source, label] in CAPTURE_CLIENTS" :key="source" class="setting-row setting-row-nested" :data-capture-source="source">
                <span><strong>{{ label }}</strong></span>
                <UiToggle :model-value="!disabledCaptureSources.includes(source)" :label="label" @update:model-value="toggleClientCapture(source, $event)" />
              </label>
            </template>
            <label class="setting-row">
              <span><strong>{{ t('settings.behavior.agentAccess') }}</strong><small>{{ t('settings.behavior.agentAccessMeta') }}</small></span>
              <UiToggle :model-value="agentAccessEnabled" :label="t('settings.behavior.agentAccess')" @update:model-value="toggleAgentAccess" />
            </label>
            <label class="setting-row">
              <span><strong>{{ t('settings.behavior.lanAccess') }}</strong><small>{{ t('settings.behavior.lanAccessMeta') }}</small></span>
              <UiToggle v-model="form.lanAccess" :label="t('settings.behavior.lanAccess')" />
            </label>
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
              <UiSelect
                class="settings-select"
                control-id="settings-runtime-mode"
                :model-value="form.graphRuntimeMode"
                :options="runtimeModeOptions"
                :label="t('settings.behavior.runtimeMode')"
                @update:model-value="updateRuntimeMode"
              />
            </div>
            <div class="setting-row select-row">
              <span><strong>{{ t('settings.behavior.language') }}</strong></span>
              <UiSelect
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
              <UiToggle data-reduce-motion :model-value="motionPreference === 'reduced'" :label="t('settings.behavior.reduceMotion')" @update:model-value="toggleReducedMotion" />
            </label>
            <div class="setting-row select-row">
              <span><strong>{{ t('settings.resources.refresh') }}</strong></span>
              <UiSelect
                class="settings-select"
                control-id="settings-refresh-interval"
                :model-value="String(form.resourceRefreshSeconds)"
                :options="refreshOptions"
                :label="t('settings.resources.refresh')"
                @update:model-value="updateRefreshInterval"
              />
            </div>
          </div>
        </section>
        <section class="settings-card judgment-settings-card">
          <JudgmentPolicySettings />
        </section>
        <ClientConnectionSettings />
        <PeerSettings />
        <UiDisclosure class="settings-card ports-card" :title="t('settings.ports.title')">

          <div class="port-section">
            <h4>{{ t('settings.ports.personal') }}</h4>
            <div class="port-grid">
              <label v-for="key in personalPortKeys" :key="key">
                <span>{{ t(`settings.ports.${key}`) }}</span>
                <input v-model.number="form.ports[key]" type="number" min="1" max="65535" required />
                <small>{{ t('settings.ports.active', { port: activePort(key) }) }}</small>
              </label>
            </div>
          </div>

          <div class="port-section development-section">
            <div>
              <h4>{{ t('settings.ports.development') }}</h4>
              <span>{{ t('settings.ports.developing') }}</span>
            </div>
            <p>{{ t('settings.ports.developmentMeta') }}</p>
          </div>
        </UiDisclosure>

        <UiDisclosure id="conversation-launchers" class="settings-card conversation-launcher-card" :title="t('settings.conversationLaunchers.title')">
          <div class="conversation-launcher-list">
            <article
              v-for="application in conversationApplications"
              :key="application"
              class="conversation-launcher-row"
            >
              <div class="conversation-launcher-heading">
                <span>
                  <strong>{{ conversationApplicationLabel(application) }}</strong>
                  <small>{{ t('settings.conversationLaunchers.sourceId', { id: application }) }}</small>
                </span>
                <label class="conversation-launcher-switch">
                  <span>{{ t('settings.conversationLaunchers.enabled') }}</span>
                  <UiToggle v-model="form.conversationLaunchers[application].enabled" :label="t('settings.conversationLaunchers.enabled')" />
                </label>
              </div>
              <small
                v-if="form.conversationLaunchers[application].enabled && application === 'codex'"
                class="conversation-launcher-note"
              >
                {{ t('settings.conversationLaunchers.idFormatMeta') }}
              </small>
              <div
                v-if="form.conversationLaunchers[application].enabled"
                class="conversation-launcher-fields"
              >
                <label>
                  <span>{{ t('settings.conversationLaunchers.idFormat') }}</span>
                  <UiSelect
                    v-model="form.conversationLaunchers[application].idFormat"
                    class="launcher-select"
                    :control-id="`settings-conversation-${application}-id-format`"
                    :options="conversationIdFormatOptions"
                    :label="t('settings.conversationLaunchers.idFormat')"
                  />
                </label>
                <label>
                  <span>{{ t('settings.conversationLaunchers.appName') }}</span>
                  <input
                    v-model.trim="form.conversationLaunchers[application].appName"
                    type="text"
                    maxlength="64"
                    required
                  />
                </label>
                <label class="conversation-launcher-template">
                  <span>
                    {{ t('settings.conversationLaunchers.urlTemplate') }}
                    <small><code>{id}</code></small>
                  </span>
                  <input
                    v-model.trim="form.conversationLaunchers[application].urlTemplate"
                    type="text"
                    maxlength="1024"
                    spellcheck="false"
                    required
                  />
                </label>
              </div>
            </article>
          </div>
        </UiDisclosure>

        <UiDisclosure v-if="form.notifications" id="notifications" class="settings-card notifications-card" :title="t('settings.notifications.title')">
          <label class="notification-url">
            <span><strong>{{ t('settings.notifications.needsPersonUrl') }}</strong><small>{{ t('settings.notifications.needsPersonUrlMeta') }}</small></span>
            <input v-model.trim="form.notifications.needsPersonUrl" type="url" maxlength="2048" spellcheck="false"
              placeholder="http://127.0.0.1:9123/fuli" data-needs-person-url />
          </label>
        </UiDisclosure>



        </fieldset>
        <p v-if="loadError" class="settings-error" role="alert">{{ loadError }}</p>
      </form>
      <section class="settings-card resource-card">
        <header class="section-heading">
          <div>
            <h3>{{ t('settings.resources.title') }}</h3>
            <p v-if="resources">{{ t('settings.resources.measuredAt', { time: formatTime(resources.sampledAt) }) }}</p>
          </div>
          <button class="quiet-button" type="button" :disabled="loadingResources" @click="loadResources">
            {{ t('common.actions.refresh') }}
          </button>
        </header>

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

          <UiDisclosure :title="t('ui.usageDetails')">
          <div class="resource-breakdowns">
            <div class="resource-group">
              <h4>{{ t('settings.resources.memory') }}</h4>
              <div v-for="component in resources.memory.components" :key="component.id" class="resource-row">
                <div><span>{{ componentLabel(component) }}</span><strong>{{ formatBytes(component.bytes) }}</strong></div>
                <i><b :style="{ width: barWidth(component.bytes, memoryMax) }" /></i>
              </div>
            </div>
            <div class="resource-group">
              <h4>{{ t('settings.resources.disk') }}</h4>
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
          </UiDisclosure>
        </template>
      </section>
      <p v-if="!loading && !form" class="settings-error" role="alert">{{ loadError || t('settings.loadError') }}</p>
    </div>
  </section>
</template>

<style scoped>
.settings-fields { display: grid; gap: var(--space-6); min-width: 0; border: 0; margin: 0; padding: 0; }

.settings-view {
  padding-top: 24px;
  background: var(--color-bg);
}

.settings-content {
  width: min(1040px, 100%);
  min-width: 0;
  margin: 0 auto;
  display: grid;
  gap: var(--space-6);
}

.settings-form { display: grid; min-width: 0; gap: var(--space-6); }
.settings-search input { box-sizing: border-box; width: 100%; }
.settings-search-empty { margin: 0; color: var(--color-muted); font-size: 13px; text-align: center; }

.settings-card {
  min-width: 0;
  container-type: inline-size;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-card);
  background: var(--color-surface);
  padding: 26px;
}

.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 22px;
}

.settings-card h3 { color: var(--color-ink); font-size: 16px; }
.section-heading p { margin-top: 5px; color: var(--color-muted); font-size: 12px; }

.resource-totals {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.resource-totals article {
  min-height: 126px;
  display: grid;
  align-content: center;
  gap: 7px;
  padding: 20px 22px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-surface);
}

.resource-totals span { color: var(--color-muted); font-size: 12px; }
.resource-totals strong { color: var(--color-ink); font-size: clamp(25px, 3vw, 34px); letter-spacing: -.04em; }
.resource-totals small { color: var(--color-muted); font-size: 12px; }

.resource-breakdowns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 28px;
  margin-top: 26px;
}

.resource-group { display: grid; gap: 13px; }
.resource-group h4, .port-section h4 { color: var(--color-ink); font-size: 12px; }
.resource-row { display: grid; gap: 6px; }
.resource-row > div { display: flex; justify-content: space-between; gap: 12px; color: var(--color-muted); font-size: 12px; }
.resource-row strong { color: var(--color-ink); font-weight: 650; }
.resource-row i { height: 5px; overflow: hidden; border-radius: 999px; background: var(--color-surface-subtle); }
.resource-row b { display: block; height: 100%; border-radius: inherit; background: var(--color-muted); }
.resource-group:last-child .resource-row b { background: var(--color-muted); }

.resource-notes {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  margin-top: 22px;
  color: var(--color-muted);
  font-size: 12px;
}



.port-section { display: grid; gap: 13px; }
.port-section + .port-section { margin-top: 25px; padding-top: 22px; border-top: 1px solid var(--color-border); }
.development-section > div { display: flex; align-items: center; gap: 9px; }
.development-section > div > span {
  padding: 4px 8px;
  border-radius: 999px;
  color: var(--color-warning);
  background: var(--color-warning-soft);
  font-size: 12px;
  font-weight: 700;
}
.development-section > p { color: var(--color-muted); font-size: 12px; }
.port-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.port-grid label { display: grid; gap: 7px; color: var(--color-muted); font-size: 12px; }
.port-grid input { width: 100%; min-width: 0; }
.port-grid small { color: var(--color-muted); font-size: 12px; }

.behavior-card > h3 { margin-bottom: 14px; }
.conversation-launcher-card > h3 { margin-bottom: 14px; }
.conversation-launcher-list { display: grid; }
.conversation-launcher-row { padding: 16px 0; border-top: 1px solid var(--color-border); }
.conversation-launcher-row:first-child { border-top: 0; }
.conversation-launcher-heading {
  min-height: 34px; display: flex; align-items: center; justify-content: space-between; gap: 20px;
}
.conversation-launcher-heading > span { display: grid; min-width: 0; gap: 4px; overflow-wrap: anywhere; }
.conversation-launcher-heading strong { color: var(--color-ink); font-size: 12px; }
.conversation-launcher-heading small { color: var(--color-muted); font-size: 12px; }
.conversation-launcher-switch { display: flex; flex: 0 0 auto; align-items: center; gap: 9px; color: var(--color-muted); font-size: 12px; }
.conversation-launcher-switch input[role='switch'] { margin: 0; }
.conversation-launcher-note {
  display: block; max-width: 760px; margin-top: 9px; color: var(--color-muted); font-size: 12px; line-height: 1.45;
}
.conversation-launcher-fields {
  display: grid; align-items: start;
  grid-template-columns: minmax(0, .7fr) minmax(0, .8fr) minmax(0, 1.5fr);
  gap: 12px; margin-top: 14px;
}
.conversation-launcher-fields > label {
  min-width: 0; display: grid; grid-template-rows: auto 40px; align-content: start;
  gap: 7px; color: var(--color-muted); font-size: 12px;
}
.conversation-launcher-fields > label > span {
  min-width: 0; display: block; line-height: 18px; overflow-wrap: anywhere;
}
.conversation-launcher-fields code { color: var(--color-muted); font-size: 12px; }
.conversation-launcher-fields :deep(.launcher-select) { width: 100%; height: 40px; min-width: 0; }
.conversation-launcher-fields input { width: 100%; min-width: 0; }
.notification-url { display: grid; gap: 10px; }
.notification-url > span { display: grid; gap: 4px; }
.notification-url small { color: var(--color-muted); font-size: 12px; }
.notification-url input { width: 100%; min-width: 0; }
.setting-list { display: grid; }
.setting-row {
  min-height: 64px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  border-top: 1px solid var(--color-border);
  cursor: pointer;
}
.setting-row:first-child { border-top: 0; }
.setting-row > span { display: grid; min-width: 0; gap: 4px; }
.setting-row strong { color: var(--color-ink); font-size: 14px; }
.setting-row small { color: var(--color-muted); font-size: 12px; }
.setting-note { margin: 0; padding: 4px 0 4px 20px; color: var(--color-muted); font-size: 12px; }
.setting-row-nested { min-height: 48px; padding-left: 20px; border-top-style: dashed; }
.setting-row input[role='switch'],
.conversation-launcher-switch input[role='switch'] {
  flex: 0 0 auto;
  width: 38px;
  height: 21px;
  margin: 0;
  padding: 0;
  border: 0;
  appearance: none;
  border-radius: 999px;
  background: var(--color-muted);
  position: relative;
  cursor: pointer;
  transition: background .18s ease;
}
.setting-row input[role='switch']::after,
.conversation-launcher-switch input[role='switch']::after {
  content: '';
  position: absolute;
  box-sizing: border-box;
  width: 17px;
  height: 17px;
  top: 50%;
  left: 2px;
  border-radius: 50%;
  background: var(--color-surface);
  box-shadow: var(--shadow-xs);
  transform: translateY(-50%);
  transition: transform .18s ease;
}
.setting-row input[role='switch']:checked,
.conversation-launcher-switch input[role='switch']:checked { background: var(--color-accent); }
.setting-row input[role='switch']:checked::after,
.conversation-launcher-switch input[role='switch']:checked::after { transform: translate(17px, -50%); }
.select-row .settings-select { flex: 0 0 180px; width: 180px; min-width: 0; }

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
  .select-row { align-items: flex-start; flex-direction: column; padding: 14px 0; }
  .select-row .settings-select { flex: auto; width: 100%; }
}

@media (max-width: 680px) {
  .settings-card { padding: var(--space-4); }
}
</style>
