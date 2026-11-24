<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { deleteJson, postJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import AiHelpButton from '@/features/ai-help/AiHelpButton.vue'
import { currentLocale, t } from '@/i18n'
import { formatDateTime } from '@/lib/date-time'
import UiIcon from '@/ui/UiIcon.vue'
import UiNotice from '@/ui/UiNotice.vue'
import ClientConnectionDetails from './ClientConnectionDetails.vue'
import ClientFirstRun from './ClientFirstRun.vue'
import ClientRestartConfirm from './ClientRestartConfirm.vue'
import CustomClientDialog from './CustomClientDialog.vue'
import RunnerUpdateAi from './RunnerUpdateAi.vue'
import { ADD_CLIENT_QUERY_KEYS, addClientDraft, type AddClientDraft } from './add-client-prompt'
import { injectClientConnectionStatus } from './client-connection-status'
import { restartClient, restartOutcomeText, type RestartOutcome } from './client-restart'

import { STATUS_ICONS, awaitsFirstConnection, canConnect, changedExplanation, clientCapabilities, clientParts, clientTiles, withoutLifecycle, connectActionKey, connectionSummary, offersRestart,
  type ClientObservation, type ClientTile, type ConnectionResult } from './client-connection-model'

// Settings › 客户端's first card: whether each client has FULI, with 接入,
// 一键接入 and 重启并更新. Clients on this machine come first, then the ones
// the person described by hand, then the tile that adds another
// (CustomClientDialog.vue). The configuration to copy into any other client
// is the manual card's (ClientManualConnection.vue).
const { observation, checking, checkError, connectingAll, busy, check, writing } = injectClientConnectionStatus()
const connecting = ref('')
const connectionFeedback = ref<Record<string, 'restart' | 'connectError' | 'componentUnavailable' | 'componentDownloading' | 'clientRunning'>>({})
// 「重启并更新」 (rec issue 106): the client being confirmed, the one restarting, and each one's last outcome.
const confirming = ref<ClientObservation | null>(null)
const restarting = ref('')
const restartFeedback = ref<Record<string, RestartOutcome>>({})
// 查看详情: a client's id, or 'installs' for the 「本机有两份 FULI」 notice.
const details = ref<string | null>(null)
let unmounted = false
const clients = computed(() => clientTiles(observation.value))
const summary = computed(() => connectionSummary(observation.value))
// On a runner (docs/runner.md) its own clients are listed, its hooks do nothing
// here, and the two computers can run different FULI versions (rec issue 144).
const runner = computed(() => observation.value?.runner ?? null)
const runnerSkew = computed(() => runner.value?.skew ?? null)
const installs = computed(() => observation.value?.installs)
const otherInstalls = computed(() => installs.value?.others ?? [])
const detailClient = computed(() => clients.value.find(client => client.id === details.value))
// 一键接入 (Jevons 11-02): every client FULI can write that is not connected yet, one after another.
// A running client that writes its old entry back waits for its own 重启并更新 (rec issue 106).
const connectable = computed(() => clients.value.filter(client => canConnect(client) && client.status !== 'connected' && !offersRestart(client)))

// 添加客户端: the dialog, and removing a client the person added here.
const adding = ref(false)
// A client's add link (add-client-prompt.ts) opens the dialog filled in, once: its values leave the address.
const route = useRoute()
const router = useRouter()
const prefill = ref<AddClientDraft | null>(null)
onMounted(() => {
  // Mounted without the console's router (a card on its own) there is no link to read.
  if (!route) return
  const draft = addClientDraft(route.query)
  if (!draft) return
  prefill.value = draft
  adding.value = true
  const query = { ...route.query }
  for (const key of ADD_CLIENT_QUERY_KEYS) delete query[key]
  void router.replace({ query })
})
const removing = ref('')
const removeError = ref(false)

onBeforeUnmount(() => { unmounted = true })

async function removeCustom(client: ClientTile) {
  if (busy.value) return
  removing.value = client.id
  removeError.value = false
  await writing(async () => {
    try { await deleteJson(`/api/system/client-connection/custom-clients/${encodeURIComponent(client.id)}`) }
    catch { if (!unmounted) removeError.value = true }
    finally { removing.value = '' }
  })
}

// One client's write, shared by its own 接入, 一键接入 and a client just added; its result shows on its tile.
async function connectOne(clientId: string) {
  connecting.value = clientId
  delete connectionFeedback.value[clientId]
  await writing(async () => {
    try {
      const result = await postJson<ConnectionResult>('/api/system/client-connection/connect', { clientId })
      if (!unmounted) connectionFeedback.value[clientId] = result.status === 'connected' ? 'restart'
        : result.reason === 'client_component_unavailable' ? 'componentUnavailable'
          : result.reason === 'client_component_downloading' ? 'componentDownloading'
          : result.reason === 'client_running' ? 'clientRunning' : 'connectError'
    } catch {
      if (!unmounted) connectionFeedback.value[clientId] = 'connectError'
    } finally { connecting.value = '' }
  })
}
async function connect(client: ClientObservation) {
  if (busy.value || !canConnect(client)) return
  await connectOne(client.id)
}
// Quits the client, updates its entry while it is closed, reopens it (client-restart.ts).
async function restart(client: ClientObservation) {
  if (busy.value) return
  restarting.value = client.id
  delete restartFeedback.value[client.id]
  delete connectionFeedback.value[client.id]
  await writing(async () => {
    try {
      const outcome = await restartClient(client.id)
      if (!unmounted) restartFeedback.value[client.id] = outcome
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
      await connectOne(client.id)
    }
  } finally {
    connectingAll.value = false
    bulk.value = null
  }
}
function formatTime(value: string) {
  return formatDateTime(value, currentLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }, { missing: '—' })
}
// An unreadable configuration file, shown in Finder or Explorer for the person to fix.
const revealFailed = ref<Record<string, boolean>>({})
async function revealFile(client: ClientTile) {
  revealFailed.value = { ...revealFailed.value, [client.id]: false }
  try {
    await postJson('/api/system/client-connection/reveal', { clientId: client.id })
  } catch {
    revealFailed.value = { ...revealFailed.value, [client.id]: true }
  }
}
function explanation(client: ClientTile) {
  if (awaitsFirstConnection(client)) return t('settings.connection.custom.notConnected')
  if (client.inWsl && client.status === 'not_detected') return t('settings.connection.clients.explain.inWsl')
  if (client.status === 'unknown' && client.entryFile) {
    return t('settings.connection.clients.unreadable', { path: client.entryFile.path, problem: client.entryFile.problem })
  }
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
const restartOutcome = (client: ClientObservation) => restartOutcomeText(restartFeedback.value[client.id]!, client.label)
</script>

<template>
  <Card as="section" class="settings-card connection-settings" aria-labelledby="client-connection-title" data-client-connection>
    <CardHeader>
      <CardTitle id="client-connection-title" as="h2">{{ t('settings.connection.title') }}<AiHelpButton term="task.clients" /></CardTitle>
      <!-- Reserved height: the summary appears without moving anything below it. -->
      <CardDescription class="connection-summary" data-connection-summary>
        <GrowthLoading v-if="bulk" variant="inline" data-connecting-all :label="t('settings.connection.clients.connectingAll', bulk)" />
        <template v-else-if="observation?.available !== false && (summary.total || summary.notInstalled)">{{
          t(summary.notInstalled ? 'settings.connection.summaryWithMissing' : 'settings.connection.summary', summary) }}</template>
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
        <UiNotice v-if="checkError" tone="warning" data-check-error>
          {{ t('settings.connection.clients.checkError') }}
          <template #actions><Button size="sm" variant="outline" :loading="checking" :loading-label="t('settings.connection.clients.checking')"
            data-check-again @click="check">{{ t('settings.connection.clients.refresh') }}</Button></template>
        </UiNotice>
        <UiNotice v-if="observation?.available === false && observation.componentDownloading" tone="info" data-component-downloading
          data-no-action="another FULI downloads the component; nothing here can speed or stop it, and the list refreshes by itself when it ends">
          {{ t('settings.connection.clients.downloading') }}
        </UiNotice>
        <UiNotice v-else-if="observation?.available === false" tone="warning" data-detection-unavailable>
          {{ t('settings.connection.clients.unavailable') }}
          <template #actions><Button size="sm" variant="outline" :loading="checking" :loading-label="t('settings.connection.clients.checking')"
            data-check-again @click="check">{{ t('settings.connection.clients.refresh') }}</Button></template>
        </UiNotice>
        <UiNotice v-if="runner" tone="info" data-runner-clients>
          {{ runner.hostName ? t('settings.connection.clients.runner.note', { host: runner.hostName }) : t('settings.connection.clients.runner.notPaired') }}
          <template v-if="runnerSkew && runner"> {{ t(`settings.connection.clients.runner.${runnerSkew.older === 'runner' ? 'runnerOlder' : 'hostOlder'}`,
            { host: runner.hostName ?? '', hostVersion: runner.hostVersion ?? '', runnerVersion: runner.version }) }}</template>
          <!-- This computer's copy is older: the update is handed to the person's own AI here, since a
               runner's page cannot run the host's update (the relay refuses it, docs/runner.md). -->
          <template v-if="runnerSkew?.older === 'runner' && runner?.hostVersion" #actions>
            <RunnerUpdateAi :host-version="runner.hostVersion" />
          </template>
        </UiNotice>
        <UiNotice v-if="installs && otherInstalls.length" tone="warning" data-two-installs>
          {{ t('settings.connection.clients.twoInstalls.notice', { count: otherInstalls.length + 1, version: installs.console.version ?? '—',
            clients: otherInstalls.flatMap(other => other.clients).join('、') }) }}
          <template #actions><Button size="sm" variant="outline" data-install-details-open @click="details = 'installs'">{{ t('settings.connection.clients.details') }}</Button></template>
        </UiNotice>
        <!-- One tile per client, as many per row as the width holds; a long list scrolls inside, the page does not grow. -->
        <ul v-if="observation && observation.available !== false" class="client-grid">
          <li v-for="client in clients" :key="client.id" :data-client-status="client.status" :data-custom-client="client.custom ? client.id : undefined"
            :class="`client-row client-row--${client.status}`">
            <span class="client-row__icon" aria-hidden="true"><UiIcon v-if="STATUS_ICONS[client.status]" :name="STATUS_ICONS[client.status]!" :size="client.status === 'connected' ? 14 : 12" /></span>
            <div class="client-row__body">
              <div class="client-row__head">
                <strong :title="client.label">{{ client.label }}</strong>
                <span class="client-row__label">{{ t(`settings.connection.clients.status.${client.inWsl && client.status === 'not_detected' ? 'inWsl' : client.status}`) }}</span>
                <Button v-if="client.custom?.removable" size="icon-sm" variant="ghost" class="client-row__action" :data-remove-custom-client="client.id"
                  :disabled="busy" :loading="removing === client.id" :loading-label="t('settings.connection.custom.removing', { client: client.label })"
                  :title="t('settings.connection.custom.remove', { client: client.label })"
                  :aria-label="t('settings.connection.custom.remove', { client: client.label })" @click="removeCustom(client)">
                  <UiIcon name="close" :size="14" />
                </Button>
              </div>
              <p>{{ explanation(client) }}</p>
              <!-- What FULI puts into this client, each part with its state (README: what each part gives you). -->
              <ul v-if="clientCapabilities(client).length" class="client-parts" :data-client-parts="client.id">
                <li v-for="{ capability, part, state } in clientCapabilities(client)" :key="capability" :data-part="part"
                  :data-part-state="state" :data-term="`setting.clientPart.${part}`"
                  :title="state === 'unsupported'
                    ? t('settings.connection.parts.unsupportedTitle', { lost: t(`settings.connection.parts.lost.${capability}`) })
                    : t('settings.connection.parts.title', { state: t(`settings.connection.parts.state.${state}`), meaning: t(`glossary.setting.clientPart.${part}`) })">
                  <UiIcon :name="state === 'current' ? 'check' : state === 'unsupported' ? 'close' : 'warning'" :size="11" />
                  {{ t(`settings.connection.parts.capability.${capability}`) }}<template v-if="state !== 'current' && state !== 'unsupported'"> · {{ t(`settings.connection.parts.state.${state}`) }}</template>
                </li>
              </ul>
              <p v-if="withoutLifecycle(client)" class="client-row__meta client-row__note" data-client-no-lifecycle>{{ t('settings.connection.parts.noLifecycle') }}</p>
              <ClientFirstRun v-if="client.firstRun" :client-id="client.firstRun.id" :command="client.firstRun.command" />
              <p v-if="revealFailed[client.id]" role="alert">{{ t('settings.connection.clients.revealFailed') }}</p>
              <Button v-if="client.status === 'unknown' && client.entryFile" size="sm" variant="outline" class="client-row__action"
                :data-reveal-client-file="client.id" @click="revealFile(client)">{{ t('settings.connection.clients.revealFile') }}</Button>
              <p v-for="path in client.custom?.mcpPaths" :key="path" class="client-row__meta" :title="path">{{ t('settings.connection.custom.where', { path }) }}</p>
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
          <!-- Always the last tile: a client that is not listed is added here, then connects and updates with the rest. -->
          <li class="client-add">
            <Button variant="ghost" class="client-add__button" data-add-custom-client :disabled="busy" @click="adding = true">
              <UiIcon name="plus" :size="32" />
              <strong>{{ t('settings.connection.custom.add') }}</strong>
              <span>{{ t('settings.connection.custom.addHint') }}</span>
            </Button>
          </li>
        </ul>
        <UiNotice v-if="removeError" tone="error" data-no-action="the error of the person's own click; the same button tries again">{{ t('settings.connection.custom.removeError') }}</UiNotice>
        <p v-if="observation && observation.available !== false" class="client-row__meta" role="status">
          {{ t('settings.connection.clients.observedAt', { time: formatTime(observation.observedAt) }) }}
          {{ t('settings.connection.clients.boundary') }}
          <template v-if="!observation.historySaved">{{ t('settings.connection.clients.historyUnsaved') }}</template>
        </p>
      </section>
    </div>
    <ClientRestartConfirm v-model:client="confirming" @confirm="restart" />
    <CustomClientDialog v-model:open="adding" :prefill="prefill" @added="connectOne" @update:open="(value: boolean) => { if (!value) prefill = null }" />
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
/* A client's parts: one quiet chip each, an outdated or missing one in the warning tone. */
.client-parts { display: flex; flex-wrap: wrap; gap: 4px; margin: 2px 0 0; padding: 0; list-style: none; }
.client-parts li {
  display: inline-flex; align-items: center; gap: 3px; padding: 1px 7px; border-radius: 999px;
  background: var(--color-accent-soft, var(--color-surface)); color: var(--color-muted); font-size: 11px; line-height: 18px; white-space: nowrap;
}
.client-parts li[data-part-state=outdated], .client-parts li[data-part-state=missing] { color: var(--color-warning); }
/* A capability this client does not take: an outlined, faint chip with ✗; its cost in the title. */
.client-parts li[data-part-state=unsupported] { background: none; box-shadow: inset 0 0 0 1px var(--color-border); color: var(--color-muted); opacity: .7; }
.client-row .client-row__note { white-space: normal; }
/* The add tile: as tall as its row's tiles, a dashed outline and one large plus. */
.client-add { display: grid; min-width: 0; min-height: 132px; }
.client-add__button {
  display: grid; place-content: center; justify-items: center; gap: 4px; min-width: 0; height: auto; padding: 14px; border: 1.5px dashed var(--color-border);
  border-radius: var(--radius-card); background: none; color: var(--color-muted); font-size: 12px; font-weight: 400; line-height: 1.5; text-align: center;
  white-space: normal; user-select: none;
}
/* The shared Button wraps its content in one span: the plus, the name and the hint stack inside it. */
.client-add__button :deep(.button-content) { display: grid; justify-items: center; gap: 4px; }
.client-add__button strong { color: var(--color-ink); font-size: var(--text-body); font-weight: var(--weight-medium); }
.client-add__button:hover:not(:disabled), .client-add__button:focus-visible { border-color: var(--color-ink); background: var(--color-surface); color: var(--color-ink); }
</style>
