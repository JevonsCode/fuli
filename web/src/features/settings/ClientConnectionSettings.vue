<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { postJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import AiHelpButton from '@/features/ai-help/AiHelpButton.vue'
import { currentLocale, t } from '@/i18n'
import { formatDateTime } from '@/lib/date-time'
import UiIcon from '@/ui/UiIcon.vue'
import UiNotice from '@/ui/UiNotice.vue'
import ClientConnectionDetails from './ClientConnectionDetails.vue'
import { injectClientConnectionStatus } from './client-connection-status'

import { STATUS_ICONS, canConnect, changedExplanation, connectActionKey, connectionSummary, offersRestart, shownClients,
  type ClientObservation, type ConnectionResult, restartResultShape, type RestartStatus } from './client-connection-model'

// Settings › 客户端's first card: whether each client on this machine has
// FULI, with 接入, 一键接入 and 重启并更新. Clients described by hand and the
// configuration to copy are the manual card's (ClientManualConnection.vue).
const { observation, checking, checkError, connectingAll, busy, check, writing } = injectClientConnectionStatus()
const connecting = ref('')
const connectionFeedback = ref<Record<string, 'restart' | 'connectError' | 'componentUnavailable' | 'clientRunning'>>({})
// 「重启并更新」 (rec issue 106): the client being confirmed, the one restarting, and each one's last outcome.
const confirming = ref<ClientObservation | null>(null)
const restarting = ref('')
const restartFeedback = ref<Record<string, RestartStatus | 'connect_failed_closed' | 'error'>>({})
// 查看详情: a client's id, or 'installs' for the 「本机有两份 FULI」 notice.
const details = ref<string | null>(null)
let unmounted = false
const clients = computed(() => shownClients(observation.value))
const summary = computed(() => connectionSummary(observation.value))
const installs = computed(() => observation.value?.installs)
const otherInstalls = computed(() => installs.value?.others ?? [])
const detailClient = computed(() => clients.value.find(client => client.id === details.value))
// 一键接入 (Jevons 11-02): every client FULI can write that is not connected yet, one after another.
// A running client that writes its old entry back waits for its own 重启并更新 (rec issue 106).
const connectable = computed(() => clients.value.filter(client => canConnect(client) && client.status !== 'connected' && !offersRestart(client)))

onBeforeUnmount(() => { unmounted = true })

// One client's write, shared by its own 接入 and 一键接入; its result shows on its tile.
async function connectOne(client: ClientObservation) {
  connecting.value = client.id
  delete connectionFeedback.value[client.id]
  await writing(async () => {
    try {
      const result = await postJson<ConnectionResult>('/api/system/client-connection/connect', { clientId: client.id })
      if (!unmounted) connectionFeedback.value[client.id] = result.status === 'connected' ? 'restart'
        : result.reason === 'client_component_unavailable' ? 'componentUnavailable'
          : result.reason === 'client_running' ? 'clientRunning' : 'connectError'
    } catch {
      if (!unmounted) connectionFeedback.value[client.id] = 'connectError'
    } finally { connecting.value = '' }
  })
}
async function connect(client: ClientObservation) {
  if (busy.value || !canConnect(client)) return
  await connectOne(client)
}
// Quits the client, updates its entry while it is closed, reopens it (the console's loopback route only).
async function restart() {
  const client = confirming.value
  confirming.value = null
  if (!client || busy.value) return
  restarting.value = client.id
  delete restartFeedback.value[client.id]
  delete connectionFeedback.value[client.id]
  await writing(async () => {
    try {
      const result = await postJson('/api/system/client-connection/restart', { clientId: client.id }, restartResultShape)
      // A failed write says whether the app FULI closed was reopened; without that it was never closed.
      if (!unmounted) restartFeedback.value[client.id] = result.status !== 'connect_failed' ? result.status
        : result.reopened === false ? 'connect_failed_closed' : result.reopened === true ? 'connect_failed' : 'error'
    } catch {
      if (!unmounted) restartFeedback.value[client.id] = 'error'
    } finally { restarting.value = '' }
  })
}
// 一键接入's one indicator names the client being written and how far it is.
const bulk = ref<{ client: string, index: number, count: number } | null>(null)
async function connectAll() {
  if (busy.value || !connectable.value.length) return
  connectingAll.value = true
  const queue = [...connectable.value]
  try {
    for (const [index, client] of queue.entries()) {
      bulk.value = { client: client.label, index: index + 1, count: queue.length }
      await connectOne(client)
    }
  } finally {
    connectingAll.value = false
    bulk.value = null
  }
}
function formatTime(value: string) {
  return formatDateTime(value, currentLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }, { missing: '—' })
}
function explanation(client: ClientObservation) {
  if (client.status === 'unknown' && client.lastKnownStatus) {
    return t('settings.connection.clients.unknownWithLast', { status: t(`settings.connection.clients.status.${client.lastKnownStatus}`) })
  }
  if (client.status === 'changed') {
    const { difference, params, step } = changedExplanation(client, installs.value?.console)
    return `${t(`settings.connection.clients.changed.${difference}`, params)}${t(`settings.connection.clients.changed.${step}`)}`
  }
  return t(`settings.connection.clients.explain.${client.status}`)
}
function lastChange(client: ClientObservation) {
  const change = client.changes.at(-1)
  return change ? t('settings.connection.clients.lastChange', { from: t(`settings.connection.clients.status.${change.from}`),
    to: t(`settings.connection.clients.status.${change.to}`), time: formatTime(change.detectedAt) }) : t('settings.connection.clients.details')
}
function restartOutcome(client: ClientObservation) {
  const outcome = restartFeedback.value[client.id]
  return outcome === 'error' ? t('settings.connection.clients.connectError')
    : t(`settings.connection.clients.restartResult.${outcome}`, { client: client.label })
}
</script>

