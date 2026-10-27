<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'

import { ApiError } from '@/api/client'
import BackLink from '@/components/BackLink.vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { currentLocale, t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { Button } from '@/components/ui/button'
import UiNotice from '@/ui/UiNotice.vue'
import { subscribeChatUpdates } from '@/features/project-agents/task-updates'
import {
  appendChatPage, listChats, listThreads, readChat, readThread,
  type RoundtableChatPage, type RoundtableChatRoom, type RoundtableThread, type RoundtableThreadSummary,
} from './roundtable-api'
import { chatBubbles, chatRoomName, deliveryInFlight } from './roundtable-model'
import { createReadScope, serialQueue, singleFlight, type ReadScope } from './roundtable-reads'
import { rememberPlace, restorePlace, type ListPlace } from './roundtable-scroll'
import RoundtableNewConversation from './RoundtableNewConversation.vue'
import RoundtableRoom from './RoundtableRoom.vue'
import RoundtableThreadChat from './RoundtableThreadChat.vue'

// Conversations with and between FLAs: the person's own threads with their
// FLAs (message board or instant chat), asks between Agents (message_agent),
// and Agent chat rooms (agent_chat, 1:1 or groups), which people only watch.
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
const SLOW_MS = 8_000
// While a woken FLA is replying, the open thread is read this often.
const REPLYING_REFRESH_MS = 1_500

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
// The scope is the one the read was asked for: a read queued before the person
// opened another conversation does nothing in the new one.
async function readRoomTail(mode: 'append' | 'check', scope: ReadScope): Promise<boolean> {
  if (scope !== detail) return false
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
  const scope = detail
  tailQueued = true
  return inRoomOrder(() => {
    if (scope === detail) tailQueued = false
    return readRoomTail('append', scope)
  })
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
    const opened = detail
    const roomOk = room.value ? await inRoomOrder(() => readRoomTail('check', opened)) : true
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

// Back to the list: remember the first visible card and its offset, and return
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
// "← 全部对话" goes Back when the list opened this conversation, so the list
// returns where it was; a deep link opens the list instead.
const openedFromList = /^\/roundtables\/?(\?.*)?$/
const listPath = computed(() => router.resolve({ path: '/roundtables', query: route.query }).fullPath)

const listLoading = computed(() => threadsState.value === 'loading' && chatsState.value === 'loading')
const empty = computed(() => threadsState.value === 'ready' && chatsState.value === 'ready' && !threads.value.length && !chats.value.length)
// Both lists failed with nothing to show: one state with one retry, not two bare notices.
const listsFailed = computed(() => threadsState.value === 'failed' && chatsState.value === 'failed' && !threads.value.length && !chats.value.length && !accessNotice.value)
function retryLists() { void loadThreads(); void loadChats() }
const hasMoreChats = computed(() => Boolean(localNext.value || remoteNext.value))
// A wide screen shows a thread's participants open; a phone keeps them folded.
// It follows the breakpoint when the window is resized.
const narrowQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 860px)') : null
const wide = ref(!narrowQuery?.matches)
const followBreakpoint = (event: MediaQueryListEvent) => { wide.value = !event.matches }
const starting = ref(false)

watch([selectedId, selectedChatId], (_current, previous) => {
  starting.value = false
  void loadDetail()
  if (!hasSelection.value && (previous?.[0] || previous?.[1])) void restoreList()
})
watch(spaceId, (current, previous) => { if (previous && current !== previous) reloadAll() })
let timer: ReturnType<typeof setInterval> | undefined
let replyingTimer: ReturnType<typeof setInterval> | undefined
let stopChatUpdates = () => {}
const replying = computed(() => Boolean(thread.value && deliveryInFlight(chatBubbles(thread.value))))
onMounted(() => {
  void loadThreads()
  void loadChats()
  void loadDetail()
  narrowQuery?.addEventListener?.('change', followBreakpoint)
  // Asks have their own status lifecycle. Chat uses SSE only.
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') { void loadThreads(false); void refreshThreadDetail(false) }
  }, 5000)
  replyingTimer = setInterval(() => {
    if (replying.value && document.visibilityState === 'visible') void refreshThreadDetail(false)
  }, REPLYING_REFRESH_MS)
})
// The person's post or mode change answers with the thread as recorded.
function threadUpdated(value: RoundtableThread) {
  thread.value = value
  detailStale.value = false
  void loadThreads(false)
}
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
  clearInterval(replyingTimer)
  narrowQuery?.removeEventListener?.('change', followBreakpoint)
})

const waitingLabel = (item: RoundtableThreadSummary) => item.waitingFor?.length
  ? t('roundtable.waitingFor', { names: item.waitingFor.join('、') })
  : t('roundtable.waiting')
