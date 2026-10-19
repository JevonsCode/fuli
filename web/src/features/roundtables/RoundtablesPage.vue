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
import { createReadScope, serialQueue, singleFlight, type ReadScope } from './roundtable-reads'
import { rememberPlace, restorePlace, type ListPlace } from './roundtable-scroll'
import RoundtableRoom from './RoundtableRoom.vue'
import RoundtableSeats from './RoundtableSeats.vue'

// A read-only record of Agents talking to each other: chat rooms (agent_chat,
// 1:1 or groups) and asks between Agents (message_agent). People only watch.
// Each source and the open detail load and fail on their own: one failure
// never hides another source or claims the list is empty, and a deep-linked
// detail shows even when the lists are empty or still loading. A change of
// space or lost access clears everything shown and ends every read in flight.
const route = useRoute()
const router = useRouter()
const consoleStore = useConsoleStore()
const spaceId = computed(() => consoleStore.activePersonalSpace?.id ?? '')
const selectedId = computed(() => typeof route.params.threadId === 'string' ? route.params.threadId : '')
const selectedChatId = computed(() => typeof route.params.chatId === 'string' ? route.params.chatId : '')
const hasSelection = computed(() => Boolean(selectedId.value || selectedChatId.value))
const CLIENTS: Record<string, string> = { claude_code: 'Claude Code', codex: 'Codex', cursor: 'Cursor', claude: 'Claude', other: 'Agent' }
const SLOW_MS = 8_000

const denied = (cause: unknown) => cause instanceof ApiError && (cause.status === 401 || cause.status === 403)
const inaccessible = (cause: unknown) => cause instanceof ApiError && [400, 401, 403, 404, 422].includes(cause.status)
// Lists belong to the space; the detail to the open conversation. Ending a
// scope aborts its reads, so nothing from before can land or keep a button busy.
let lists: ReadScope = createReadScope()
let detail: ReadScope = createReadScope()

// Asks: the latest 50 only, refreshed every 5 seconds while visible, one read at a time.
const threads = ref<RoundtableThreadSummary[]>([])
const threadsState = ref<'loading' | 'ready' | 'failed'>('loading')
const threadsStale = ref(false)
const loadThreads = singleFlight(async () => {
  const scope = lists
  try {
    const list = await scope.read(signal => listThreads(signal))
    if (scope !== lists) return
    threads.value = list.threads
    threadsState.value = 'ready'
    threadsStale.value = false
  } catch (cause) {
    if (scope !== lists) return
    if (denied(cause)) { revoke(); return }
    if (threadsState.value === 'ready') threadsStale.value = true
    else threadsState.value = 'failed'
  }
})

// Chat rooms: local and remote pages each follow their own cursor. Change
// signals that arrive during a read ask for one more read, never a parallel one.
const chats = ref<RoundtableChatRoom[]>([])
const chatsState = ref<'loading' | 'ready' | 'failed'>('loading')
const chatsStale = ref(false)
const remoteUnavailable = ref(false)
const localNext = ref<string | null>(null)
const remoteNext = ref<string | null>(null)
const localMoreFailed = ref(false)
const loadingMoreChats = ref(false)
let chatsOk = false
// A refreshed first page keeps later pages already loaded below it.
function mergeRooms(rooms: RoundtableChatRoom[], firstPage: boolean) {
  const fresh = new Map(rooms.map(item => [item.chatId, item]))
  const kept = chats.value.filter(item => !fresh.has(item.chatId))
  chats.value = firstPage ? [...rooms, ...kept] : [...chats.value.map(item => fresh.get(item.chatId) ?? item),
    ...rooms.filter(item => !chats.value.some(existing => existing.chatId === item.chatId))]
}
const loadChats = singleFlight(async () => {
  const scope = lists
  chatsOk = false
  try {
    const page = await scope.read(signal => listChats({}, signal))
    if (scope !== lists) return
    const firstLoad = chatsState.value !== 'ready'
    mergeRooms(page.chats, true)
    if (firstLoad) {
      localNext.value = page.hasMore ? page.nextChat ?? null : null
      remoteNext.value = page.remotePage?.hasMore ? page.remotePage.nextChat : null
    }
    remoteUnavailable.value = Boolean(page.remoteUnavailable)
    chatsState.value = 'ready'
    chatsStale.value = false
    chatsOk = true
  } catch (cause) {
    if (scope !== lists) return
    if (denied(cause)) { revoke(); return }
    if (chatsState.value === 'ready') chatsStale.value = true
    else chatsState.value = 'failed'
  }
})
async function loadMoreChats() {
  if (loadingMoreChats.value) return
  const scope = lists
  loadingMoreChats.value = true
  localMoreFailed.value = false
  try {
    for (const transport of ['local', 'peer'] as const) {
      const cursor = transport === 'local' ? localNext.value : remoteNext.value
      if (!cursor) continue
      try {
        const page = await scope.read(signal => listChats({ transport, afterChat: cursor }, signal))
        if (scope !== lists) return
        mergeRooms(page.chats, false)
        // A cursor that does not move would loop; stop rather than refetch it.
        const next = page.hasMore && page.nextChat && page.nextChat !== cursor ? page.nextChat : null
        if (transport === 'local') localNext.value = next
        else remoteNext.value = next
      } catch (cause) {
        if (scope !== lists) return
        if (denied(cause)) { revoke(); return }
        // The failed source keeps its cursor, so the same page can be read again.
        if (transport === 'local') localMoreFailed.value = true
        else remoteUnavailable.value = true
      }
    }
  } finally {
    if (scope === lists) loadingMoreChats.value = false
  }
}