<template>
  <Card as="section" class="settings-card connection-settings" aria-labelledby="client-connection-title" data-client-connection>
    <CardHeader>
      <CardTitle id="client-connection-title" as="h2">{{ t('settings.connection.title') }}<AiHelpButton term="task.clients" /></CardTitle>
      <!-- Reserved height: the summary appears without moving anything below it. -->
      <CardDescription class="connection-summary" data-connection-summary>
        <GrowthLoading v-if="bulk" variant="inline" data-connecting-all :label="t('settings.connection.clients.connectingAll', bulk)" />
        <template v-else-if="observation?.available !== false && summary.total">{{ t('settings.connection.summary', summary) }}</template>
      </CardDescription>
      <CardAction class="connection-actions">
        <!-- Its progress shows once, in the summary line; the button only waits. -->
        <Button size="sm" data-connect-all :disabled="busy || !connectable.length" @click="connectAll">
          {{ t('settings.connection.clients.connectAll') }}
        </Button>
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
        <UiNotice v-if="installs && otherInstalls.length" tone="warning" data-two-installs>
          {{ t('settings.connection.clients.twoInstalls.notice', { count: otherInstalls.length + 1, version: installs.console.version ?? '—',
            clients: otherInstalls.flatMap(other => other.clients).join('、') }) }}
          <template #actions><Button size="sm" variant="outline" data-install-details-open @click="details = 'installs'">{{ t('settings.connection.clients.details') }}</Button></template>
        </UiNotice>
        <!-- One tile per client, as many per row as the width holds; a long list scrolls inside, the page does not grow. -->
        <ul v-if="observation && observation.available !== false" class="client-grid">
          <li v-for="client in clients" :key="client.id" :data-client-status="client.status"
            :class="`client-row client-row--${client.status}`">
            <span class="client-row__icon" aria-hidden="true"><UiIcon v-if="STATUS_ICONS[client.status]" :name="STATUS_ICONS[client.status]!" :size="client.status === 'connected' ? 14 : 12" /></span>
            <div class="client-row__body">
              <div class="client-row__head">
                <strong :title="client.label">{{ client.label }}</strong>
                <span class="client-row__label">{{ t(`settings.connection.clients.status.${client.status}`) }}</span>
              </div>
              <p>{{ explanation(client) }}</p>
              <p v-if="client.restartSessions" role="status" data-client-restart>{{ t('settings.connection.clients.restartSessions', { count: client.restartSessions }) }}</p>
              <p v-if="connectionFeedback[client.id]" :role="connectionFeedback[client.id] === 'restart' ? 'status' : 'alert'">
                {{ t(`settings.connection.clients.${connectionFeedback[client.id]}`) }}
              </p>
              <p v-if="restartFeedback[client.id]" :role="restartFeedback[client.id] === 'connected' ? 'status' : 'alert'" data-restart-result>
                {{ restartOutcome(client) }}
              </p>
              <a v-if="client.manualOnly && client.manualUrl" :href="client.manualUrl" target="_blank" rel="noopener noreferrer">
                {{ t('settings.connection.clients.manualConnect') }}
              </a>
              <p v-else-if="client.manualOnly && client.status !== 'connected'">{{ t('settings.connection.clients.manualSnippet') }}</p>
              <!-- One line on the tile; the whole history, full times and both installations open in 查看详情. -->
              <Button v-if="client.changes.length || client.configuredInstall" variant="link" class="client-row__meta client-row__history"
                :data-client-details="client.id" :title="`${lastChange(client)} · ${t('settings.connection.clients.details')}`"
                @click="details = client.id">
                {{ lastChange(client) }}
              </Button>
              <!-- The tile's action sits at its foot, so tiles of one row line up their buttons. -->
              <Button v-if="canConnect(client) && offersRestart(client)" size="sm" variant="outline" class="client-row__action"
                :data-restart-client="client.id" :disabled="busy" :loading="restarting === client.id"
                :loading-label="t('settings.connection.clients.restarting', { client: client.label })" @click="confirming = client">
                {{ t('settings.connection.clients.restartAction') }}
              </Button>
              <Button v-else-if="canConnect(client) && client.status !== 'connected'" size="sm" variant="outline" class="client-row__action"
                :data-connect-client="client.id" :disabled="busy" :loading="connecting === client.id && !connectingAll"
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
    </div>
    <Dialog :open="Boolean(confirming)" @update:open="(open: boolean) => { if (!open) confirming = null }">
      <DialogContent v-if="confirming" size="sm" data-restart-confirm>
        <DialogHeader>
          <DialogTitle>{{ t('settings.connection.clients.restartConfirm.title', { client: confirming.label }) }}</DialogTitle>
          <DialogDescription>{{ t('settings.connection.clients.restartConfirm.body', { client: confirming.label }) }}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" @click="confirming = null">{{ t('settings.connection.clients.restartConfirm.cancel') }}</Button>
          <Button data-restart-confirmed @click="restart">{{ t('settings.connection.clients.restartConfirm.confirm') }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog :open="Boolean(details)" @update:open="(open: boolean) => { if (!open) details = null }">
      <DialogContent v-if="details" size="md" data-connection-details>
        <ClientConnectionDetails v-if="details === 'installs'" :installs="installs" />
        <ClientConnectionDetails v-else-if="detailClient" :client="detailClient" :installs="installs" />
      </DialogContent>
    </Dialog>
  </Card>
</template>

<style src="./client-tiles.css" />

<style scoped>
.connection-settings p { color: var(--color-muted); font-size: 13px; line-height: 1.6; }
.connection-settings a { font-size: 13px; }
/* One line is always reserved so the summary never pushes the sections down. */
.connection-summary { min-height: 1.5em; }
/* 一键接入's progress stays on that one line, cut short in a narrow window rather than wrapping. */
.connection-summary :deep(.growth-loading__content) { max-width: 100%; }
.connection-summary :deep(.growth-loading__label) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.connection-refresh svg { width: 18px; height: 18px; }
.connection-actions { display: flex; gap: 8px; }
.connection-settings .client-row__meta { font-size: 12px; }
.client-row .client-row__meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The one-line history opens 查看详情; it reads as text, underlined on hover. */
.client-row__history {
  display: block; max-width: 100%; height: auto; min-height: 0; padding: 0; border: 0; background: none; font-weight: 400; color: var(--color-muted); font: inherit; font-size: 12px;
  line-height: 1.6; text-align: start; cursor: pointer; user-select: none;
}
.client-row__history:hover, .client-row__history:focus-visible { color: var(--color-ink); text-decoration: underline; }
</style>
