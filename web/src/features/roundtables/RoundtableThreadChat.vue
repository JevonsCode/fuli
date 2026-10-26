<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import { t } from '@/i18n'
import { postMessage, setThreadMode, type RoundtableDelivery, type RoundtablePerson, type RoundtableThread } from './roundtable-api'
import { deliveryLabel, reasonLabel, viaLabel } from './roundtable-delivery'
import { chatBubbles, postRecipients, tableSeats, type ChatBubble } from './roundtable-model'
import { gapToEnd, scrollToEnd, TAIL_FOLLOW_PX } from './roundtable-scroll'
import RoundtableComposer from './RoundtableComposer.vue'
import RoundtableSeats from './RoundtableSeats.vue'

// One thread as a chat: the person's own messages on the right, each FLA's on
// the left with its face, name and time, and under each message where it
// stands for every recipient. The composer stays at the bottom.
const props = defineProps<{ thread: RoundtableThread; time: (value: string) => string; stale?: boolean; wide?: boolean }>()
const emit = defineEmits<{ updated: [RoundtableThread] }>()
const CLIENTS: Record<string, string> = { claude_code: 'Claude Code', codex: 'Codex', cursor: 'Cursor', claude: 'Claude', opencode: 'OpenCode' }

const bubbles = computed(() => chatBubbles(props.thread))
const seats = computed(() => tableSeats(props.thread.messages))
const recipients = computed(() => postRecipients(props.thread))
const subscribed = computed(() => Boolean(props.thread.subscribers?.length))
const blocked = computed(() => mode.value === 'instant'
  ? (props.thread.subscribers ?? []).filter(item => item.instantBlocked) : [])

const name = (person: RoundtablePerson) => person.name ?? t('roundtable.unknownAgent')
const sender = (bubble: ChatBubble) => bubble.mine ? t('roundtable.you') : name(bubble.from)
const initial = (bubble: ChatBubble) => sender(bubble).trim().slice(0, 1).toUpperCase()
const client = (person: RoundtablePerson) => person.client ? CLIENTS[person.client] ?? '' : ''
const cleanupWarning = (bubble: ChatBubble) => bubble.cleanup && bubble.cleanup.status !== 'confirmed'
  ? t('roundtable.cleanupUnconfirmed', { code: bubble.cleanup.code ?? bubble.cleanup.status }) : ''

// A new thread or a switch elsewhere starts from what the thread records.
const mode = ref<RoundtableDelivery>(props.thread.mode ?? 'board')
watch(() => [props.thread.id, props.thread.mode] as const, ([, recorded]) => { if (recorded) mode.value = recorded })
const switching = ref(false)
const sending = ref(false)
const error = ref<string | null>(null)
const composer = ref<InstanceType<typeof RoundtableComposer> | null>(null)

async function changeMode(next: RoundtableDelivery) {
  error.value = null
  if (!subscribed.value) { mode.value = next; return }
  const previous = mode.value
  mode.value = next
  switching.value = true
  try { emit('updated', await setThreadMode(props.thread.id, next)) }
  catch (cause) { mode.value = previous; error.value = t('roundtable.composer.modeFailed', { reason: apiErrorReason(cause) }) }
  finally { switching.value = false }
}

async function send(body: string) {
  sending.value = true
  error.value = null
  try {
    const updated = await postMessage(props.thread.id, { body, mode: mode.value,
      ...(subscribed.value ? {} : { to: recipients.value.map(item => item.agentId) }) })
    composer.value?.clear()
    emit('updated', updated)
  } catch (cause) {
    error.value = t('roundtable.composer.failed', { reason: apiErrorReason(cause) })
  } finally { sending.value = false }
}

// A reader at the end follows new messages; one scrolled up stays where they are.
const body = ref<HTMLElement | null>(null)
watch(() => props.thread.messages.length, async (length, previous) => {
  const following = !previous || gapToEnd(body.value) <= TAIL_FOLLOW_PX
  await nextTick()
  if (following && length) scrollToEnd(body.value)
}, { immediate: true })
</script>

