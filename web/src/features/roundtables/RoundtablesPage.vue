<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

import { ApiError } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { currentLocale, t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import UiButton from '@/ui/UiButton.vue'
import UiIconButton from '@/ui/UiIconButton.vue'
import { subscribeChatUpdates } from '@/features/project-agents/task-updates'
import { agentIdentityStyle } from '@/features/agent-profile/agent-identity-color'
import {
  appendChatPage, listChats, listThreads, readChat, readThread,
  type RoundtableChatPage, type RoundtableChatRoom, type RoundtableMessage, type RoundtablePerson, type RoundtableThread, type RoundtableThreadSummary,
} from './roundtable-api'
import { chatRoomName, splitThread, tableSeats } from './roundtable-model'
import RoundtableRoom from './RoundtableRoom.vue'
import RoundtableSeats from './RoundtableSeats.vue'

// A read-only record of Agents talking to each other: chat rooms (agent_chat,
// 1:1 or groups) and asks between Agents (message_agent). People only watch.
// Each source and the open detail load and fail on their own, so one failure
// never hides another source or claims the list is empty. On a phone the list
// and the detail take turns; going back restores the list position and focus.
const route = useRoute()
const router = useRouter()
const consoleStore = useConsoleStore()
const selectedId = computed(() => typeof route.params.threadId === 'string' ? route.params.threadId : '')
const selectedChatId = computed(() => typeof route.params.chatId === 'string' ? route.params.chatId : '')
const hasSelection = computed(() => Boolean(selectedId.value || selectedChatId.value))
const CLIENTS: Record<string, string> = { claude_code: 'Claude Code', codex: 'Codex', cursor: 'Cursor', claude: 'Claude', other: 'Agent' }
let stopped = false

// Asks: the latest 50 only, refreshed every 5 seconds while visible.
const threads = ref<RoundtableThreadSummary[]>([])
const threadsState = ref<'loading' | 'ready' | 'failed'>('loading')
const threadsStale = ref(false)
async function loadThreads() {
  try {
    const list = await listThreads()
    if (stopped) return
    threads.value = list.threads
    threadsState.value = 'ready'
    threadsStale.value = false
  } catch {
    if (stopped) return
    if (threadsState.value === 'ready') threadsStale.value = true
    else threadsState.value = 'failed'
  }
}

// Chat rooms: local and remote pages each follow their own cursor.
const chats = ref<RoundtableChatRoom[]>([])
const chatsState = ref<'loading' | 'ready' | 'failed'>('loading')
const chatsUnavailable = ref(false)
const localNext = ref<string | null>(null)
const remoteNext = ref<string | null>(null)
const loadingMoreChats = ref(false)
let chatListGeneration = 0
// A refreshed first page keeps later pages already loaded below it.
function mergeRooms(rooms: RoundtableChatRoom[], firstPage: boolean) {
  const fresh = new Map(rooms.map(item => [item.chatId, item]))
  const kept = chats.value.filter(item => !fresh.has(item.chatId))
  chats.value = firstPage ? [...rooms, ...kept] : [...chats.value.map(item => fresh.get(item.chatId) ?? item),
    ...rooms.filter(item => !chats.value.some(existing => existing.chatId === item.chatId))]
}
async function loadChats() {
  const generation = ++chatListGeneration
  try {
    const page = await listChats()
    if (stopped || generation !== chatListGeneration) return
    const firstLoad = chatsState.value !== 'ready'
    mergeRooms(page.chats, true)
    if (firstLoad) {
      localNext.value = page.hasMore ? page.nextChat ?? null : null
      remoteNext.value = page.remotePage?.hasMore ? page.remotePage.nextChat : null
    }
    chatsUnavailable.value = Boolean(page.remoteUnavailable)
    chatsState.value = 'ready'
  } catch {
    if (!stopped && generation === chatListGeneration && chatsState.value === 'loading') chatsState.value = 'failed'
  }
}
async function loadMoreChats() {
  if (loadingMoreChats.value) return
  loadingMoreChats.value = true
  try {
    for (const transport of ['local', 'peer'] as const) {
      const cursor = transport === 'local' ? localNext.value : remoteNext.value
      if (!cursor) continue
      try {
        const page = await listChats({ transport, afterChat: cursor })
        if (stopped) return
        mergeRooms(page.chats, false)
        // A cursor that does not move would loop; stop rather than refetch it.
        const next = page.hasMore && page.nextChat && page.nextChat !== cursor ? page.nextChat : null
        if (transport === 'local') localNext.value = next
        else remoteNext.value = next
      } catch {
        if (transport === 'peer') chatsUnavailable.value = true
      }
    }
  } finally {
    loadingMoreChats.value = false
  }
}

// The open detail. A newer route always wins over a late response.
const thread = ref<RoundtableThread | null>(null)
const room = ref<RoundtableChatPage | null>(null)
const detailState = ref<'idle' | 'loading' | 'ready' | 'missing' | 'failed'>('idle')
const detailStale = ref(false)
const loadingLater = ref(false)
const laterFailed = ref(false)
const newMessages = ref(false)
let detailGeneration = 0
const inaccessible = (cause: unknown) => cause instanceof ApiError && [400, 401, 403, 404, 422].includes(cause.status)
async function loadDetail() {
  const generation = ++detailGeneration
  thread.value = null
  room.value = null
  detailStale.value = false
  laterFailed.value = false
  newMessages.value = false
  if (!hasSelection.value) { detailState.value = 'idle'; return }
  detailState.value = 'loading'
  try {
    if (selectedId.value) {
      const value = await readThread(selectedId.value)
      if (generation === detailGeneration) thread.value = value
    } else {
      const value = await readChat(selectedChatId.value)
      if (generation === detailGeneration) room.value = value
    }
    if (generation === detailGeneration) { detailState.value = 'ready'; void focusDetailTitle() }
  } catch (cause) {
    if (generation === detailGeneration) detailState.value = inaccessible(cause) ? 'missing' : 'failed'
  }
}
async function refreshThreadDetail() {
  const id = selectedId.value
  if (!id || detailState.value !== 'ready') return
  const generation = detailGeneration
  try {
    const value = await readThread(id)
    if (generation === detailGeneration) { thread.value = value; detailStale.value = false }
  } catch (cause) {
    if (generation !== detailGeneration) return
    if (inaccessible(cause)) { thread.value = null; detailState.value = 'missing' }
    else detailStale.value = true
  }
}
// Later messages come on request. A change signal reads once from the end of
// what is loaded; it never replaces the loaded pages with the first page.
async function loadLater() {
  if (!room.value || loadingLater.value) return
  const generation = detailGeneration
  const current = room.value
  loadingLater.value = true
  laterFailed.value = false
  try {
    const next = await readChat(current.chatId, current.nextAfter)
    if (generation !== detailGeneration) return
    room.value = appendChatPage(current, next)
    newMessages.value = false
  } catch (cause) {
    if (generation !== detailGeneration) return
    if (inaccessible(cause)) { room.value = null; detailState.value = 'missing' }
    else laterFailed.value = true
  } finally {
    loadingLater.value = false
  }
}
async function chatChanged(chatId?: string) {
  void loadChats()
  if (!room.value || (chatId && chatId !== room.value.chatId)) return
  if (room.value.hasMore) { newMessages.value = true; return }
  await loadLater()
}

// Phone navigation: remember where the person was, and return them there.
const listElement = ref<HTMLElement | null>(null)
let memory: { key: string; scrollY: number; listScroll: number } | null = null
function remember(key: string) {
  memory = { key, scrollY: window.scrollY, listScroll: listElement.value?.scrollTop ?? 0 }
}
async function focusDetailTitle() {
  await nextTick()
  document.querySelector<HTMLElement>('[data-roundtable-detail-title]')?.focus({ preventScroll: true })
}
async function restoreList() {
  const saved = memory
  if (!saved) return
  await nextTick()
  if (listElement.value) listElement.value.scrollTop = saved.listScroll
  window.scrollTo?.(0, saved.scrollY)
  const link = [...document.querySelectorAll<HTMLElement>('[data-roundtable-key]')].find(item => item.dataset.roundtableKey === saved.key)
  ;(link ?? document.querySelector<HTMLElement>('[data-roundtable-list-head]'))?.focus({ preventScroll: true })
}
// Back returns to the list this page came from; a deep link replaces itself
// with the list instead of leaving the site.
function back() {
  const previous = window.history.state?.back
  if (typeof previous === 'string' && /^\/roundtables\/?(\?.*)?$/.test(previous)) router.back()
  else void router.replace({ path: '/roundtables', query: route.query })
}

const loadingList = computed(() => threadsState.value === 'loading' && chatsState.value === 'loading')
const empty = computed(() => threadsState.value === 'ready' && chatsState.value === 'ready' && !threads.value.length && !chats.value.length)
const hasMoreChats = computed(() => Boolean(localNext.value || remoteNext.value))

watch([selectedId, selectedChatId], (_current, previous) => {
  void loadDetail()
  if (!hasSelection.value && (previous?.[0] || previous?.[1])) void restoreList()
})
let timer: ReturnType<typeof setInterval> | undefined
let stopChatUpdates = () => {}
onMounted(() => {
  void loadThreads()
  void loadChats()
  void loadDetail()
  // Legacy execution asks have their own status lifecycle. Chat uses SSE only.
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') { void loadThreads(); void refreshThreadDetail() }
  }, 5000)
})
watch(() => consoleStore.activePersonalSpace?.id, (spaceId, _old, cleanup) => {
  if (!spaceId) return
  stopChatUpdates = subscribeChatUpdates(spaceId, {
    chatChanged: update => { void chatChanged(update?.chatId) },
    reconnected: () => { void chatChanged() },
    unavailable: () => { chatsUnavailable.value = true },
  })
  cleanup(stopChatUpdates)
}, { immediate: true })
onBeforeUnmount(() => { stopped = true; detailGeneration++; chatListGeneration++; stopChatUpdates(); clearInterval(timer) })

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
// Cleanup after a wake is shown unless it was confirmed; it is never assumed clean.
const cleanupWarning = (message: RoundtableMessage) => message.cleanup && message.cleanup.status !== 'confirmed'
  ? t('roundtable.cleanupUnconfirmed', { code: message.cleanup.code ?? message.cleanup.status }) : ''
