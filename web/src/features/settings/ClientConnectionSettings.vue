<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { getJson, postJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import UiDisclosure from '@/components/UiDisclosure.vue'
import { currentLocale, t } from '@/i18n'
import { formatDateTime } from '@/lib/date-time'

import { connectActionKey, type Format, type ClientStatus, type ClientObservation, type ConnectionStatus,
  type ConnectionResult } from './client-connection-model'
import { OptionSelect } from '@/components/ui/select'
import UiIcon from '@/ui/UiIcon.vue'
// Re-read configuration this often while the card is open and the page visible.
const RECHECK_MS = 15_000

const configuration = ref<Record<Format, object> | null>(null)
const format = ref<Format>('standard')
const loading = ref(false)
const error = ref('')
const feedback = ref<'copied' | 'manual' | ''>('')
const observation = ref<ConnectionStatus | null>(null)
const checking = ref(false)
const checkError = ref(false)
const connecting = ref('')
const connectionFeedback = ref<Record<string, 'restart' | 'connectError'>>({})
let active = false
let unmounted = false
// Bumped whenever the view closes or hides, so a response requested before then is dropped.
let generation = 0
let timer: ReturnType<typeof setTimeout> | undefined
const text = computed(() => configuration.value ? JSON.stringify(configuration.value[format.value], null, 2) : '')
const options = computed(() => (['standard', 'vscode', 'server'] as const).map((value) => ({
  value, label: t(`settings.connection.formats.${value}`),
})))
const clients = computed(() => (observation.value?.clients ?? []).filter((client) => client.status !== 'not_detected'))
// A connected client gets the shared check icon; the other states keep their plain marks.
const icons: Record<Exclude<ClientStatus, 'connected'>, string> = { changed: '!', skills_left: '!', removed: '×',
  not_connected: '○', not_detected: '○', unknown: '?' }

async function load() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try { configuration.value = await getJson<Record<Format, object>>('/api/system/client-connection') }
  catch { error.value = t('settings.connection.loadError') }
  finally { loading.value = false }
}
function opened(event: Event) {
  // A toggle queued by the browser can arrive after unmount; never restart then.
  if (unmounted) return
  const open = (event.target as HTMLDetailsElement).open
  if (open && !configuration.value && !loading.value && !error.value) void load()
  if (open) start()
  else stop()
}
const watching = () => active && !unmounted && document.visibilityState === 'visible'
// One request at a time; a response older than the shown one, or requested
// before the view closed or hid, never replaces it.
async function check() {
  if (checking.value || connecting.value || !watching()) return
  clearTimeout(timer)
  checking.value = true
  const requested = generation
  let fresh = false
  try {
    const next = await getJson<ConnectionStatus>('/api/system/client-connection/status')
    fresh = requested === generation
    if (fresh && (!observation.value || next.observedAt >= observation.value.observedAt)) observation.value = next
    if (fresh) checkError.value = false
  } catch {
    fresh = requested === generation
    if (fresh) checkError.value = true
  } finally {
    checking.value = false
    // A dropped response is replaced at once if the view is watched again.
    if (fresh) schedule()
    else void check()
  }
}
async function connect(client: ClientObservation) {
  if (connecting.value || !client.detected || client.manualOnly || client.status === 'unknown') return
  connecting.value = client.id
  delete connectionFeedback.value[client.id]
  generation += 1
  clearTimeout(timer)
  try {
    const result = await postJson<ConnectionResult>('/api/system/client-connection/connect', { clientId: client.id })
    if (!unmounted) connectionFeedback.value[client.id] = result.status === 'connected' ? 'restart' : 'connectError'
  } catch {
    if (!unmounted) connectionFeedback.value[client.id] = 'connectError'
  } finally {
    connecting.value = ''
    // Any in-flight observation is invalidated; its finalizer will recheck.
    generation += 1
    void check()
  }
}
function schedule() {
  clearTimeout(timer)
  if (watching()) timer = setTimeout(() => void check(), RECHECK_MS)
}
function returned() {
  if (document.visibilityState === 'visible') void check()
  else {
    generation += 1
    clearTimeout(timer)
  }
}
function start() {
  if (active) return
  active = true
  document.addEventListener('visibilitychange', returned)
  window.addEventListener('focus', returned)
  void check()
}
function stop() {
  active = false
  generation += 1
  clearTimeout(timer)
  document.removeEventListener('visibilitychange', returned)
  window.removeEventListener('focus', returned)
}
onBeforeUnmount(() => {
  unmounted = true
  stop()
})
function formatTime(value: string) {
  return formatDateTime(value, currentLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }, { missing: '—' })
}
function explanation(client: ClientObservation) {
  if (client.status === 'unknown' && client.lastKnownStatus) {
    return t('settings.connection.clients.unknownWithLast', { status: t(`settings.connection.clients.status.${client.lastKnownStatus}`) })
  }
  return t(`settings.connection.clients.explain.${client.status}`)
}
function select(value: string) {
  if (value === 'standard' || value === 'vscode' || value === 'server') {
    format.value = value
    feedback.value = ''
  }
}
async function copy() {
  const selected = text.value
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
    await navigator.clipboard.writeText(selected)
    if (text.value === selected) feedback.value = 'copied'
  } catch { if (text.value === selected) feedback.value = 'manual' }
}
</script>

