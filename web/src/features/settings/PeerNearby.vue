<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { postJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { t } from '@/i18n'
import UiNotice from '@/ui/UiNotice.vue'
import { groupedCode, pairingOutcome, peerApiMessage, peerStatusShape, type Nearby, type PeerStatus } from './peer-model'

// 附近的 FULI (rec issue 127): be seen on this network for a while, pair from
// the list with a 6-digit code the person compares on both screens and
// confirms on each computer.
const props = defineProps<{ nearby: Nearby; coordinatorName: string | null }>()
const emit = defineEmits<{ status: [next: PeerStatus] }>()

const busy = ref('')
const error = ref('')
const name = ref(props.nearby.name ?? '')
// The person's own statement that both screens show the same digits; reset for every new code.
const sameDigits = ref(false)
watch(() => props.nearby.name, (next) => { if (next) name.value = next })
watch(() => props.nearby.pairing?.code ?? null, () => { sameDigits.value = false })

const pairing = computed(() => props.nearby.pairing)
const showsCode = computed(() => pairing.value && ['confirm', 'finishing'].includes(pairing.value.state) && pairing.value.code)
const asked = computed(() => pairing.value?.direction === 'incoming' && pairing.value.state === 'connecting')
const pairingOpen = computed(() => Boolean(pairing.value && ['connecting', 'confirm', 'finishing'].includes(pairing.value.state)))
const outcome = computed(() => (pairing.value ? pairingOutcome(pairing.value) : null))

async function run(kind: string, work: () => Promise<PeerStatus>) {
  if (busy.value) return
  busy.value = kind
  error.value = ''
  try { emit('status', await work()) }
  catch (caught) { error.value = peerApiMessage(caught, t('settings.peer.nearbyError')) }
  finally { busy.value = '' }
}

function toggle(on: boolean) {
  return run('toggle', () => postJson('/api/peer/nearby', on ? { on, name: name.value.trim() || undefined } : { on }, peerStatusShape))
}

function pair(fingerprint: string) {
  return run(`pair:${fingerprint}`, () => postJson('/api/peer/nearby/pair', { fingerprint }, peerStatusShape))
}

function confirm() {
  const current = pairing.value
  if (!current?.requestId || !current.code || !sameDigits.value) return
  return run('confirm', () => postJson('/api/peer/nearby/confirm', { requestId: current.requestId, code: current.code }, peerStatusShape))
}

function cancel() {
  return run('cancel', () => postJson('/api/peer/nearby/cancel', {}, peerStatusShape))
}

// The person's own reset of the attempt count on this computer: a second,
// deliberate step, since many attempts can mean someone is trying uninvited.
const clearAsked = ref(false)
async function clearAttempts() {
  await run('clear', () => postJson('/api/peer/nearby/attempts/clear', {}, peerStatusShape))
  clearAsked.value = false
}
</script>

<template>
  <section class="peer-nearby" data-peer-nearby>
    <h3 class="ui-group-label">{{ t('settings.peer.nearbyTitle') }}</h3>
    <p>{{ t('settings.peer.nearbyHint') }}</p>
    <div class="peer-nearby-switch">
      <label class="peer-nearby-name">
        <span>{{ t('settings.peer.nearbyName') }}</span>
        <Input v-model="name" size="sm" maxlength="60" :placeholder="nearby.suggestedName ?? 'FULI'"
          :disabled="Boolean(busy) || nearby.on" data-nearby-name />
      </label>
      <label class="peer-nearby-toggle">
        <Switch :model-value="nearby.on" :disabled="Boolean(busy)" :aria-label="t('settings.peer.nearbySwitch')"
          data-nearby-switch @update:model-value="toggle" />
        <span>{{ t('settings.peer.nearbySwitch') }}</span>
      </label>
    </div>
    <GrowthLoading v-if="busy === 'toggle'" variant="inline"
      :label="t(nearby.on ? 'settings.peer.nearbyStopping' : 'settings.peer.nearbyStarting')" />
    <UiNotice v-if="error" tone="error">{{ error }}</UiNotice>
    <UiNotice v-if="!nearby.on && nearby.ended" :tone="nearby.ended.kind === 'paired' ? 'success' : nearby.ended.kind === 'waiting' ? 'info' : 'warning'"
      data-nearby-ended>
      {{ t(`settings.peer.nearbyEnded.${nearby.ended.kind}`, { name: nearby.ended.name ?? '', reason: nearby.ended.reason ?? '' }) }}
    </UiNotice>

    <template v-if="nearby.on">
      <p>{{ t('settings.peer.nearbyAutoOff') }}</p>
      <p v-if="!nearby.canPair && coordinatorName && !nearby.limited">{{ t('settings.peer.pairThroughCoordinator', { name: coordinatorName }) }}</p>
      <UiNotice v-if="nearby.limited" tone="warning" data-nearby-limited>
        {{ t('settings.peer.nearbyLimited', { window: nearby.attempts?.lastWindow ?? 0, day: nearby.attempts?.lastDay ?? 0 }) }}
        <template v-if="!clearAsked" #actions>
          <Button size="sm" variant="ghost" data-nearby-clear-ask @click="clearAsked = true">{{ t('settings.peer.clearAsk') }}</Button>
        </template>
      </UiNotice>
      <div v-if="nearby.limited && clearAsked" class="peer-clear" data-nearby-clear-confirm>
        <p>{{ t('settings.peer.clearConfirm') }}</p>
        <div class="peer-actions">
          <Button size="sm" variant="outline" data-nearby-clear :loading="busy === 'clear'"
            :loading-label="t('settings.peer.clearingAttempts')" @click="clearAttempts">
            {{ t('settings.peer.clearAttempts') }}
          </Button>
          <Button size="sm" variant="ghost" data-nearby-clear-keep @click="clearAsked = false">{{ t('settings.peer.clearKeep') }}</Button>
        </div>
      </div>
      <ul v-if="nearby.devices.length" class="peer-devices" data-nearby-devices>
        <li v-for="device in nearby.devices" :key="device.fingerprint">
          <div>
            <strong>{{ device.name }}</strong>
            <small>{{ device.shortFingerprint }}</small>
          </div>
          <span v-if="device.paired" class="peer-paired">{{ t('settings.peer.paired') }}</span>
          <Button v-else size="sm" variant="outline" :data-nearby-pair="device.fingerprint"
            :disabled="!nearby.canPair || pairingOpen"
            :loading="busy === `pair:${device.fingerprint}`" :loading-label="t('settings.peer.connecting', { name: device.name })"
            @click="pair(device.fingerprint)">
            {{ t('settings.peer.pair') }}
          </Button>
        </li>
      </ul>
      <GrowthLoading v-else variant="inline" :label="t('settings.peer.nearbySearching')" />

      <div v-if="asked && pairing" class="peer-code" data-pairing-asked>
        <strong>{{ t('settings.peer.asked', { name: pairing.device.name }) }}</strong>
        <small>{{ pairing.device.shortFingerprint }}</small>
        <Button size="sm" variant="outline" data-pairing-cancel
          :loading="busy === 'cancel'" :loading-label="t('settings.peer.cancelling')" @click="cancel">
          {{ t('settings.peer.refuse') }}
        </Button>
      </div>
      <div v-else-if="showsCode && pairing" class="peer-code" data-pairing-code role="group" :aria-label="t('settings.peer.codeTitle', { name: pairing.device.name })">
        <strong>{{ t('settings.peer.codeTitle', { name: pairing.device.name }) }}</strong>
        <code>{{ groupedCode(pairing.code ?? '') }}</code>
        <p>{{ t('settings.peer.codeHint') }}</p>
        <p>{{ pairing.coordinator === 'this' ? t('settings.peer.coordinatorThis') : t('settings.peer.coordinatorOther', { name: pairing.device.name }) }}</p>
        <label class="peer-same-digits">
          <Checkbox v-model="sameDigits" :disabled="pairing.confirmedHere || Boolean(busy)" data-pairing-same />
          <span>{{ t('settings.peer.sameDigits') }}</span>
        </label>
        <div class="peer-actions">
          <Button size="sm" data-pairing-confirm :disabled="!sameDigits || pairing.confirmedHere || pairing.state !== 'confirm'"
            :loading="busy === 'confirm'" :loading-label="t('settings.peer.confirming')" @click="confirm">
            {{ t('settings.peer.confirm') }}
          </Button>
          <Button size="sm" variant="outline" data-pairing-cancel
            :loading="busy === 'cancel'" :loading-label="t('settings.peer.cancelling')" @click="cancel">
            {{ t('settings.peer.cancelPair') }}
          </Button>
        </div>
        <GrowthLoading v-if="pairing.confirmedHere" variant="inline" :label="t('settings.peer.waitingThere', { name: pairing.device.name })" />
      </div>
      <GrowthLoading v-else-if="pairing?.state === 'connecting'" variant="inline"
        :label="t('settings.peer.connecting', { name: pairing.device.name })" />
      <UiNotice v-else-if="pairing && outcome" :tone="outcome === 'paired' ? 'success' : outcome === 'waiting' ? 'info' : 'warning'" data-pairing-outcome>
        {{ t(`settings.peer.pairEnded.${outcome}`, { name: pairing.device.name, reason: pairing.reason ?? '' }) }}
      </UiNotice>
    </template>
  </section>
</template>

<style scoped>
.peer-nearby { display: grid; gap: 12px; margin: 16px 0; min-width: 0; }
.peer-nearby p, .peer-nearby small { margin: 0; color: var(--color-muted); font-size: 13px; line-height: 1.6; }
.peer-nearby-switch { display: flex; flex-wrap: wrap; align-items: end; gap: 12px 16px; }
.peer-nearby-name { display: grid; gap: 6px; flex: 1 1 200px; min-width: 0; color: var(--color-muted); font-size: 12px; }
.peer-devices { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.peer-devices li {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px;
  min-width: 0; padding: 12px 0; border-top: 1px solid var(--color-border);
}
.peer-devices strong, .peer-devices small { display: block; overflow-wrap: anywhere; }
.peer-devices strong { color: var(--color-ink); font-size: 14px; }
.peer-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.peer-nearby-toggle, .peer-same-digits { display: flex; align-items: center; gap: 8px; min-height: 30px; user-select: none; cursor: pointer; }
.peer-nearby-toggle span, .peer-same-digits span { color: var(--color-ink); font-size: 13px; }
.peer-paired { color: var(--color-muted); font-size: 13px; user-select: none; }
.peer-code, .peer-clear { display: grid; gap: 8px; justify-items: start; }
.peer-code strong { color: var(--color-ink); font-size: 14px; }
.peer-code code { font: 600 28px/1.2 var(--font-mono); letter-spacing: 0.12em; color: var(--color-ink); }
</style>