</script>

<template>
  <section class="view roundtable-view">
    <GrowthLoading v-if="loadingList" :label="t('roundtable.loading')" />
    <div v-else-if="empty" class="roundtable-empty">
      <strong>{{ t('roundtable.empty') }}</strong>
      <p>{{ t('roundtable.emptyHint') }}</p>
    </div>
    <div v-else class="ui-split roundtable-layout" :class="{ 'has-selection': hasSelection }">
      <nav ref="listElement" class="ui-split-list roundtable-list" :aria-label="t('roundtable.threads')">
        <div class="ui-split-head">
          <span role="status" tabindex="-1" data-roundtable-list-head>{{ t('roundtable.count', { count: threads.length + chats.length }) }}</span>
          <span v-if="threads.length" class="ui-meta">{{ t('roundtable.latest50') }}</span>
        </div>
        <p v-if="chatsUnavailable" class="ui-meta roundtable-remote-note">{{ t('roundtable.chat.remoteUnavailable') }}</p>
        <p v-if="chatsState === 'failed'" class="ui-meta roundtable-remote-note" role="status">{{ t('roundtable.chatsFailed') }}</p>
        <p v-if="threadsState === 'failed'" class="roundtable-remote-note" role="alert">
          {{ t('roundtable.threadsFailed') }} <UiButton size="sm" variant="ghost" @click="loadThreads">{{ t('roundtable.retry') }}</UiButton>
        </p>
        <p v-else-if="threadsStale" class="ui-meta roundtable-remote-note" role="status">{{ t('roundtable.stale') }}</p>
        <div class="ui-split-items">
          <RouterLink v-for="item in chats" :key="`chat:${item.chatId}`" class="ui-split-item" :class="{ 'is-selected': item.chatId === selectedChatId }"
            :aria-current="item.chatId === selectedChatId ? 'page' : undefined" :to="`/roundtables/chat/${encodeURIComponent(item.chatId)}`"
            :data-roundtable-key="`chat:${item.chatId}`" data-testid="roundtable-chat-room" @click="remember(`chat:${item.chatId}`)">
            <span class="ui-split-item-meta">
              <span>{{ t(`roundtable.chat.kinds.${item.kind}`) }} · {{ item.members.length }}</span>
              <time :datetime="item.updatedAt">{{ time(item.updatedAt) }}</time>
            </span>
            <strong class="ui-split-item-title">{{ chatRoomName(item) }}</strong>
          </RouterLink>
          <RouterLink v-for="item in threads" :key="`thread:${item.id}`" class="ui-split-item" :class="{ 'is-selected': item.id === selectedId }"
            :aria-current="item.id === selectedId ? 'page' : undefined" :to="`/roundtables/${encodeURIComponent(item.id)}`"
            :data-roundtable-key="`thread:${item.id}`" data-testid="roundtable-thread" @click="remember(`thread:${item.id}`)">
            <span class="ui-split-item-meta">
              <span>{{ item.participants.map((person) => person.name).join(' · ') }}</span>
              <span v-if="item.waiting" class="roundtable-waiting" data-roundtable-waiting>{{ waitingLabel(item) }}</span>
              <time v-else :datetime="item.updatedAt">{{ time(item.updatedAt) }}</time>
            </span>
            <strong class="ui-split-item-title">{{ item.subject }}</strong>
            <span v-if="item.last" class="ui-split-item-sub">{{ item.last.from }}：{{ item.last.body }}</span>
          </RouterLink>
        </div>
        <UiButton v-if="hasMoreChats" class="roundtable-more" size="sm" variant="ghost" :busy="loadingMoreChats"
          :busy-label="t('roundtable.loadingMoreChats')" data-roundtable-more-chats @click="loadMoreChats">{{ t('roundtable.loadMoreChats') }}</UiButton>
      </nav>

      <article v-if="thread" class="ui-split-detail" data-testid="roundtable-timeline">
        <header class="ui-split-detail-head">
          <UiIconButton class="roundtable-back" icon="chevron-left" :label="t('roundtable.back')" data-roundtable-back @click="back" />
          <h2 tabindex="-1" data-roundtable-detail-title>{{ thread.subject }}</h2>
          <p class="ui-list-meta">{{ t('roundtable.messages', { count: thread.messages.length }) }} · {{ time(thread.createdAt) }}</p>
          <p v-if="detailStale" class="ui-meta" role="status">{{ t('roundtable.stale') }}</p>
          <RoundtableSeats :seats="seats" />
        </header>
        <div class="ui-split-detail-body">
          <p v-if="!thread.messages.length" class="ui-meta">{{ t('roundtable.emptyConversation') }}</p>
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
                    <p v-if="cleanupWarning(message)" class="roundtable-cleanup" data-roundtable-cleanup>{{ cleanupWarning(message) }}</p>
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
                <p v-if="cleanupWarning(message)" class="roundtable-cleanup" data-roundtable-cleanup>{{ cleanupWarning(message) }}</p>
                <p class="roundtable-body">{{ message.body }}</p>
              </li>
            </ul>
          </section>
        </div>
      </article>
      <RoundtableRoom v-else-if="room" :room="room" :time="time" :loading-later="loadingLater" :later-failed="laterFailed" @later="loadLater">
        <template #back>
          <UiIconButton class="roundtable-back" icon="chevron-left" :label="t('roundtable.back')" data-roundtable-back @click="back" />
          <p v-if="newMessages" class="ui-meta" role="status">{{ t('roundtable.newMessages') }}</p>
        </template>
      </RoundtableRoom>
      <div v-else-if="hasSelection" class="ui-split-detail roundtable-detail-state">
        <UiIconButton class="roundtable-back" icon="chevron-left" :label="t('roundtable.back')" data-roundtable-back @click="back" />
        <GrowthLoading v-if="detailState === 'loading'" variant="compact" :label="t('roundtable.detailLoading')" />
        <p v-else-if="detailState === 'missing'" role="alert">{{ t('roundtable.detailMissing') }}</p>
        <p v-else-if="detailState === 'failed'" role="alert">
          {{ t('roundtable.loadFailed') }} <UiButton size="sm" variant="ghost" @click="loadDetail">{{ t('roundtable.retry') }}</UiButton>
        </p>
      </div>
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
.roundtable-more { margin: 8px 16px 16px; }
.roundtable-back { display: none; }
.roundtable-detail-state { display: grid; align-content: start; gap: 12px; padding: 16px; }
.roundtable-cleanup { margin-top: 6px; color: var(--color-warning); font-size: 12px; font-weight: 600; }
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
.ui-split-detail-head h2 { overflow-wrap: anywhere; }
.ui-split-detail-head h2:focus { outline: none; }
.ui-split-detail-head h2:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
/* Phone: the list and the detail take turns; the hidden one leaves the layout,
   the tab order and the accessibility tree. */
@media (max-width: 860px) {
  .roundtable-layout.has-selection .roundtable-list { display: none; }
  .roundtable-layout:not(.has-selection) .ui-split-placeholder { display: none; }
  .roundtable-back { display: inline-flex; width: 44px; height: 44px; margin: 0 0 4px -8px; }
  .roundtable-message.is-reply { margin-left: 16px; }
}
@media (max-width: 480px) {
  .roundtable-message { gap: 8px; }
  .roundtable-message.is-reply { margin-left: 8px; }
}
</style>