<template>
  <UiDisclosure class="settings-card connection-settings" :title="t('settings.connection.title')" @toggle="opened">
    <p>{{ t('settings.connection.description') }}</p>
    <section class="client-status" :aria-label="t('settings.connection.clients.title')">
      <div class="client-status__header">
        <h3>{{ t('settings.connection.clients.title') }}</h3>
        <Button variant="outline" size="icon-sm" class="client-status__refresh" data-refresh-clients :disabled="checking"
          :title="t('settings.connection.clients.refresh')" :aria-label="t('settings.connection.clients.refresh')" @click="check">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8" /><path d="M4 3v5h5" /><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16" /><path d="M20 21v-5h-5" /></svg>
        </Button>
      </div>
      <GrowthLoading v-if="checking && !observation" variant="compact" :label="t('settings.connection.clients.checking')" />
      <p v-if="checkError" role="alert">{{ t('settings.connection.clients.checkError') }}</p>
      <ul v-if="observation">
        <li v-for="client in clients" :key="client.id" :data-client-status="client.status"
          :class="`client-status__item client-status__item--${client.status}`">
          <span class="client-status__icon" aria-hidden="true"><UiIcon v-if="client.status === 'connected'" name="check" :size="14" /><template v-else>{{ icons[client.status] }}</template></span>
          <div>
            <strong>{{ client.label }}</strong>
            <span class="client-status__label">{{ t(`settings.connection.clients.status.${client.status}`) }}</span>
            <p>{{ explanation(client) }}</p>
            <Button v-if="client.detected && !client.manualOnly && client.status !== 'unknown' && client.status !== 'connected'"
              variant="outline" :data-connect-client="client.id" :disabled="Boolean(connecting)" @click="connect(client)">
              {{ t(`settings.connection.clients.${connectActionKey(client.status)}`) }}
            </Button>
            <GrowthLoading v-if="connecting === client.id" variant="compact" :label="t('settings.connection.clients.connecting', { client: client.label })" />
            <p v-if="connectionFeedback[client.id]" :role="connectionFeedback[client.id] === 'connectError' ? 'alert' : 'status'">
              {{ t(`settings.connection.clients.${connectionFeedback[client.id]}`) }}
            </p>
            <a v-if="client.manualOnly" :href="client.manualUrl" target="_blank" rel="noopener noreferrer">
              {{ t('settings.connection.clients.manualConnect') }}
            </a>
            <p v-if="client.changes.length" class="client-status__change">
              {{ t('settings.connection.clients.lastChange', {
                from: t(`settings.connection.clients.status.${client.changes.at(-1)!.from}`),
                to: t(`settings.connection.clients.status.${client.changes.at(-1)!.to}`),
                time: formatTime(client.changes.at(-1)!.detectedAt) }) }}
            </p>
          </div>
        </li>
        <li v-if="!clients.length">{{ t('settings.connection.clients.none') }}</li>
      </ul>
      <p v-if="observation" class="client-status__meta" role="status">
        {{ t('settings.connection.clients.observedAt', { time: formatTime(observation.observedAt) }) }}
        {{ t('settings.connection.clients.boundary') }}
        <template v-if="!observation.historySaved">{{ t('settings.connection.clients.historyUnsaved') }}</template>
      </p>
    </section>
    <GrowthLoading v-if="loading" variant="compact" :label="t('settings.connection.loading')" />
    <div v-if="error" role="alert">
      <span>{{ error }}</span>
      <Button variant="outline" data-retry-connection @click="load">{{ t('settings.connection.retry') }}</Button>
    </div>
    <template v-if="configuration">
      <div class="connection-toolbar">
        <OptionSelect control-id="client-connection-format" :model-value="format" :options="options"
          :label="t('settings.connection.format')" @update:model-value="select" />
        <Button variant="outline" size="icon" class="connection-copy" data-copy-connection
          :title="t('settings.connection.copy')" :aria-label="t('settings.connection.copy')" @click="copy">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></svg>
        </Button>
      </div>
      <textarea :value="text" readonly rows="8" spellcheck="false" :aria-label="t('settings.connection.configuration')" />
      <p v-if="feedback" role="status">{{ t(`settings.connection.${feedback}`) }}</p>
      <p>{{ t('settings.connection.merge') }}</p>
    </template>
    <p class="connection-boundary">{{ t('settings.connection.boundary') }}</p>
    <a href="https://github.com/JevonsCode/fuli/blob/main/docs/client-connections.md" target="_blank" rel="noopener noreferrer">{{ t('settings.connection.guide') }}</a>
  </UiDisclosure>