// The open detail. A newer route or scope always wins over a late response.
const thread = ref<RoundtableThread | null>(null)
const room = ref<RoundtableChatPage | null>(null)
const detailState = ref<'idle' | 'loading' | 'ready' | 'missing' | 'failed'>('idle')
const detailSlow = ref(false)
const detailStale = ref(false)
const loadingLater = ref(false)
const laterFailed = ref(false)
const laterStuck = ref(false)
const newMessages = ref(false)
// Every read of the open room runs in order and starts from what the previous
// one left, so a late answer can never take back messages already shown.
let inRoomOrder = serialQueue()
let tailQueued = false
let slowTimer: ReturnType<typeof setTimeout> | undefined
function resetDetail() {
  detail.end()
  detail = createReadScope()
  inRoomOrder = serialQueue()
  tailQueued = false
  clearTimeout(slowTimer)
  thread.value = null
  room.value = null
  detailSlow.value = false
  detailStale.value = false
  loadingLater.value = false
  laterFailed.value = false
  laterStuck.value = false
  newMessages.value = false
}
async function loadDetail() {
  resetDetail()
  const scope = detail
  if (!hasSelection.value) { detailState.value = 'idle'; return }
  detailState.value = 'loading'
  slowTimer = setTimeout(() => { if (scope === detail) detailSlow.value = true }, SLOW_MS)
  try {
    if (selectedId.value) {
      const id = selectedId.value
      const value = await scope.read(signal => readThread(id, signal))
      if (scope === detail) thread.value = value
    } else {
      const id = selectedChatId.value
      const value = await scope.read(signal => readChat(id, 0, signal))
      if (scope === detail) room.value = value
    }
    if (scope === detail) { detailState.value = 'ready'; void focusDetailTitle() }
  } catch (cause) {
    if (scope !== detail) return
    if (denied(cause)) { revoke(); return }
    detailState.value = inaccessible(cause) ? 'missing' : 'failed'
  } finally {
    if (scope === detail) { clearTimeout(slowTimer); detailSlow.value = false }
  }
}
// A timed refresh is skipped while the previous one is still reading.
const refreshThreadDetail = singleFlight(async () => {
  const id = selectedId.value
  const scope = detail
  if (!id || !thread.value) return
  try {
    const value = await scope.read(signal => readThread(id, signal))
    if (scope === detail) { thread.value = value; detailStale.value = false }
  } catch (cause) {
    if (scope !== detail) return
    if (denied(cause)) { revoke(); return }
    if (inaccessible(cause)) { thread.value = null; detailState.value = 'missing' }
    else detailStale.value = true
  }
})
// Reads the open room from the end of what is shown. "check" only confirms
// access and notices new messages when unread pages are still between.
async function readRoomTail(mode: 'append' | 'check'): Promise<boolean> {
  const scope = detail
  const current = room.value
  if (!current) return true
  loadingLater.value = true
  laterFailed.value = false
  try {
    const next = await scope.read(signal => readChat(current.chatId, current.nextAfter, signal))
    if (scope !== detail || room.value !== current) return false
    if (mode === 'check' && current.hasMore) {
      if (next.messages.length) newMessages.value = true
      return true
    }
    const merged = appendChatPage(current, next)
    // A cursor that did not move cannot reach more messages; stop offering it.
    laterStuck.value = next.hasMore && next.nextAfter <= current.nextAfter
    room.value = laterStuck.value ? { ...merged, hasMore: false } : merged
    newMessages.value = false
    return true
  } catch (cause) {
    if (scope !== detail) return false
    if (denied(cause)) revoke()
    else if (inaccessible(cause)) { room.value = null; detailState.value = 'missing' }
    else laterFailed.value = true
    return false
  } finally {
    if (scope === detail) loadingLater.value = false
  }
}
// Later messages on request, or after a change signal; signals that arrive
// while one read waits its turn share that read.
function loadLater() {
  if (tailQueued) return Promise.resolve(true)
  tailQueued = true
  return inRoomOrder(() => { tailQueued = false; return readRoomTail('append') })
}
// A change signal checks the open room; a room with more pages to read is only
// marked, so loaded pages are never replaced.
async function chatChanged(chatId?: string) {
  void loadChats()
  if (!room.value || (chatId && chatId !== room.value.chatId)) return
  if (room.value.hasMore) { newMessages.value = true; return }
  await loadLater()
}
// The live feed counts as back only after a real read succeeds; until then the
// disconnect notice stays, with what failed and a way to retry.
const liveDisconnected = ref(false)
const reloadFailed = ref(false)
const reconnecting = ref(false)
async function reconnected() {
  const scope = lists
  reconnecting.value = true
  try {
    await loadChats()
    const roomOk = room.value ? await inRoomOrder(() => readRoomTail('check')) : true
    if (scope !== lists) return
    const ok = chatsOk && roomOk
    reloadFailed.value = !ok
    if (ok) liveDisconnected.value = false
  } finally {
    if (scope === lists) reconnecting.value = false
  }
}

