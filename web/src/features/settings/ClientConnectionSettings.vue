<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { deleteJson, getJson, postJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import TextField from '@/components/TextField.vue'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { OptionSelect } from '@/components/ui/select'
import { currentLocale, t } from '@/i18n'
import { formatDateTime } from '@/lib/date-time'
import UiIcon from '@/ui/UiIcon.vue'
import UiNotice from '@/ui/UiNotice.vue'

import { CUSTOM_CLIENT_FORMATS, connectActionKey, connectionSummary, shownClients, type ClientObservation, type ClientStatus,
  type ConnectionResult, type ConnectionStatus, type CustomClient, type CustomClientFormat, type Format } from './client-connection-model'

// Re-read configuration this often while the page is visible.
const RECHECK_MS = 15_000
const GUIDE_URL = 'https://github.com/JevonsCode/fuli/blob/main/docs/client-connections.md'

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
const adding = ref(false)
const addPending = ref(false)
const addError = ref('')
const removing = ref('')
const removeError = ref('')
const draft = reactive<{ name: string, mcpFile: string, format: CustomClientFormat }>({ name: '', mcpFile: '', format: 'mcp-servers-json' })
let active = false
let unmounted = false
// Bumped whenever the view hides or a write starts, so a response requested before then is dropped.
let generation = 0
let timer: ReturnType<typeof setTimeout> | undefined
const text = computed(() => configuration.value ? JSON.stringify(configuration.value[format.value], null, 2) : '')
const options = computed(() => (['standard', 'vscode', 'server'] as const).map((value) => ({
  value, label: t(`settings.connection.formats.${value}`),
})))
const formatOptions = computed(() => CUSTOM_CLIENT_FORMATS.map((value) => ({ value, label: t(`settings.connection.custom.formats.${value}`) })))
const clients = computed(() => shownClients(observation.value))
const customClients = computed<CustomClient[]>(() => observation.value?.customClients ?? [])
const summary = computed(() => connectionSummary(observation.value))
const busy = computed(() => Boolean(connecting.value) || addPending.value || Boolean(removing.value))
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
const watching = () => active && !unmounted && document.visibilityState === 'visible'
// One request at a time; a response older than the shown one, or requested
// before the view hid or a write began, never replaces it.
async function check() {
  if (checking.value || busy.value || !watching()) return
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
// A write invalidates any observation in flight and rechecks when it ends.
async function writing(run: () => Promise<void>) {
  generation += 1
  clearTimeout(timer)
  try { await run() } finally {
    generation += 1
    void check()
  }
}
async function connect(client: ClientObservation) {
  if (busy.value || !canConnect(client)) return
  connecting.value = client.id
  delete connectionFeedback.value[client.id]
  await writing(async () => {
    try {
      const result = await postJson<ConnectionResult>('/api/system/client-connection/connect', { clientId: client.id })
      if (!unmounted) connectionFeedback.value[client.id] = result.status === 'connected' ? 'restart' : 'connectError'
    } catch {
      if (!unmounted) connectionFeedback.value[client.id] = 'connectError'
    } finally { connecting.value = '' }
  })
}
async function addClient() {
  if (busy.value || !draft.name.trim() || !draft.mcpFile.trim()) return
  addPending.value = true
  addError.value = ''
  await writing(async () => {
    try {
      await postJson('/api/system/client-connection/custom-clients', { name: draft.name.trim(), mcpFile: draft.mcpFile.trim(), format: draft.format })
      Object.assign(draft, { name: '', mcpFile: '', format: 'mcp-servers-json' })
      adding.value = false
    } catch (reason) {
      addError.value = t('settings.connection.custom.addError', { reason: reason instanceof Error ? reason.message : String(reason) })
    } finally { addPending.value = false }
  })
}
async function removeClient(client: CustomClient) {
  if (busy.value) return
  removing.value = client.id
  removeError.value = ''
  await writing(async () => {
    try { await deleteJson(`/api/system/client-connection/custom-clients/${encodeURIComponent(client.id)}`) }
    catch { removeError.value = t('settings.connection.custom.removeError') }
    finally { removing.value = '' }
  })
}
const canConnect = (client: ClientObservation) => client.detected && !client.manualOnly && client.status !== 'unknown'
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
onMounted(() => {
  active = true
  document.addEventListener('visibilitychange', returned)
  window.addEventListener('focus', returned)
  void load()
  void check()
})
onBeforeUnmount(() => {
  unmounted = true
  active = false
  generation += 1
  clearTimeout(timer)
  document.removeEventListener('visibilitychange', returned)
  window.removeEventListener('focus', returned)
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
function selectFormat(value: string) {
  const known = CUSTOM_CLIENT_FORMATS.find((candidate) => candidate === value)
  if (known) draft.format = known
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
  <Card as="section" class="settings-card connection-settings" aria-labelledby="client-connection-title" data-client-connection>
    <CardHeader>
      <CardTitle id="client-connection-title" as="h2">{{ t('settings.connection.title') }}</CardTitle>
      <!-- Reserved height: the summary appears without moving anything below it. -->
      <CardDescription class="connection-summary" data-connection-summary>
        <template v-if="observation?.available !== false && summary.total">{{ t('settings.connection.summary', summary) }}</template>
      </CardDescription>
      <CardAction>
        <Button variant="outline" size="icon-sm" class="connection-refresh" data-refresh-clients :disabled="checking"
          :title="t('settings.connection.clients.refresh')" :aria-label="t('settings.connection.clients.refresh')" @click="check">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.6-4.5L4 8" /><path d="M4 3v5h5" /><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16" /><path d="M20 21v-5h-5" /></svg>
        </Button>
      </CardAction>
    </CardHeader>

    <div class="connection-sections">
      <section class="connection-section" aria-labelledby="client-connection-detected">
        <h3 id="client-connection-detected" class="ui-group-label">{{ t('settings.connection.clients.title') }}</h3>
        <GrowthLoading v-if="checking && !observation" variant="compact" :label="t('settings.connection.clients.checking')" />
        <UiNotice v-if="checkError" tone="warning">{{ t('settings.connection.clients.checkError') }}</UiNotice>
        <UiNotice v-if="observation?.available === false" tone="warning" data-detection-unavailable>{{ t('settings.connection.clients.unavailable') }}</UiNotice>
        <!-- One tile per client, as many per row as the width holds; a long list scrolls inside, the page does not grow. -->
        <ul v-if="observation && observation.available !== false" class="client-grid">
          <li v-for="client in clients" :key="client.id" :data-client-status="client.status"
            :class="`client-row client-row--${client.status}`">
            <span class="client-row__icon" aria-hidden="true"><UiIcon v-if="client.status === 'connected'" name="check" :size="14" /><template v-else>{{ icons[client.status] }}</template></span>
            <div class="client-row__body">
              <div class="client-row__head">
                <strong :title="client.label">{{ client.label }}</strong>
                <span class="client-row__label">{{ t(`settings.connection.clients.status.${client.status}`) }}</span>
              </div>
              <p>{{ explanation(client) }}</p>
              <p v-if="connectionFeedback[client.id]" :role="connectionFeedback[client.id] === 'connectError' ? 'alert' : 'status'">
                {{ t(`settings.connection.clients.${connectionFeedback[client.id]}`) }}
              </p>
              <a v-if="client.manualOnly && client.manualUrl" :href="client.manualUrl" target="_blank" rel="noopener noreferrer">
                {{ t('settings.connection.clients.manualConnect') }}
              </a>
              <p v-else-if="client.manualOnly && client.status !== 'connected'">{{ t('settings.connection.clients.manualSnippet') }}</p>
              <p v-if="client.changes.length" class="client-row__meta">
                {{ t('settings.connection.clients.lastChange', {
                  from: t(`settings.connection.clients.status.${client.changes.at(-1)!.from}`),
                  to: t(`settings.connection.clients.status.${client.changes.at(-1)!.to}`),
                  time: formatTime(client.changes.at(-1)!.detectedAt) }) }}
              </p>
              <!-- The tile's action sits at its foot, so tiles of one row line up their buttons. -->
              <Button v-if="canConnect(client) && client.status !== 'connected'" size="sm" variant="outline" class="client-row__action"
                :data-connect-client="client.id" :disabled="busy" :loading="connecting === client.id"
                :loading-label="t('settings.connection.clients.connecting', { client: client.label })" @click="connect(client)">
                {{ t(`settings.connection.clients.${connectActionKey(client.status)}`) }}
              </Button>
            </div>
          </li>
          <li v-if="!clients.length" class="client-grid__empty">{{ t('settings.connection.clients.none') }}</li>
        </ul>
        <p v-if="observation && observation.available !== false" class="client-row__meta" role="status">
          {{ t('settings.connection.clients.observedAt', { time: formatTime(observation.observedAt) }) }}
          {{ t('settings.connection.clients.boundary') }}
          <template v-if="!observation.historySaved">{{ t('settings.connection.clients.historyUnsaved') }}</template>
        </p>
      </section>

      <section class="connection-section" aria-labelledby="client-connection-manual">
        <div class="connection-section__head">
          <h3 id="client-connection-manual" class="ui-group-label">{{ t('settings.connection.custom.title') }}</h3>
          <Button v-if="!adding" size="sm" variant="outline" data-add-custom-client :disabled="observation?.available === false"
            @click="adding = true">{{ t('settings.connection.custom.add') }}</Button>
        </div>
        <form v-if="adding" class="custom-form" data-custom-client-form @submit.prevent="addClient">
          <TextField v-model="draft.name" control-id="custom-client-name" :label="t('settings.connection.custom.name')"
            :placeholder="t('settings.connection.custom.namePlaceholder')" required />
          <TextField v-model="draft.mcpFile" control-id="custom-client-file" :label="t('settings.connection.custom.mcpFile')"
            placeholder="~/.acme/mcp.json" required />
          <OptionSelect control-id="custom-client-format" :model-value="draft.format" :options="formatOptions"
            :label="t('settings.connection.custom.format')" @update:model-value="selectFormat" />
          <div class="custom-form__actions">
            <Button type="submit" size="sm" data-submit-custom-client :disabled="busy || !draft.name.trim() || !draft.mcpFile.trim()"
              :loading="addPending" :loading-label="t('settings.connection.custom.adding', { client: draft.name.trim() })">
              {{ t('settings.connection.custom.submit') }}
            </Button>
            <Button type="button" size="sm" variant="ghost" :disabled="addPending" @click="adding = false; addError = ''">
              {{ t('settings.connection.custom.cancel') }}
            </Button>
          </div>
          <UiNotice v-if="addError" tone="error">{{ addError }}</UiNotice>
        </form>
        <ul v-if="customClients.length" class="client-grid">
          <li v-for="client in customClients" :key="client.id" :data-custom-client="client.id" :data-client-status="client.status"
            :class="`client-row client-row--${client.status}`">
            <span class="client-row__icon" aria-hidden="true"><UiIcon v-if="client.status === 'connected'" name="check" :size="14" /><template v-else>{{ icons[client.status] }}</template></span>
            <div class="client-row__body">
              <div class="client-row__head">
                <strong>{{ client.label }}</strong>
                <span class="client-row__label">{{ t(`settings.connection.clients.status.${client.status}`) }}</span>
                <Button v-if="client.removable" size="icon-sm" variant="ghost" class="client-row__action" :data-remove-custom-client="client.id"
                  :disabled="busy" :loading="removing === client.id" :loading-label="t('settings.connection.custom.removing', { client: client.label })"
                  :title="t('settings.connection.custom.remove', { client: client.label })"
                  :aria-label="t('settings.connection.custom.remove', { client: client.label })" @click="removeClient(client)">
                  <UiIcon name="close" :size="14" />
                </Button>
              </div>
              <p v-for="path in client.mcpPaths" :key="path">
                {{ t('settings.connection.custom.where', { path }) }}
              </p>
            </div>
          </li>
        </ul>
        <UiNotice v-if="removeError" tone="error">{{ removeError }}</UiNotice>

        <GrowthLoading v-if="loading" variant="compact" :label="t('settings.connection.loading')" />
        <UiNotice v-if="error" tone="error">
          {{ error }}
          <template #actions><Button size="sm" variant="outline" data-retry-connection @click="load">{{ t('settings.connection.retry') }}</Button></template>
        </UiNotice>
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
          <p>{{ t('settings.connection.merge') }} {{ t('settings.connection.boundary') }}
            <a :href="GUIDE_URL" target="_blank" rel="noopener noreferrer">{{ t('settings.connection.guide') }}</a></p>
        </template>
      </section>
    </div>
  </Card>
</template>

<style scoped>
.connection-settings p { color: var(--color-muted); font-size: 13px; line-height: 1.6; }
.connection-settings a { font-size: 13px; }
/* One line is always reserved so the summary never pushes the sections down. */
.connection-summary { min-height: 1.5em; }
.connection-refresh svg { width: 18px; height: 18px; }
/* Detected clients first, connecting by hand below, both full width. */
.connection-sections { display: grid; gap: 28px; padding-inline: 24px; }
.connection-section { display: grid; gap: 12px; align-content: start; min-width: 0; }
.connection-section + .connection-section { padding-top: 24px; border-top: 1px solid var(--color-border); }
.connection-section__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: var(--control-height-sm); }
/* Tiles fill the row by width; past two rows the grid scrolls inside itself. */
.client-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 248px), 1fr)); gap: 12px;
  max-height: 392px; margin: 0; padding: 2px; overflow-y: auto; list-style: none; scrollbar-gutter: stable;
}
.client-grid__empty { grid-column: 1 / -1; color: var(--color-muted); font-size: 13px; }
.client-row {
  display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 10px; align-items: start; min-width: 0;
  padding: 14px; border-radius: var(--radius-card); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border);
}
.client-row--connected { background: color-mix(in srgb, var(--color-success-soft) 35%, var(--color-surface)); }
.client-row__body { display: flex; flex-direction: column; gap: 4px; min-width: 0; height: 100%; overflow-wrap: anywhere; }
.client-row__body p { margin: 0; }
/* Name and status on top, the action pinned to the tile's right so it never moves. */
.client-row__head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; min-height: 26px; padding-top: 2px; }
.client-row__head strong { overflow: hidden; color: var(--color-ink); font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.client-row__label { flex: none; color: var(--color-muted); font-size: 12px; }
.client-row__action { align-self: flex-start; margin-top: auto; }
.client-row__head .client-row__action { margin: 0 0 0 auto; align-self: center; }
.client-row__icon {
  display: inline-grid; width: 22px; height: 22px; margin-top: 4px; place-items: center; border: 1px solid currentColor; border-radius: 50%;
  color: var(--color-muted); font-size: 12px; font-weight: var(--weight-strong);
}
.client-row--connected .client-row__icon { color: var(--color-success); }
.client-row--removed .client-row__icon,
.client-row--changed .client-row__icon,
.client-row--skills_left .client-row__icon { color: var(--color-warning); }
.connection-settings .client-row__meta { font-size: 12px; }
.client-row .client-row__meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.custom-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 12px; align-items: end; padding: 14px; border-radius: var(--radius-card); box-shadow: 0 0 0 1px var(--color-border); }
.custom-form__actions { display: flex; gap: 8px; }
.custom-form > :deep(.ui-notice) { grid-column: 1 / -1; }
/* The format select and its copy button share one control height. */
.connection-toolbar { display: flex; align-items: flex-end; gap: 8px; }
.connection-toolbar :deep([data-slot=option-select]) { min-width: 0; flex: 0 1 300px; }
.connection-copy svg { width: 18px; height: 18px; }
@media (max-width: 680px) { .connection-sections { padding-inline: var(--space-4); } }
textarea { display: block; box-sizing: border-box; width: 100%; min-width: 0; resize: vertical; font: 12px/1.65 var(--font-mono, monospace); overflow-wrap: anywhere; }
</style>
