<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { agentAvatarUrl } from '@/features/agent-profile/agent-avatar'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import { t } from '@/i18n'
import { postMessage, setThreadMode, type RoundtableDelivery, type RoundtablePerson, type RoundtableThread } from './roundtable-api'
import { deliveryLabel, deliveryTone, reasonLabel, viaLabel } from './roundtable-delivery'
import { chatRunMarks } from './chat-runs'
import { chatBubbles, postRecipients, tableSeats, type ChatBubble } from './roundtable-model'
import { gapToEnd, scrollToEnd, TAIL_FOLLOW_PX } from './roundtable-scroll'
import RoundtableComposer from './RoundtableComposer.vue'
import RoundtableSeats from './RoundtableSeats.vue'

// One thread as a chat, like Messages: the person's own messages in ink on
// the right, each FLA's on the left under its name and portrait once per run,
// a time between messages far apart, and under each message where it stands
// for every recipient. The composer stays at the bottom.
const props = defineProps<{ thread: RoundtableThread; time: (value: string) => string; stale?: boolean }>()
const emit = defineEmits<{ updated: [RoundtableThread] }>()
const CLIENTS: Record<string, string> = { claude_code: 'Claude Code', codex: 'Codex', cursor: 'Cursor', claude: 'Claude', opencode: 'OpenCode' }

const bubbles = computed(() => chatBubbles(props.thread))
const seats = computed(() => tableSeats(props.thread.messages))
const recipients = computed(() => postRecipients(props.thread))
const marks = computed(() => chatRunMarks(bubbles.value.map(bubble => ({ from: bubble.mine ? 'me' : bubble.from.agentId ?? bubble.from.name ?? '?', at: bubble.createdAt }))))
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
  <article class="rt-chat roundtable-thread-chat" data-testid="roundtable-timeline">
    <header class="rt-chat-head">
      <span class="rt-chat-faces" aria-hidden="true">
        <span v-for="seat in seats.slice(0, 4)" :key="seat.key" :style="agentIdentityStyle(seat.person.agentId)"><img
          v-if="seat.person.agentId" :src="agentAvatarUrl(seat.person.agentId)" alt="" /><template v-else>{{ (seat.person.name ?? '?').slice(0, 1) }}</template></span>
      </span>
      <h2 tabindex="-1" class="rt-chat-title" data-roundtable-detail-title>{{ thread.subject }}</h2>
      <p class="rt-chat-meta">{{ t('roundtable.messages', { count: thread.messages.length }) }} · {{ time(thread.createdAt) }}</p>
      <p v-if="stale" class="rt-chat-meta" role="status">{{ t('roundtable.stale') }}</p>
      <details class="rt-chat-people">
        <summary>{{ t('roundtable.participants', { count: seats.length }) }}</summary>
        <RoundtableSeats :seats="seats" />
      </details>
    </header>
    <div ref="body" class="rt-chat-body">
      <p v-if="!bubbles.length" class="rt-chat-empty">{{ t('roundtable.emptyConversation') }}</p>
      <ol v-else class="rt-bubbles">
        <li v-for="(bubble, index) in bubbles" :key="bubble.id" class="rt-msg" :class="{ 'is-mine': bubble.mine, 'is-run-start': marks[index]!.runStart }"
          data-roundtable-bubble :data-mine="bubble.mine || undefined">
          <p v-if="marks[index]!.separator" class="rt-sep"><time :datetime="bubble.createdAt">{{ time(bubble.createdAt) }}</time></p>
          <div class="rt-msg-row">
            <template v-if="!bubble.mine">
              <span v-if="marks[index]!.runStart" class="rt-face roundtable-avatar" :style="agentIdentityStyle(bubble.from.agentId)" aria-hidden="true"><img
                v-if="bubble.from.agentId" :src="agentAvatarUrl(bubble.from.agentId)" alt="" /><template v-else>{{ initial(bubble) }}</template></span>
              <span v-else class="rt-face-gap" aria-hidden="true" />
            </template>
            <div class="rt-msg-col">
              <p v-if="marks[index]!.runStart && !bubble.mine" class="rt-byline">
                <strong>{{ sender(bubble) }}</strong>
                <span v-if="client(bubble.from)" class="rt-client">{{ client(bubble.from) }}</span>
              </p>
              <p v-else class="ui-sr-only">{{ sender(bubble) }}</p>
              <p class="rt-bubble" :title="time(bubble.createdAt)">{{ bubble.body }}</p>
              <p v-if="viaLabel(bubble.via) && bubble.kind === 'reply'" class="rt-status">{{ viaLabel(bubble.via) }}</p>
              <ul v-if="bubble.deliveries.length" class="rt-statuses rt-status">
                <li v-for="delivery in bubble.deliveries" :key="delivery.messageId" :data-roundtable-delivery="delivery.state.kind"
                  :data-tone="deliveryTone(delivery)">
                  <GrowthLoading v-if="delivery.state.kind === 'replying'" variant="inline" :label="deliveryLabel(delivery, bubble.via)" />
                  <template v-else>{{ deliveryLabel(delivery, bubble.via) }}</template>
                </li>
              </ul>
              <p v-if="cleanupWarning(bubble)" class="rt-status" data-tone="warning" data-roundtable-cleanup>{{ cleanupWarning(bubble) }}</p>
            </div>
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

<style scoped src="./roundtable-chat.css"></style>
<style scoped>
/* Who a message goes to, and an instant chat that cannot reach someone, sit just above the composer. */
.roundtable-blocked, .roundtable-recipients { margin: 0; padding: 8px 28px 0; color: var(--color-muted); font-size: var(--text-meta); }
.roundtable-blocked { color: var(--color-warning); }
@media (max-width: 480px) { .roundtable-blocked, .roundtable-recipients { padding: 8px 16px 0; } }
</style>
