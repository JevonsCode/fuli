<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { getJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import PageColumns from '@/components/PageColumns.vue'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { OptionSelect } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import AiHelpButton from '@/features/ai-help/AiHelpButton.vue'
import ConsoleUpdate from '@/features/update/ConsoleUpdate.vue'
import { offersUpdate, useChannelVersionStatus } from '@/features/update/version-status'
import { currentLocale, i18n, setLocale, t, type AppLocale } from '@/i18n'
import { usePageRefresh } from '@/layouts/page-refresh'
import { formatDateTime } from '@/lib/date-time'
import { formatBytes as formatByteCount } from '@/lib/format-bytes'
import { motionPreference, setMotionPreference } from '@/lib/motion-preference'
import type { ResourceComponent, ResourceSnapshot, RuntimeSettings } from '@/types'
import { FULI_VERSION } from '@/version'
import DiagnosticsSettings from './DiagnosticsSettings.vue'
import GraphMigrationRow from './GraphMigrationRow.vue'
import StorageSettings from './StorageSettings.vue'

// Settings › 系统: this console and this computer: the interface, the
// version and its updates, how often FULI reads its resources, its data
// (format migrations, storage), the diagnostics bundle and what it uses.
const form = defineModel<RuntimeSettings>('form', { required: true })
const props = defineProps<{ runtimeMode: RuntimeSettings['graphRuntimeMode'], applying: boolean }>()

const REFRESH_INTERVALS = [5, 10, 30, 60] as const
const locale = computed({
  get: () => currentLocale(),
  set: (value: AppLocale) => setLocale(value),
})
const localeOptions = computed(() => [
  { value: 'zh-CN', label: t('settings.behavior.zh') },
  { value: 'en-US', label: t('settings.behavior.en') },
])
const refreshOptions = computed(() => REFRESH_INTERVALS.map((seconds) => ({
  value: String(seconds),
  label: t('settings.resources.refreshUnit', { seconds }),
})))
// 版本: the newest release on the update channel the form holds.
const { status: versionStatus, failed: versionFailed, checking: versionChecking, recheck: recheckVersion } = useChannelVersionStatus(computed(() => form.value.updateChannel))
const versionCheckedAt = (value: string) => formatDateTime(value, locale.value, { dateStyle: 'medium', timeStyle: 'short' }, { missing: '—' })

const resources = ref<ResourceSnapshot | null>(null)
const loadingResources = ref(false)
const resourceError = ref('')
let refreshTimer: ReturnType<typeof setInterval> | null = null
const memoryMax = computed(() => Math.max(1, ...(resources.value?.memory.components.map(({ bytes }) => bytes) ?? [1])))
const diskMax = computed(() => Math.max(1, ...(resources.value?.disk.components.map(({ bytes }) => bytes) ?? [1])))

async function loadResources() {
  if (props.applying || loadingResources.value || document.visibilityState === 'hidden') return
  loadingResources.value = true
  try {
    resources.value = await getJson<ResourceSnapshot>('/api/system/resources')
    resourceError.value = ''
  } catch (error) {
    resourceError.value = error instanceof Error ? error.message : t('settings.resources.unavailable')
  } finally {
    loadingResources.value = false
  }
}

function startPolling() {
  stopPolling()
  const seconds = form.value.resourceRefreshSeconds
  if (!seconds) return
  refreshTimer = setInterval(() => void loadResources(), seconds * 1000)
}

function stopPolling() {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = null
}

onMounted(() => {
  void loadResources()
  startPolling()
})
onBeforeUnmount(stopPolling)
watch(() => form.value.resourceRefreshSeconds, startPolling)
// The top bar's 刷新 reads the machine's resources again.
usePageRefresh(loadResources)

// The language also goes to FULI's settings, so clients' /fla menu says
// project and role in it (src/graphiti/fla-menu.js).
function updateLocale(value: string) {
  if (value !== 'zh-CN' && value !== 'en-US') return
  setLocale(value)
  if (form.value.consoleLanguage !== undefined) form.value.consoleLanguage = value
}

function updateRefreshInterval(value: string) {
  const seconds = REFRESH_INTERVALS.find((option) => String(option) === value)
  if (seconds !== undefined) form.value.resourceRefreshSeconds = seconds
}

function componentLabel(component: ResourceComponent) {
  const id = component.id.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
  const key = `settings.resources.components.${id}`
  return i18n.global.te(key) ? t(key) : component.label
}

// One unit system with 存储 (lib/format-bytes): the two cards' sizes read alike.
function formatBytes(bytes: number | null | undefined) {
  return Number.isFinite(bytes) ? formatByteCount(Number(bytes)) : '—'
}

function barWidth(bytes: number, maximum: number) {
  return `${Math.max(3, Math.round((bytes / maximum) * 100))}%`
}

function formatTime(value: string | undefined) {
  return formatDateTime(value, locale.value, { hour: '2-digit', minute: '2-digit', second: '2-digit' }, { missing: '—' })
}
</script>

<template>
  <PageColumns>
    <Card as="section" class="settings-card" aria-labelledby="settings-interface-title">
      <CardHeader><CardTitle id="settings-interface-title" as="h2">{{ t('settings.groups.interface') }}<AiHelpButton term="task.interface" /></CardTitle></CardHeader>
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
          <Switch data-reduce-motion :model-value="motionPreference === 'reduced'" :aria-label="t('settings.behavior.reduceMotion')"
            @update:model-value="setMotionPreference($event ? 'reduced' : 'system')" />
        </label>
      </div>
    </Card>
    <Card as="section" id="version" class="settings-card" aria-labelledby="settings-version-title" data-version-settings>
      <CardHeader><CardTitle id="settings-version-title" as="h2">{{ t('settings.version.title') }}<AiHelpButton term="task.version" /></CardTitle></CardHeader>
      <div class="setting-list">
        <div class="setting-row">
          <span><strong>{{ t('settings.version.current') }}</strong></span>
          <span class="version-number" data-current-version>v{{ FULI_VERSION }}</span>
        </div>
        <label class="setting-row">
          <span><strong>{{ t('settings.version.beta') }}</strong><small>{{ t('settings.version.betaMeta') }}</small></span>
          <Switch :model-value="form.updateChannel === 'beta'" :aria-label="t('settings.version.beta')" data-update-channel
            @update:model-value="form.updateChannel = $event ? 'beta' : 'stable'" />
        </label>
        <div class="setting-row version-latest" :class="{ 'version-latest-offer': offersUpdate(versionStatus) }"
          aria-live="polite" data-version-latest>
          <GrowthLoading v-if="!versionStatus && !versionFailed" variant="inline" :label="t('settings.version.checking')" />
          <span v-else-if="versionFailed || versionStatus?.status === 'unavailable'"><strong>{{ t('settings.version.unavailable') }}</strong></span>
          <template v-else-if="offersUpdate(versionStatus)">
            <span class="version-offer-head"><strong>{{ t('settings.version.available', { version: versionStatus.latestVersion }) }}</strong>
              <small>{{ t('settings.version.checkedAt', { time: versionCheckedAt(versionStatus.checkedAt) }) }}</small></span>
            <ConsoleUpdate :version="versionStatus.latestVersion" :kind="versionStatus.updateKind ?? 'npm'" />
          </template>
          <span v-else-if="versionStatus"><strong>{{ t('settings.version.upToDate') }}</strong>
            <small>{{ t('settings.version.checkedAt', { time: versionCheckedAt(versionStatus.checkedAt) }) }}</small></span>
          <!-- Asks npm again now; the update button takes over once a newer release is found. -->
          <Button v-if="!offersUpdate(versionStatus) && (versionStatus || versionFailed)" type="button" variant="outline" size="sm"
            class="version-recheck" :loading="versionChecking" :loading-label="t('settings.version.checking')"
            data-version-recheck @click="recheckVersion">{{ t('settings.version.recheck') }}</Button>
        </div>
      </div>
    </Card>
    <Card as="section" class="settings-card" aria-labelledby="settings-data-format-title">
      <CardHeader>
        <CardTitle id="settings-data-format-title" as="h2">{{ t('dataFormat.title') }}<AiHelpButton term="task.dataFormat" /></CardTitle>
        <CardDescription>{{ t('dataFormat.settingsEntry') }}</CardDescription>
        <CardAction>
          <Button as-child size="sm" variant="outline">
            <RouterLink to="/settings/data-format" data-open-data-format>{{ t('dataFormat.open') }}</RouterLink>
          </Button>
        </CardAction>
      </CardHeader>
    </Card>
    <StorageSettings />
    <Card as="section" class="settings-card" aria-labelledby="settings-runtime-title">
      <CardHeader><CardTitle id="settings-runtime-title" as="h2">{{ t('settings.groups.runtime') }}<AiHelpButton term="task.runtime" /></CardTitle></CardHeader>
      <div class="setting-list">
        <!-- Native is the only runtime that grows; an older Docker install
             moves over once through the migration, never by switching here. -->
        <GraphMigrationRow v-if="runtimeMode === 'container'" />
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
    </Card>
    <DiagnosticsSettings />
    <Card as="section" class="settings-card resource-card" data-span="wide" aria-labelledby="settings-resources-title">
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
        <div class="resource-details">
          <div class="resource-breakdowns">
            <div class="resource-group">
              <h3 class="ui-group-label">{{ t('settings.resources.memory') }}</h3>
              <div v-for="component in resources.memory.components" :key="component.id" class="resource-row">
                <div><span>{{ componentLabel(component) }}</span><strong>{{ formatBytes(component.bytes) }}</strong></div>
                <i><b :style="{ width: barWidth(component.bytes, memoryMax) }" /></i>
              </div>
            </div>
            <div class="resource-group">
              <h3 class="ui-group-label">{{ t('settings.resources.disk') }}</h3>
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
        </div>
      </template>
    </Card>
  </PageColumns>
</template>

<style scoped>
.version-number { font-variant-numeric: tabular-nums; font-weight: var(--weight-medium); }
.version-latest { min-height: var(--control-height); cursor: default; }
/* A newer version: its name and check time on one line, the update below at
   full width, so the explanation is not squeezed beside a narrow heading. */
.version-latest-offer { flex-direction: column; align-items: stretch; gap: 10px; }
.version-latest-offer > .version-offer-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }

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
.resource-row { display: grid; gap: 6px; }
.resource-row > div { display: flex; justify-content: space-between; gap: 12px; color: var(--color-muted); font-size: 12px; }
.resource-row strong { color: var(--color-ink); font-weight: 650; }
.resource-row i { height: 5px; overflow: hidden; border-radius: 999px; background: var(--color-surface-subtle); }
.resource-row b { display: block; height: 100%; border-radius: inherit; background: var(--color-muted); }
.resource-details { display: grid; gap: var(--space-4); padding-inline: 24px; }
.resource-notes { display: flex; flex-wrap: wrap; gap: 8px 18px; color: var(--color-muted); font-size: 12px; }

@container (max-width: 640px) { .resource-breakdowns { grid-template-columns: minmax(0, 1fr); } }
@container (max-width: 420px) { .resource-totals { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 680px) { .resource-details, .resource-totals { padding-inline: var(--space-4); } }
</style>