<template>
  <article class="ui-conversation-detail roundtable-thread-chat" data-testid="roundtable-timeline">
    <header class="ui-conversation-detail-head">
      <h2 tabindex="-1" class="roundtable-subject" data-roundtable-detail-title>{{ thread.subject }}</h2>
      <p class="ui-list-meta">{{ t('roundtable.messages', { count: thread.messages.length }) }} · {{ time(thread.createdAt) }}</p>
      <p v-if="stale" class="ui-meta" role="status">{{ t('roundtable.stale') }}</p>
      <details class="roundtable-seats" :open="wide">
        <summary>{{ t('roundtable.participants', { count: seats.length }) }}</summary>
        <RoundtableSeats :seats="seats" />
      </details>
    </header>
    <div ref="body" class="ui-conversation-detail-body">
      <p v-if="!bubbles.length" class="ui-meta">{{ t('roundtable.emptyConversation') }}</p>
      <ol v-else class="roundtable-bubbles">
        <li v-for="bubble in bubbles" :key="bubble.id" class="roundtable-bubble-row" :class="{ 'is-mine': bubble.mine }"
          data-roundtable-bubble :data-mine="bubble.mine || undefined">
          <span v-if="!bubble.mine" class="roundtable-avatar" :style="agentIdentityStyle(bubble.from.agentId)" aria-hidden="true">{{ initial(bubble) }}</span>
          <div class="roundtable-bubble-column">
            <p class="roundtable-byline">
              <strong>{{ sender(bubble) }}</strong>
              <span v-if="client(bubble.from)" class="ui-badge">{{ client(bubble.from) }}</span>
              <time class="ui-meta" :datetime="bubble.createdAt">{{ time(bubble.createdAt) }}</time>
            </p>
            <p class="roundtable-bubble">{{ bubble.body }}</p>
            <p v-if="viaLabel(bubble.via) && bubble.kind === 'reply'" class="roundtable-delivery">{{ viaLabel(bubble.via) }}</p>
            <ul v-if="bubble.deliveries.length" class="roundtable-deliveries">
              <li v-for="delivery in bubble.deliveries" :key="delivery.messageId" :data-roundtable-delivery="delivery.state.kind"
                :class="`is-${delivery.state.kind}`">
                <GrowthLoading v-if="delivery.state.kind === 'replying'" variant="inline" :label="deliveryLabel(delivery, bubble.via)" />
                <template v-else>{{ deliveryLabel(delivery, bubble.via) }}</template>
              </li>
            </ul>
            <p v-if="cleanupWarning(bubble)" class="roundtable-cleanup" data-roundtable-cleanup>{{ cleanupWarning(bubble) }}</p>
          </div>
        </li>
      </ol>
    </div>
    <template v-if="recipients.length">
      <p v-for="item in blocked" :key="item.agentId" class="roundtable-blocked" role="status" data-roundtable-instant-blocked>
        {{ t('roundtable.instantBlocked', { name: item.name ?? item.agentId, reason: reasonLabel(item.instantBlocked) }) }}
      </p>
      <p v-if="!subscribed" class="roundtable-recipients ui-meta">{{ t('roundtable.composer.to', { names: recipients.map(item => item.name).join('、') }) }}</p>
      <RoundtableComposer ref="composer" :mode="mode" :sending="sending" :switching="switching" :error="error"
        @update:mode="changeMode" @send="send" />
    </template>
    <p v-else class="roundtable-recipients ui-meta" data-roundtable-no-recipients>{{ t('roundtable.composer.noRecipients') }}</p>
  </article>
</template>

<style scoped>
/* The chat fills the canvas, so the composer stays at its bottom. */
.roundtable-thread-chat { flex: 1 1 auto; }
.roundtable-subject { overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.roundtable-seats summary { cursor: pointer; color: var(--color-muted); font-size: 12px; }
.roundtable-bubbles { display: grid; gap: 16px; margin: 0; padding: 0; list-style: none; }
.roundtable-bubble-row { display: flex; align-items: flex-start; gap: 10px; max-width: min(760px, 88%); }
.roundtable-bubble-row.is-mine { justify-self: end; flex-direction: row-reverse; }
.roundtable-bubble-column { display: grid; min-width: 0; gap: 4px; }
.is-mine .roundtable-bubble-column { justify-items: end; }
.roundtable-avatar { display: grid; flex: 0 0 auto; width: 30px; height: 30px; place-items: center; border-radius: 50%; color: var(--agent-identity, var(--color-accent)); background: var(--agent-identity-soft, var(--color-accent-soft)); font-size: 12px; font-weight: 650; }
.roundtable-byline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0; }
.roundtable-byline > * { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
.roundtable-byline strong { font-size: 13px; font-weight: 600; }
.roundtable-bubble { margin: 0; padding: 10px 14px; border: 1px solid var(--color-border); border-radius: 4px 14px 14px 14px; background: var(--color-bg); color: var(--color-ink); font-size: 14px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.is-mine .roundtable-bubble { border-color: transparent; border-radius: 14px 4px 14px 14px; background: var(--color-accent-soft); }
.roundtable-deliveries { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; color: var(--color-faint); font-size: 12px; }
.is-mine .roundtable-deliveries { justify-items: end; text-align: right; }
.roundtable-deliveries .is-held { color: var(--color-warning); }
.roundtable-deliveries .is-failed { color: var(--color-danger); }
.roundtable-delivery { margin: 0; color: var(--color-faint); font-size: 12px; }
.roundtable-cleanup { margin: 0; color: var(--color-warning); font-size: 12px; font-weight: 600; }
.roundtable-blocked, .roundtable-recipients { margin: 0; padding: 8px 28px 0; font-size: 12px; }
.roundtable-blocked { color: var(--color-warning); }
.ui-conversation-detail-head h2:focus { outline: none; }
.ui-conversation-detail-head h2:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
@media (max-width: 480px) {
  .roundtable-bubble-row { max-width: 100%; }
  .roundtable-blocked, .roundtable-recipients { padding: 8px 16px 0; }
}
</style>