function time(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '' : new Intl.DateTimeFormat(currentLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}
// The person's own messages carry no Agent name.
const lastFrom = (item: RoundtableThreadSummary) => item.last?.from ?? t('roundtable.you')
</script>

<template>
  <section class="view roundtable-view" :class="{ 'has-selection': hasSelection }">
   <!-- One canvas: the list of conversations, or the open one with a way back; never both side by side. -->
   <div class="roundtable-canvas mx-auto flex w-full max-w-(--layout-max) flex-col">
    <UiNotice v-if="accessNotice" tone="error" class="roundtable-notice">
      {{ t('roundtable.accessLost') }}
      <template #actions><Button size="sm" variant="ghost" @click="reloadAll">{{ t('roundtable.retry') }}</Button></template>
    </UiNotice>
    <UiNotice v-if="liveDisconnected" :tone="reloadFailed ? 'error' : 'warning'" class="roundtable-notice" data-roundtable-live>
      {{ t('roundtable.liveDisconnected') }}<template v-if="reloadFailed"> {{ t('roundtable.reloadFailed') }}</template>
      <template #actions><Button size="sm" variant="ghost" :loading="reconnecting" :loading-label="t('roundtable.reloading')" @click="reconnected">{{ t('roundtable.reload') }}</Button></template>
    </UiNotice>
    <GrowthLoading v-if="listLoading && !hasSelection" :label="t('roundtable.loading')" />
    <div v-else-if="listsFailed && !hasSelection" class="roundtable-empty" role="alert" data-roundtable-lists-failed>
      <strong>{{ t('roundtable.loadFailed') }}</strong>
      <p>{{ t('roundtable.loadFailedHint') }}</p>
      <Button class="roundtable-empty-action" @click="retryLists">{{ t('roundtable.retry') }}</Button>
    </div>
    <RoundtableNewConversation v-else-if="starting && !hasSelection" @close="starting = false" />
    <div v-else-if="empty && !hasSelection" class="roundtable-empty">
      <strong>{{ t('roundtable.empty') }}</strong>
      <p>{{ t('roundtable.emptyHint') }}</p>
      <Button class="roundtable-empty-action" data-roundtable-start @click="starting = true">{{ t('roundtable.start.open') }}</Button>
    </div>
    <div v-else class="ui-conversation roundtable-layout">
      <BackLink v-if="hasSelection" class="roundtable-back" :to="listPath" :from="openedFromList" data-roundtable-back>{{ t('roundtable.back') }}</BackLink>
      <nav v-else ref="listElement" class="ui-conversation-list roundtable-list" :aria-label="t('roundtable.threads')">
        <div class="ui-conversation-head">
          <span role="status" tabindex="-1" data-roundtable-list-head>{{ t('roundtable.count', { count: threads.length + chats.length }) }}</span>
          <span v-if="threads.length" class="ui-meta">{{ t('roundtable.latest50') }}</span>
        </div>
        <Button class="roundtable-start" size="sm" data-roundtable-start @click="starting = true">{{ t('roundtable.start.open') }}</Button>
        <GrowthLoading v-if="listLoading" variant="compact" :label="t('roundtable.loading')" />
        <p v-else-if="empty" class="ui-meta roundtable-remote-note">{{ t('roundtable.empty') }}</p>
        <p v-if="remoteUnavailable" class="ui-meta roundtable-remote-note">{{ t('roundtable.chat.remoteUnavailable') }}</p>
        <p v-if="chatsState === 'failed' && !accessNotice" class="ui-meta roundtable-remote-note" role="status">
          {{ t('roundtable.chatsFailed') }} <Button size="sm" variant="ghost" @click="loadChats()">{{ t('roundtable.retry') }}</Button>
        </p>
        <p v-else-if="chatsStale" class="ui-meta roundtable-remote-note" role="status" data-roundtable-chats-stale>{{ t('roundtable.chatsStale') }}</p>
        <p v-if="threadsState === 'failed' && !accessNotice" class="roundtable-remote-note" role="alert">
          {{ t('roundtable.threadsFailed') }} <Button size="sm" variant="ghost" @click="loadThreads()">{{ t('roundtable.retry') }}</Button>
        </p>
        <p v-else-if="threadsStale" class="ui-meta roundtable-remote-note" role="status">{{ t('roundtable.stale') }}</p>
        <div class="ui-conversation-items">
          <RouterLink v-for="item in chats" :key="`chat:${item.chatId}`" class="ui-conversation-item" :to="`/roundtables/chat/${encodeURIComponent(item.chatId)}`"
            :data-roundtable-key="`chat:${item.chatId}`" data-testid="roundtable-chat-room" @click="remember(`chat:${item.chatId}`)">
            <span class="ui-conversation-item-meta">
              <span>{{ t(`roundtable.chat.kinds.${item.kind}`) }} · {{ item.members.length }}</span>
              <time :datetime="item.updatedAt">{{ time(item.updatedAt) }}</time>
            </span>
            <strong class="ui-conversation-item-title">{{ chatRoomName(item) }}</strong>
          </RouterLink>
          <RouterLink v-for="item in threads" :key="`thread:${item.id}`" class="ui-conversation-item" :to="`/roundtables/${encodeURIComponent(item.id)}`"
            :data-roundtable-key="`thread:${item.id}`" data-testid="roundtable-thread" @click="remember(`thread:${item.id}`)">
            <span class="ui-conversation-item-meta">
              <span>{{ item.participants.map((person) => person.name).join(' · ') }}</span>
              <span v-if="item.waiting" class="roundtable-waiting" data-roundtable-waiting>{{ waitingLabel(item) }}</span>
              <time v-else :datetime="item.updatedAt">{{ time(item.updatedAt) }}</time>
            </span>
            <strong class="ui-conversation-item-title">{{ item.subject }}</strong>
            <span v-if="item.last" class="ui-conversation-item-sub">{{ lastFrom(item) }}：{{ item.last.body }}</span>
          </RouterLink>
        </div>
        <p v-if="localMoreFailed" role="alert" class="roundtable-remote-note">{{ t('roundtable.localMoreFailed') }}</p>
        <Button v-if="hasMoreChats" class="roundtable-more" size="sm" variant="ghost" :loading="loadingMoreChats"
          :loading-label="t('roundtable.loadingMoreChats')" data-roundtable-more-chats @click="loadMoreChats">{{ t('roundtable.loadMoreChats') }}</Button>
      </nav>

      <RoundtableThreadChat v-if="thread" :thread="thread" :time="time" :stale="detailStale" :wide="wide" @updated="threadUpdated" />
      <RoundtableRoom v-else-if="room" :room="room" :time="time" :loading-later="loadingLater" :later-failed="laterFailed" :later-stuck="laterStuck"
        :new-messages="newMessages" :wide="wide" @later="loadLater" />
      <div v-else-if="hasSelection" class="ui-conversation-detail roundtable-detail-state">
        <template v-if="detailState === 'loading'">
          <GrowthLoading variant="compact" :label="t('roundtable.detailLoading')" />
          <p v-if="detailSlow" role="status" class="ui-meta">{{ t('roundtable.detailSlow') }}</p>
        </template>
        <p v-else-if="detailState === 'missing'" role="alert">{{ t('roundtable.detailMissing') }}</p>
        <p v-else-if="detailState === 'failed'" role="alert">
          {{ t('roundtable.loadFailed') }} <Button size="sm" variant="ghost" @click="loadDetail">{{ t('roundtable.retry') }}</Button>
        </p>
      </div>
    </div>
   </div>
  </section>
</template>

<style scoped>
.roundtable-view { display: flex; flex-direction: column; }
/* The open conversation fills the canvas and scrolls inside; the list scrolls with the page. */
.roundtable-view.has-selection { overflow: hidden; padding-bottom: 16px; }
.roundtable-canvas { flex: 1 0 auto; }
.has-selection .roundtable-canvas { flex: 1 1 0; min-height: 0; }
.roundtable-empty { max-width: 520px; margin: 12vh auto 0; text-align: center; }
.roundtable-empty strong { font-size: 16px; font-weight: 600; }
.roundtable-empty p { margin-top: 8px; color: var(--color-muted); }
.roundtable-empty-action { margin-top: 16px; }
.roundtable-notice { margin: 0 0 8px; }
.roundtable-waiting { color: var(--color-warning); font-weight: 600; }
.roundtable-remote-note { margin: 0; }
.roundtable-more { justify-self: start; }
.roundtable-start { justify-self: start; }
.roundtable-back { align-self: flex-start; color: var(--color-muted); font-size: 13px; text-decoration: none; }
.roundtable-back:hover { color: var(--color-ink); }
.roundtable-detail-state { display: grid; align-content: start; gap: 12px; padding: 16px; }
@media (max-width: 860px) {
  /* A long title or participant list scrolls away with a room's messages
     instead of pushing them out of the fixed card. A thread keeps its
     composer at the bottom, so only its messages scroll. */
  .roundtable-layout .ui-conversation-detail:not(.roundtable-thread-chat) { overflow-y: auto; overscroll-behavior: contain; }
  .roundtable-layout :deep(.ui-conversation-detail:not(.roundtable-thread-chat) .ui-conversation-detail-body) { flex: 0 0 auto; min-height: auto; overflow: visible; }
}
</style>