// Lost access or a new space: nothing from before stays on the page.
const accessNotice = ref(false)
function clearAll() {
  lists.end()
  lists = createReadScope()
  resetDetail()
  threads.value = []
  chats.value = []
  localNext.value = null
  remoteNext.value = null
  localMoreFailed.value = false
  loadingMoreChats.value = false
  threadsStale.value = false
  chatsStale.value = false
  reloadFailed.value = false
  reconnecting.value = false
  place = null
}
function revoke() {
  clearAll()
  accessNotice.value = true
  threadsState.value = 'failed'
  chatsState.value = 'failed'
  detailState.value = hasSelection.value ? 'missing' : 'idle'
}
function reloadAll() {
  clearAll()
  accessNotice.value = false
  threadsState.value = 'loading'
  chatsState.value = 'loading'
  void loadThreads()
  void loadChats()
  void loadDetail()
}

// Phone navigation: remember the first visible card and its offset, and return
// the person there. Memory lives only in this page, never in storage.
const listElement = ref<HTMLElement | null>(null)
let place: ListPlace | null = null
function remember(key: string) { place = rememberPlace(listElement.value, key) }
async function focusDetailTitle() {
  await nextTick()
  document.querySelector<HTMLElement>('[data-roundtable-detail-title]')?.focus({ preventScroll: true })
}
async function restoreList() {
  const saved = place
  if (!saved) return
  await nextTick()
  await restorePlace(listElement.value, saved, () => document.querySelector<HTMLElement>('[data-roundtable-list-head]'))
}
// Back returns to the list this page came from; a deep link replaces itself
// with the list instead of leaving the site.
function back() {
  const previous = window.history.state?.back
  if (typeof previous === 'string' && /^\/roundtables\/?(\?.*)?$/.test(previous)) router.back()
  else void router.replace({ path: '/roundtables', query: route.query })
}

