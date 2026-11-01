<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { getJson, postJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { canConnect, type ClientObservation, type ConnectionStatus } from '@/features/settings/client-connection-model'
import { t } from '@/i18n'
import UiIcon from '@/ui/UiIcon.vue'
import UiNotice from '@/ui/UiNotice.vue'

import { connectionResultShape, connectionStatusShape, connectOutcome, detectedClients, preselectedClients } from './first-run-clients'

// The guide's first step: the AI clients on this computer, the ones not yet
// connected ticked, and 「一键接入」 connecting the ticked ones one after
// another through the same install as 设置 › 客户端.
const busy = defineModel<boolean>('busy', { default: false })

const observation = ref<ConnectionStatus | null>(null)
const reading = ref(true)
const readFailed = ref(false)
const ticked = ref<Record<string, boolean>>({})
const connecting = ref('')
const outcomes = ref<Record<string, 'connected' | 'restart' | 'failed'>>({})
let unmounted = false

const clients = computed(() => detectedClients(observation.value))
const chosen = computed(() => clients.value.filter(client => ticked.value[client.id] && canConnect(client)))
const connectingLabel = computed(() => clients.value.find(client => client.id === connecting.value)?.label ?? '')

async function read() {
  try {
    observation.value = await getJson('/api/system/client-connection/status', connectionStatusShape)
    readFailed.value = false
  } catch {
    readFailed.value = true
  }
}

async function connectChosen() {
  if (busy.value) return
  const queue = chosen.value
  busy.value = true
  outcomes.value = {}
  for (const client of queue) {
    if (unmounted) break
    connecting.value = client.id
    try {
      outcomes.value[client.id] = connectOutcome(await postJson('/api/system/client-connection/connect', { clientId: client.id }, connectionResultShape))
    } catch {
      outcomes.value[client.id] = 'failed'
    }
  }
  connecting.value = ''
  // A connected client is no longer ticked; one that failed stays ticked for another try.
  ticked.value = Object.fromEntries(Object.entries(ticked.value).filter(([id]) => outcomes.value[id] !== 'connected' && outcomes.value[id] !== 'restart'))
  if (!unmounted) await read()
  busy.value = false
}

function tick(client: ClientObservation, value: unknown) {
  ticked.value = { ...ticked.value, [client.id]: value === true }
}

function statusLabel(client: ClientObservation) {
  return t(`firstRun.clients.status.${client.status === 'connected' ? 'connected' : 'notConnected'}`)
}

onMounted(async () => {
  await read()
  ticked.value = preselectedClients(clients.value)
  reading.value = false
})
onBeforeUnmount(() => { unmounted = true })
</script>

<template>
  <section class="first-run-step" aria-labelledby="first-run-clients-title" data-first-run-clients>
    <div class="first-run-step__head">
      <h3 id="first-run-clients-title" class="ui-group-label">{{ t('firstRun.clients.title') }}</h3>
      <Button size="sm" data-first-run-connect :disabled="!chosen.length" :loading="busy"
        :loading-label="t('firstRun.clients.connecting', { client: connectingLabel })" @click="connectChosen">
        {{ t('firstRun.clients.connect') }}
      </Button>
    </div>
    <GrowthLoading v-if="reading" variant="compact" :label="t('firstRun.clients.reading')" />
    <UiNotice v-else-if="readFailed || observation?.available === false" tone="warning" data-first-run-clients-unreadable>
      {{ t('firstRun.clients.unreadable') }}
    </UiNotice>
    <p v-else-if="!clients.length" class="first-run-note">{{ t('firstRun.clients.none') }}</p>
    <ul v-else class="first-run-clients">
      <li v-for="client in clients" :key="client.id" :data-first-run-client="client.id" :data-client-status="client.status">
        <label class="first-run-client">
          <Checkbox v-if="canConnect(client) && client.status !== 'connected'" :model-value="ticked[client.id] === true"
            :disabled="busy" :aria-label="client.label" @update:model-value="value => tick(client, value)" />
          <span v-else class="first-run-client__done" aria-hidden="true">
            <UiIcon v-if="client.status === 'connected'" name="check" :size="14" />
          </span>
          <span class="first-run-client__mark" aria-hidden="true">{{ client.label.slice(0, 1) }}</span>
          <span class="first-run-client__name">{{ client.label }}</span>
          <GrowthLoading v-if="connecting === client.id" variant="inline" :label="t('firstRun.clients.connecting', { client: client.label })" />
          <span v-else class="first-run-client__status">{{ statusLabel(client) }}</span>
        </label>
        <p v-if="outcomes[client.id]" class="first-run-client__outcome" :data-first-run-outcome="outcomes[client.id]"
          :role="outcomes[client.id] === 'failed' ? 'alert' : 'status'">
          {{ t(`firstRun.clients.outcome.${outcomes[client.id]}`, { client: client.label }) }}
        </p>
        <p v-else-if="client.manualOnly && client.status !== 'connected'" class="first-run-client__outcome">{{ t('firstRun.clients.manual') }}</p>
      </li>
    </ul>
    <p class="first-run-note">{{ t('firstRun.clients.later') }}</p>
  </section>
</template>

<style scoped>
.first-run-clients { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.first-run-client { display: flex; align-items: center; gap: 10px; min-height: 36px; cursor: pointer; user-select: none; }
.first-run-client__done { display: inline-grid; width: 16px; place-items: center; color: var(--color-success); }
.first-run-client__mark { display: inline-grid; flex: none; width: 24px; height: 24px; place-items: center; border-radius: 6px;
  background: var(--color-surface-hover); color: var(--color-ink-soft); font-size: 12px; font-weight: var(--weight-strong); }
.first-run-client__name { min-width: 0; overflow: hidden; color: var(--color-ink); font-size: var(--text-body); font-weight: var(--weight-medium);
  text-overflow: ellipsis; white-space: nowrap; }
.first-run-client__status { margin-left: auto; flex: none; color: var(--color-muted); font-size: var(--text-meta); }
.first-run-client > :deep(.growth-loading) { margin-left: auto; }
[data-client-status="connected"] .first-run-client__status { color: var(--color-success); }
.first-run-client__outcome { margin: 0 0 6px 60px; color: var(--color-muted); font-size: var(--text-meta); }
[data-first-run-outcome="failed"] { color: var(--color-danger); }
</style>