</template>

<style scoped>
.connection-settings p { color: var(--color-muted); font-size: 13px; line-height: 1.6; margin: 12px 0; }
.connection-toolbar { display: flex; align-items: center; gap: 12px; margin: 16px 0 10px; }
.connection-toolbar :deep(:is([data-slot=option-select], [data-slot=option-combobox])) { min-width: 0; flex: 1; max-width: 300px; }
.connection-copy { width: 40px; height: 40px; flex: 0 0 40px; padding: 9px; }
.connection-copy svg { width: 20px; height: 20px; }
textarea { display: block; box-sizing: border-box; width: 100%; min-width: 0; resize: vertical; font: 12px/1.65 var(--font-mono, monospace); overflow-wrap: anywhere; }
.connection-settings a { font-size: 13px; }
.client-status { margin: 16px 0; padding: 12px 14px; border: 1px solid var(--color-border); border-radius: var(--radius-control); }
.client-status__header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.client-status h3 { font-size: 14px; margin: 0; }
.client-status__refresh { width: 32px; height: 32px; flex: 0 0 32px; padding: 6px; }
.client-status__refresh svg { width: 18px; height: 18px; }
.client-status ul { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 10px; }
.client-status__item { display: flex; gap: 10px; align-items: flex-start; min-width: 0; }
.client-status__item > div { min-width: 0; overflow-wrap: anywhere; }
.client-status__item p { margin: 2px 0 0; }
.client-status__icon { flex: 0 0 22px; height: 22px; border-radius: 50%; display: inline-grid; place-items: center;
  font-size: 12px; font-weight: 600; border: 1px solid currentColor; color: var(--color-muted); }
.client-status__item--connected .client-status__icon { color: var(--color-success); }
.client-status__item--removed .client-status__icon,
.client-status__item--changed .client-status__icon,
.client-status__item--skills_left .client-status__icon { color: var(--color-warning); }
.client-status__label { margin-left: 8px; font-size: 13px; color: var(--color-muted); }
.connection-settings .client-status__change, .connection-settings .client-status__meta { font-size: 12px; }
.connection-settings .client-status__meta { margin: 10px 0 0; }
@media (max-width: 560px) {
  .client-status { padding: 10px; }
  .client-status__label { display: block; margin-left: 0; }
}
</style>
