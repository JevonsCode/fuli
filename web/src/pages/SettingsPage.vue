<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { getJson, putJson } from '@/api/client'
import SearchableSelect from '@/components/SearchableSelect.vue'
import { currentLocale, setLocale, t, type AppLocale } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import type {
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
const saving = ref(false)
const loadingResources = ref(false)
const loadError = ref('')
const resourceError = ref('')
const saved = ref(false)
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
const localeOptions = computed(() => [
  { value: 'zh-CN', label: t('settings.behavior.zh') },
  { value: 'en-US', label: t('settings.behavior.en') },
])
const refreshOptions = computed(() => refreshIntervals.map((seconds) => ({
  value: String(seconds),
  label: t('settings.resources.refreshUnit', { seconds }),
})))
const captureEnabled = computed(() => store.state?.capturePolicy?.enabled !== false)
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

onMounted(async () => {
  if (store.runtimeStatus === 'idle') void store.refresh()
  await Promise.all([loadSettings(), loadResources()])
  loading.value = false
})

onBeforeUnmount(stopPolling)

watch(
  () => form.value?.resourceRefreshSeconds,
  () => startPolling(),
)

async function loadSettings() {
  try {
    const result = await getJson<SystemSettingsResult>('/api/system/settings')
    settings.value = result
    form.value = structuredClone(result.configured)
    loadError.value = ''
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : t('settings.loadError')
  }
}

async function loadResources() {
  if (loadingResources.value || document.visibilityState === 'hidden') return
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
  saving.value = true
  saved.value = false
  try {
    const result = await putJson<SystemSettingsResult>('/api/system/settings', form.value)
    settings.value = result
    form.value = structuredClone(result.configured)
    saved.value = true
    loadError.value = ''
    window.setTimeout(() => { saved.value = false }, 2400)
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : t('settings.saveError')
  } finally {
    saving.value = false
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

function toggleCapture(event: Event) {
  void store.updateCapturePolicy((event.currentTarget as HTMLInputElement).checked)
}

function toggleAgentAccess(event: Event) {
  void store.updateAgentAccessPolicy((event.currentTarget as HTMLInputElement).checked)
}

function updateLocale(value: string) {
  if (value === 'zh-CN' || value === 'en-US') setLocale(value)
}

function updateRefreshInterval(value: string) {
  const seconds = refreshIntervals.find((option) => String(option) === value)
  if (seconds === undefined || !form.value) return
  form.value.resourceRefreshSeconds = seconds
}

function activePort(key: keyof RuntimePorts) {
  return settings.value?.active.ports[key] ?? '—'
}

function componentLabel(component: ResourceComponent) {
  const key = `settings.resources.components.${component.id}`
  const translated = t(key)
  return translated === key ? component.label : translated
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
  if (!value) return '—'
  return new Intl.DateTimeFormat(locale.value, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}
</script>

<template>
  <section class="view settings-view" :aria-label="t('settings.aria')">
    <div class="settings-content">
      <div v-if="saved || settings?.restartRequired" class="settings-top-status" role="status">
        <strong v-if="saved">{{ t('settings.saved') }}</strong>
        <span v-if="settings?.restartRequired">{{ t('settings.restartCopy') }}</span>
      </div>
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
            <span>{{ t('settings.resources.exclusions') }}</span>
          </div>
        </template>
        <div v-else class="settings-skeleton" aria-hidden="true" />
      </section>

      <form v-if="form" id="settings-form" class="settings-form" @submit.prevent="saveSettings">
        <section class="settings-card ports-card">
          <header class="section-heading">
            <h3>{{ t('settings.ports.title') }}</h3>
            <span v-if="settings?.restartRequired" class="restart-chip">{{ t('settings.restartRequired') }}</span>
          </header>

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
        </section>

        <section class="settings-card behavior-card">
          <h3>{{ t('settings.behavior.title') }}</h3>
          <div class="setting-list">
            <label class="setting-row">
              <span><strong>{{ t('settings.behavior.capture') }}</strong><small>{{ t('settings.behavior.captureMeta') }}</small></span>
              <input type="checkbox" role="switch" :checked="captureEnabled" @change="toggleCapture" />
            </label>
            <label class="setting-row">
              <span><strong>{{ t('settings.behavior.agentAccess') }}</strong><small>{{ t('settings.behavior.agentAccessMeta') }}</small></span>
              <input type="checkbox" role="switch" :checked="agentAccessEnabled" @change="toggleAgentAccess" />
            </label>
            <label class="setting-row">
              <span><strong>{{ t('settings.behavior.lanAccess') }}</strong><small>{{ t('settings.behavior.lanAccessMeta') }}</small></span>
              <input v-model="form.lanAccess" type="checkbox" role="switch" />
            </label>
            <div class="setting-row select-row">
              <span><strong>{{ t('settings.behavior.language') }}</strong></span>
              <SearchableSelect
                class="settings-select"
                control-id="settings-language"
                :model-value="locale"
                :options="localeOptions"
                :label="t('settings.behavior.language')"
                @update:model-value="updateLocale"
              />
            </div>
            <div class="setting-row select-row">
              <span><strong>{{ t('settings.resources.refresh') }}</strong></span>
              <SearchableSelect
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

        <p v-if="loadError" class="settings-error" role="alert">{{ loadError }}</p>
      </form>
      <p v-else-if="!loading" class="settings-error" role="alert">{{ loadError || t('settings.loadError') }}</p>
    </div>
  </section>
</template>

<style scoped>
.settings-view {
  padding-top: 24px;
  background: #f7f8f6;
}

.settings-content {
  width: min(1120px, 100%);
  margin: 0 auto;
  display: grid;
  gap: 18px;
}

.settings-form { display: grid; gap: 18px; }

.settings-card {
  border: 1px solid #d7ddd8;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 8px 30px rgb(43 59 50 / 4%);
  padding: 26px;
}

.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 22px;
}

.settings-card h3 { color: #2e3c34; font-size: 19px; }
.section-heading p { margin-top: 5px; color: #879089; font-size: 11px; }

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
  border: 1px solid #dce2dd;
  border-radius: 10px;
  background: #f7f9f7;
}

.resource-totals span { color: #667169; font-size: 12px; }
.resource-totals strong { color: #24332a; font-size: clamp(25px, 3vw, 34px); letter-spacing: -.04em; }
.resource-totals small { color: #8a938d; font-size: 11px; }

.resource-breakdowns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 28px;
  margin-top: 26px;
}

.resource-group { display: grid; gap: 13px; }
.resource-group h4, .port-section h4 { color: #536058; font-size: 12px; }
.resource-row { display: grid; gap: 6px; }
.resource-row > div { display: flex; justify-content: space-between; gap: 12px; color: #67736b; font-size: 11px; }
.resource-row strong { color: #36443b; font-weight: 650; }
.resource-row i { height: 5px; overflow: hidden; border-radius: 999px; background: #eef1ee; }
.resource-row b { display: block; height: 100%; border-radius: inherit; background: #6f8f79; }
.resource-group:last-child .resource-row b { background: #82958a; }

.resource-notes {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 18px;
  margin-top: 22px;
  color: #8a938d;
  font-size: 10px;
}

.settings-skeleton {
  height: 260px;
  border-radius: 9px;
  background: #f2f4f2;
}

.restart-chip {
  padding: 5px 9px;
  border: 1px solid #d7aa68;
  border-radius: 999px;
  color: #8d5a18;
  background: #fff8ec;
  font-size: 10px;
  font-weight: 700;
}

.port-section { display: grid; gap: 13px; }
.port-section + .port-section { margin-top: 25px; padding-top: 22px; border-top: 1px solid #edf0ed; }
.development-section > div { display: flex; align-items: center; gap: 9px; }
.development-section > div > span {
  padding: 4px 8px;
  border-radius: 999px;
  color: #78633a;
  background: #f6f0e4;
  font-size: 9px;
  font-weight: 700;
}
.development-section > p { color: #8b948e; font-size: 10px; }
.port-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.port-grid label { display: grid; gap: 7px; color: #59655e; font-size: 11px; }
.port-grid input, .select-row :deep(.settings-select .searchable-select-trigger) {
  width: 100%;
  min-height: 40px;
  border: 1px solid #ccd4ce;
  border-radius: 8px;
  background: #fbfcfb;
  color: #2f3d34;
  font: inherit;
  padding: 0 11px;
  outline: none;
}
.port-grid input:focus, .select-row :deep(.settings-select .searchable-select-trigger:focus-visible) {
  border-color: #6f8f79;
  box-shadow: 0 0 0 3px rgb(111 143 121 / 12%);
}
.port-grid small { color: #9aa29d; font-size: 9px; }

.behavior-card > h3 { margin-bottom: 14px; }
.setting-list { display: grid; }
.setting-row {
  min-height: 64px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  border-top: 1px solid #edf0ed;
  cursor: pointer;
}
.setting-row:first-child { border-top: 0; }
.setting-row > span { display: grid; gap: 4px; }
.setting-row strong { color: #354239; font-size: 12px; }
.setting-row small { color: #8b948e; font-size: 10px; }
.setting-row input[role='switch'] {
  width: 38px;
  height: 21px;
  appearance: none;
  border-radius: 999px;
  background: #cbd2cd;
  position: relative;
  cursor: pointer;
  transition: background .18s ease;
}
.setting-row input[role='switch']::after {
  content: '';
  position: absolute;
  width: 17px;
  height: 17px;
  top: 50%;
  left: 2px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 0 4px rgb(0 0 0 / 18%);
  transform: translateY(-50%);
  transition: transform .18s ease;
}
.setting-row input[role='switch']:checked { background: #688b73; }
.setting-row input[role='switch']:checked::after { transform: translate(17px, -50%); }
.select-row .settings-select { width: 180px; min-width: 0; }
.select-row :deep(.settings-select .searchable-select-trigger) {
  padding: 0 14px 0 11px;
  border-radius: 8px;
  background: #fbfcfb;
}
.select-row :deep(.settings-select .searchable-select-current) { align-items: center; }
.select-row :deep(.settings-select .searchable-select-current-label) { font-weight: 500; }
.select-row :deep(.settings-select .searchable-select-arrow) {
  width: 8px;
  height: 8px;
  margin-right: 1px;
  border-width: 1.5px;
}
.select-row :deep(.settings-select .searchable-select-panel) { width: 100%; min-width: 0; }

.settings-top-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 16px;
  padding: 0 4px 2px;
  color: #7d8780;
  font-size: 10px;
}
.settings-top-status strong { color: #477356; font-weight: 700; }
.settings-error { padding: 11px 13px; border-radius: 8px; color: #8c3934; background: #fff2f0; font-size: 11px; }

@media (max-width: 900px) {
  .port-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 680px) {
  .settings-card { padding: 20px; }
  .resource-totals, .resource-breakdowns, .port-grid { grid-template-columns: 1fr; }
  .select-row { align-items: flex-start; flex-direction: column; padding: 14px 0; }
  .select-row .settings-select { width: 100%; }
}
</style>
