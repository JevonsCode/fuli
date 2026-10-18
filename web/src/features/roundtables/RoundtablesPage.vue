<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { currentLocale, t } from '@/i18n'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import { listChats, listThreads, readChat, readThread, type RoundtableChatPage, type RoundtableChatRoom, type RoundtableMessage, type RoundtablePerson, type RoundtableThread, type RoundtableThreadSummary } from './roundtable-api'
import { chatRoomName, splitThread, tableSeats } from './roundtable-model'
import RoundtableRoom from './RoundtableRoom.vue'
import RoundtableSeats from './RoundtableSeats.vue'

// A read-only record of Agents talking to each other: chat rooms (agent_chat,
// 1:1 or groups) and asks between Agents (message_agent). People only watch.
const route = useRoute()
const threads = ref<RoundtableThreadSummary[]>([])
const thread = ref<RoundtableThread | null>(null)
const chats = ref<RoundtableChatRoom[]>([])
const chatsUnavailable = ref(false)
const room = ref<RoundtableChatPage | null>(null)
const loading = ref(true)
const error = ref('')
const selectedId = computed(() => typeof route.params.threadId === 'string' ? route.params.threadId : '')
const selectedChatId = computed(() => typeof route.params.chatId === 'string' ? route.params.chatId : '')
const CLIENTS: Record<string, string> = { claude_code: 'Claude Code', codex: 'Codex', cursor: 'Cursor', claude: 'Claude', other: 'Agent' }
let timer: ReturnType<typeof setInterval> | undefined
let version = 0

async function refresh() {
  const current = ++version
  try {
    // Rooms are optional: an older server without agent_chat still shows its threads.
    const [list, detail, rooms, open] = await Promise.all([
      listThreads(),
      selectedId.value ? readThread(selectedId.value) : Promise.resolve(null),
      listChats().catch(() => null),
      selectedChatId.value ? readChat(selectedChatId.value) : Promise.resolve(null),
    ])
    if (current !== version) return
    threads.value = list.threads
    thread.value = detail
    chats.value = rooms?.chats ?? []
    chatsUnavailable.value = Boolean(rooms?.remoteUnavailable)
    room.value = open
    error.value = ''
  } catch (cause) {
    if (current === version) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (current === version) loading.value = false
  }
}

watch([selectedId, selectedChatId], () => { thread.value = null; room.value = null; void refresh() })
onMounted(() => {
  void refresh()
  timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 5000)
})
onBeforeUnmount(() => clearInterval(timer))

const split = computed(() => splitThread(thread.value?.messages ?? []))
const seats = computed(() => tableSeats(thread.value?.messages ?? [], split.value.pending))
const REASONS = new Set(['not_waiting', 'nested_limit', 'task_context_required', 'no_client', 'wake_failed', 'peer_send_failed'])
// A stored failure code, in words when known; unknown codes stay visible as recorded.
const reason = (message: RoundtableMessage) => message.error
  ? REASONS.has(message.error) ? t(`roundtable.reasons.${message.error}`) : message.error
  : ''
const waitingLabel = (item: RoundtableThreadSummary) => item.waitingFor?.length
  ? t('roundtable.waitingFor', { names: item.waitingFor.join('、') })
  : t('roundtable.waiting')