const listLoading = computed(() => threadsState.value === 'loading' && chatsState.value === 'loading')
const empty = computed(() => threadsState.value === 'ready' && chatsState.value === 'ready' && !threads.value.length && !chats.value.length)
const hasMoreChats = computed(() => Boolean(localNext.value || remoteNext.value))
// A wide screen shows a thread's participants open; a phone keeps them folded.
// It follows the breakpoint when the window is resized.
const narrowQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 860px)') : null
const wide = ref(!narrowQuery?.matches)
const followBreakpoint = (event: MediaQueryListEvent) => { wide.value = !event.matches }
const subjectOpen = ref(false)

watch([selectedId, selectedChatId], (_current, previous) => {
  subjectOpen.value = false
  void loadDetail()
  if (!hasSelection.value && (previous?.[0] || previous?.[1])) void restoreList()
})
watch(spaceId, (current, previous) => { if (previous && current !== previous) reloadAll() })
let timer: ReturnType<typeof setInterval> | undefined
let stopChatUpdates = () => {}
onMounted(() => {
  void loadThreads()
  void loadChats()
  void loadDetail()
  narrowQuery?.addEventListener?.('change', followBreakpoint)
  // Legacy execution asks have their own status lifecycle. Chat uses SSE only.
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') { void loadThreads(false); void refreshThreadDetail(false) }
  }, 5000)
})
watch(spaceId, (id, _old, cleanup) => {
  if (!id) return
  stopChatUpdates = subscribeChatUpdates(id, {
    chatChanged: update => { void chatChanged(update?.chatId) },
    reconnected: () => { void reconnected() },
    unavailable: () => { liveDisconnected.value = true },
  })
  cleanup(stopChatUpdates)
}, { immediate: true })
onBeforeUnmount(() => {
  lists.end()
  resetDetail()
  detail.end()
  stopChatUpdates()
  clearInterval(timer)
  narrowQuery?.removeEventListener?.('change', followBreakpoint)
})

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
// An unknown status keeps its recorded value and says it is unknown.
function statusLabel(status: string) {
  const key = `roundtable.status.${status}`
  const label = t(key)
  return label === key ? t('roundtable.statusUnknown', { status }) : label
}
function delivery(message: RoundtableMessage) {
  if (message.kind === 'reply') {
    const mode = message.via?.split(':')[1]
    return mode && ['resume', 'new', 'inbox'].includes(mode) ? t(`roundtable.via.${mode}`) : ''
  }
  if (message.via === 'peer' && message.status === 'sent') return t('roundtable.status.remoteQueued')
  return message.status === 'answered' ? '' : statusLabel(message.status)
}
// Cleanup after a wake is shown unless it was confirmed; it is never assumed clean.
const cleanupWarning = (message: RoundtableMessage) => message.cleanup && message.cleanup.status !== 'confirmed'
  ? t('roundtable.cleanupUnconfirmed', { code: message.cleanup.code ?? message.cleanup.status }) : ''
// A request that ended without an answer was sent to someone; it is no longer waiting.
const requestTitle = (message: RoundtableMessage, closed: boolean) => t(closed ? 'roundtable.sentTo' : 'roundtable.waitingOn',
  { name: message.to.name ?? t('roundtable.unknownAgent') })
const record = (value: unknown) => JSON.stringify(value, null, 2)
// The full record as returned, without repeating the messages shown below it.
const threadRecord = computed(() => { if (!thread.value) return ''; const { messages: _messages, ...rest } = thread.value; return record(rest) })
</script>

<template>
  <section class="view roundtable-view">
    <p v-if="accessNotice" role="alert" class="roundtable-notice">
      {{ t('roundtable.accessLost') }} <UiButton size="sm" variant="ghost" @click="reloadAll">{{ t('roundtable.retry') }}</UiButton>
    </p>
    <p v-if="liveDisconnected" :role="reloadFailed ? 'alert' : 'status'" class="roundtable-notice" data-roundtable-live>
      {{ t('roundtable.liveDisconnected') }}<template v-if="reloadFailed"> {{ t('roundtable.reloadFailed') }}</template>
      <UiButton size="sm" variant="ghost" :busy="reconnecting" :busy-label="t('roundtable.reloading')" @click="reconnected">{{ t('roundtable.reload') }}</UiButton>
    </p>
    <GrowthLoading v-if="listLoading && !hasSelection" :label="t('roundtable.loading')" />
    <div v-else-if="empty && !hasSelection" class="roundtable-empty">
      <strong>{{ t('roundtable.empty') }}</strong>
      <p>{{ t('roundtable.emptyHint') }}</p>
    </div>
    <div v-else class="ui-split roundtable-layout" :class="{ 'has-selection': hasSelection }">
      <nav ref="listElement" class="ui-split-list roundtable-list" :aria-label="t('roundtable.threads')">
        <div class="ui-split-head">
          <span role="status" tabindex="-1" data-roundtable-list-head>{{ t('roundtable.count', { count: threads.length + chats.length }) }}</span>
          <span v-if="threads.length" class="ui-meta">{{ t('roundtable.latest50') }}</span>
        </div>
        <GrowthLoading v-if="listLoading" variant="compact" :label="t('roundtable.loading')" />
        <p v-else-if="empty" class="ui-meta roundtable-remote-note">{{ t('roundtable.empty') }}</p>
        <p v-if="remoteUnavailable" class="ui-meta roundtable-remote-note">{{ t('roundtable.chat.remoteUnavailable') }}</p>
        <p v-if="chatsState === 'failed' && !accessNotice" class="ui-meta roundtable-remote-note" role="status">
          {{ t('roundtable.chatsFailed') }} <UiButton size="sm" variant="ghost" @click="loadChats()">{{ t('roundtable.retry') }}</UiButton>
        </p>
        <p v-else-if="chatsStale" class="ui-meta roundtable-remote-note" role="status" data-roundtable-chats-stale>{{ t('roundtable.chatsStale') }}</p>
        <p v-if="threadsState === 'failed' && !accessNotice" class="roundtable-remote-note" role="alert">
          {{ t('roundtable.threadsFailed') }} <UiButton size="sm" variant="ghost" @click="loadThreads()">{{ t('roundtable.retry') }}</UiButton>
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
        <p v-if="localMoreFailed" role="alert" class="roundtable-remote-note">{{ t('roundtable.localMoreFailed') }}</p>
        <UiButton v-if="hasMoreChats" class="roundtable-more" size="sm" variant="ghost" :busy="loadingMoreChats"
          :busy-label="t('roundtable.loadingMoreChats')" data-roundtable-more-chats @click="loadMoreChats">{{ t('roundtable.loadMoreChats') }}</UiButton>
      </nav>

      <article v-if="thread" class="ui-split-detail" data-testid="roundtable-timeline">
        <header class="ui-split-detail-head">
          <UiIconButton class="roundtable-back" icon="chevron-left" :label="t('roundtable.back')" data-roundtable-back @click="back" />
          <h2 tabindex="-1" class="roundtable-subject" :class="{ 'is-open': subjectOpen }" data-roundtable-detail-title>{{ thread.subject }}</h2>
          <button v-if="thread.subject.length > 60" type="button" class="roundtable-subject-toggle" :aria-expanded="subjectOpen" @click="subjectOpen = !subjectOpen">
            {{ subjectOpen ? t('roundtable.subjectLess') : t('roundtable.subjectFull') }}
          </button>
          <p class="ui-list-meta">{{ t('roundtable.messages', { count: thread.messages.length }) }} · {{ time(thread.createdAt) }}</p>
          <p v-if="detailStale" class="ui-meta" role="status">{{ t('roundtable.stale') }}</p>
          <details class="roundtable-seats" :open="wide">
            <summary>{{ t('roundtable.participants', { count: seats.length }) }}</summary>
            <RoundtableSeats :seats="seats" />
          </details>
          <details class="roundtable-record" data-roundtable-record>
            <summary>{{ t('roundtable.recordDetails') }}</summary>
            <pre tabindex="0">{{ threadRecord }}</pre>
          </details>
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
                    <details class="roundtable-record"><summary>{{ t('roundtable.recordDetails') }}</summary><pre tabindex="0">{{ record(message) }}</pre></details>
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
                  <strong>{{ requestTitle(message, split.unanswered.includes(message)) }}</strong>
                  <span class="ui-meta">{{ t('roundtable.askedBy', { name: message.from.name ?? t('roundtable.unknownAgent') }) }}</span>
                  <time class="ui-meta" :datetime="message.createdAt">{{ time(message.createdAt) }}</time>
                </p>
                <p class="roundtable-request-state">{{ delivery(message) }}<template v-if="reason(message)"> · {{ reason(message) }}</template></p>
                <p v-if="cleanupWarning(message)" class="roundtable-cleanup" data-roundtable-cleanup>{{ cleanupWarning(message) }}</p>
                <p class="roundtable-body">{{ message.body }}</p>
                <details class="roundtable-record"><summary>{{ t('roundtable.recordDetails') }}</summary><pre tabindex="0">{{ record(message) }}</pre></details>
              </li>
            </ul>
          </section>
        </div>
      </article>
      <RoundtableRoom v-else-if="room" :room="room" :time="time" :loading-later="loadingLater" :later-failed="laterFailed" :later-stuck="laterStuck"
        :new-messages="newMessages" :wide="wide" @later="loadLater">
        <template #back>
          <UiIconButton class="roundtable-back" icon="chevron-left" :label="t('roundtable.back')" data-roundtable-back @click="back" />
        </template>
      </RoundtableRoom>
      <div v-else-if="hasSelection" class="ui-split-detail roundtable-detail-state">
        <UiIconButton class="roundtable-back" icon="chevron-left" :label="t('roundtable.back')" data-roundtable-back @click="back" />
        <template v-if="detailState === 'loading'">
          <GrowthLoading variant="compact" :label="t('roundtable.detailLoading')" />
          <p v-if="detailSlow" role="status" class="ui-meta">{{ t('roundtable.detailSlow') }}</p>
        </template>
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
.roundtable-notice { margin: 0 0 8px; font-size: 13px; }
.roundtable-section + .roundtable-section { margin-top: 24px; }
.roundtable-waiting { color: var(--color-warning); font-weight: 600; }
.roundtable-remote-note { margin: 8px 16px 0; }
.roundtable-more { margin: 8px 16px 16px; }
.roundtable-back { display: none; }
.roundtable-detail-state { display: grid; align-content: start; gap: 12px; padding: 16px; }
.roundtable-cleanup { margin-top: 6px; color: var(--color-warning); font-size: 12px; font-weight: 600; }
.roundtable-subject { overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.roundtable-subject.is-open { display: block; -webkit-line-clamp: unset; }
.roundtable-subject-toggle { justify-self: start; padding: 0; border: 0; background: none; color: var(--color-accent); font-size: 12px; cursor: pointer; }
.roundtable-seats summary, .roundtable-record summary { cursor: pointer; color: var(--color-muted); font-size: 12px; }
.roundtable-record pre { overflow: auto; max-height: 240px; margin: 4px 0 0; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
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
.ui-split-detail-head h2:focus { outline: none; }
.ui-split-detail-head h2:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
/* Phone: the list and the detail take turns; the hidden one leaves the layout,
   the tab order and the accessibility tree. The list uses the full height. */
@media (max-width: 860px) {
  .roundtable-layout.has-selection .roundtable-list { display: none; }
  .roundtable-layout:not(.has-selection) .ui-split-placeholder { display: none; }
  .roundtable-layout:not(.has-selection) .roundtable-list { max-height: none; flex: 1 1 auto; border-bottom: 0; }
  .roundtable-back { display: inline-flex; width: 44px; height: 44px; margin: 0 0 4px -8px; }
  .roundtable-message.is-reply { margin-left: 16px; }
  /* A long title, participant list or record scrolls away with the messages
     instead of pushing them out of the fixed card. */
  .roundtable-layout.has-selection .ui-split-detail { overflow-y: auto; overscroll-behavior: contain; }
  .roundtable-layout.has-selection :deep(.ui-split-detail-body) { flex: 0 0 auto; min-height: auto; overflow: visible; }
}
@media (max-width: 480px) {
  .roundtable-message { gap: 8px; }
  .roundtable-message.is-reply { margin-left: 8px; }
}
</style>