const client = (person: RoundtablePerson) => person.client ? CLIENTS[person.client] ?? person.client : ''
const initial = (person: RoundtablePerson) => (person.name ?? '?').trim().slice(0, 1).toUpperCase()
function time(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '' : new Intl.DateTimeFormat(currentLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}
function delivery(message: RoundtableMessage) {
  if (message.kind === 'reply') {
    const mode = message.via?.split(':')[1]
    return mode && ['resume', 'new', 'inbox'].includes(mode) ? t(`roundtable.via.${mode}`) : ''
  }
  if (message.via === 'peer' && message.status === 'sent') return t('roundtable.status.remoteQueued')
  return message.status === 'answered' ? '' : t(`roundtable.status.${message.status}`)
}
</script>

<template>
  <section class="view roundtable-view">
    <GrowthLoading v-if="loading" :label="t('roundtable.loading')" />
    <div v-else-if="error && !threads.length" class="ui-empty" role="alert">
      <p>{{ t('roundtable.loadFailed') }} · {{ error }}</p>
      <button class="ui-button" type="button" @click="refresh">{{ t('roundtable.retry') }}</button>
    </div>
    <div v-else-if="!threads.length && !chats.length" class="roundtable-empty">
      <strong>{{ t('roundtable.empty') }}</strong>
      <p>{{ t('roundtable.emptyHint') }}</p>
    </div>
    <div v-else class="ui-split roundtable-layout">
      <nav class="ui-split-list" :aria-label="t('roundtable.threads')">
        <div class="ui-split-head"><span role="status">{{ t('roundtable.count', { count: threads.length + chats.length }) }}</span></div>
        <p v-if="chatsUnavailable" class="ui-meta roundtable-remote-note">{{ t('roundtable.chat.remoteUnavailable') }}</p>
        <div class="ui-split-items">
          <RouterLink v-for="item in chats" :key="item.chatId" class="ui-split-item" :class="{ 'is-selected': item.chatId === selectedChatId }"
            :aria-current="item.chatId === selectedChatId ? 'page' : undefined" :to="`/roundtables/chat/${encodeURIComponent(item.chatId)}`" data-testid="roundtable-chat-room">
            <span class="ui-split-item-meta">
              <span>{{ t(`roundtable.chat.kinds.${item.kind}`) }} · {{ item.members.length }}</span>
              <time :datetime="item.updatedAt">{{ time(item.updatedAt) }}</time>
            </span>
            <strong class="ui-split-item-title">{{ chatRoomName(item) }}</strong>
          </RouterLink>
          <RouterLink v-for="item in threads" :key="item.id" class="ui-split-item" :class="{ 'is-selected': item.id === selectedId }"
            :aria-current="item.id === selectedId ? 'page' : undefined" :to="`/roundtables/${encodeURIComponent(item.id)}`" data-testid="roundtable-thread">
            <span class="ui-split-item-meta">
              <span>{{ item.participants.map((person) => person.name).join(' · ') }}</span>
              <span v-if="item.waiting" class="roundtable-waiting" data-roundtable-waiting>{{ waitingLabel(item) }}</span>
              <time v-else :datetime="item.updatedAt">{{ time(item.updatedAt) }}</time>
            </span>
            <strong class="ui-split-item-title">{{ item.subject }}</strong>
            <span v-if="item.last" class="ui-split-item-sub">{{ item.last.from }}：{{ item.last.body }}</span>
          </RouterLink>
        </div>
      </nav>
      <article v-if="thread" class="ui-split-detail" data-testid="roundtable-timeline">
        <header class="ui-split-detail-head">
          <h2>{{ thread.subject }}</h2>
          <p class="ui-list-meta">{{ t('roundtable.messages', { count: thread.messages.length }) }} · {{ time(thread.createdAt) }}</p>
          <RoundtableSeats :seats="seats" />
        </header>
        <div class="ui-split-detail-body">
          <section class="roundtable-section" :aria-label="t('roundtable.exchanges')" data-roundtable-exchanges>
            <h3>{{ t('roundtable.exchanges') }}</h3>
            <ol v-if="split.exchanges.length">
              <template v-for="exchange in split.exchanges" :key="exchange.ask?.id ?? exchange.replies[0]!.id">
                <li v-for="message in [...(exchange.ask ? [exchange.ask] : []), ...exchange.replies]" :key="message.id" class="roundtable-message" :class="`is-${message.kind}`">
                  <span class="roundtable-avatar" :style="agentIdentityStyle(message.from.agentId)" aria-hidden="true">{{ initial(message.from) }}</span>
                  <div class="roundtable-bubble">
                    <p class="roundtable-byline">
                      <strong>{{ message.from.name }}</strong>
                      <span v-if="client(message.from)" class="ui-badge">{{ client(message.from) }}</span>
                      <span class="ui-meta">{{ t('roundtable.to') }} {{ message.to.name }}</span>
                      <time class="ui-meta" :datetime="message.createdAt">{{ time(message.createdAt) }}</time>
                    </p>
                    <p class="roundtable-body">{{ message.body }}</p>
                    <p v-if="delivery(message)" class="roundtable-delivery">{{ delivery(message) }}</p>
                  </div>
                </li>
              </template>
            </ol>
            <p v-else class="ui-meta">{{ t('roundtable.noExchanges') }}</p>
          </section>
          <section v-if="split.pending.length || split.unanswered.length" class="roundtable-section roundtable-pending" :aria-label="t('roundtable.pending')" data-roundtable-pending>
            <h3>{{ t('roundtable.pending') }}</h3>
            <ul>
              <li v-for="message in [...split.pending, ...split.unanswered]" :key="message.id" class="roundtable-request" :class="{ 'is-closed': split.unanswered.includes(message) }" data-roundtable-request>
                <p class="roundtable-byline">
                  <strong>{{ t('roundtable.waitingOn', { name: message.to.name ?? t('roundtable.unknownAgent') }) }}</strong>
                  <span class="ui-meta">{{ t('roundtable.askedBy', { name: message.from.name ?? t('roundtable.unknownAgent') }) }}</span>
                  <time class="ui-meta" :datetime="message.createdAt">{{ time(message.createdAt) }}</time>
                </p>
                <p class="roundtable-request-state">{{ delivery(message) }}<template v-if="reason(message)"> · {{ reason(message) }}</template></p>
                <p class="roundtable-body">{{ message.body }}</p>
              </li>
            </ul>
          </section>
        </div>
      </article>
      <RoundtableRoom v-else-if="room" :room="room" :time="time" />
      <p v-else class="ui-split-placeholder">{{ t('roundtable.select') }}</p>
    </div>
  </section>
</template>

<style scoped>
.roundtable-view { display: flex; flex-direction: column; }
.roundtable-empty { max-width: 520px; margin: 12vh auto 0; text-align: center; }
.roundtable-empty strong { font-size: 16px; font-weight: 600; }
.roundtable-empty p { margin-top: 8px; color: var(--color-muted); }
.roundtable-section + .roundtable-section { margin-top: 24px; }
.roundtable-waiting { color: var(--color-warning); font-weight: 600; }
.roundtable-remote-note { margin: 8px 16px 0; }
.roundtable-section h3 { margin: 0 0 12px; color: var(--color-muted); font-size: 13px; font-weight: 600; }
.roundtable-section ol, .roundtable-section ul { margin: 0; padding: 0; list-style: none; display: grid; align-content: start; gap: 18px; }
.roundtable-request { display: grid; gap: 6px; max-width: 760px; padding: 12px 14px; border: 1px dashed var(--color-border-strong, var(--color-border)); border-radius: 12px; }
.roundtable-request.is-closed { opacity: 0.8; }
.roundtable-request-state { color: var(--color-warning); font-size: 12px; }
.roundtable-request.is-closed .roundtable-request-state { color: var(--color-danger); }
.roundtable-message { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 12px; max-width: 760px; }
.roundtable-message.is-reply { margin-left: 42px; }
.roundtable-avatar { display: grid; width: 30px; height: 30px; place-items: center; border-radius: 50%; color: var(--agent-identity, var(--color-accent)); background: var(--agent-identity-soft, var(--color-accent-soft)); font-size: 12px; font-weight: 650; }
.roundtable-bubble { min-width: 0; }
.roundtable-byline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 6px; }
.roundtable-byline > * { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
.roundtable-byline strong { font-size: 14px; font-weight: 600; }
.roundtable-body { padding: 12px 14px; border: 1px solid var(--color-border); border-radius: 4px 12px 12px 12px; background: var(--color-bg); color: var(--color-ink); font-size: 14px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.roundtable-message.is-reply .roundtable-body { background: var(--color-surface); }
.roundtable-delivery { margin-top: 6px; color: var(--color-faint); font-size: 12px; }
@media (max-width: 860px) {
  .roundtable-message.is-reply { margin-left: 16px; }
}
@media (max-width: 480px) {
  .roundtable-message { gap: 8px; }
  .roundtable-message.is-reply { margin-left: 8px; }
}
</style>
