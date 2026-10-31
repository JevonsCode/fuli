import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ApiError } from '@/api/client'
import { useConsoleStore } from '@/stores/console'
import { subscribeChatUpdates } from '@/features/project-agents/task-updates'
import {
  appendChatPage, listChats, listThreads, readChat, readThread,
  type RoundtableChatPage, type RoundtableChatRoom, type RoundtableThread, type RoundtableThreadSummary,
} from './roundtable-api'
import { chatBubbles, deliveryInFlight } from './roundtable-model'
import { createReadScope, serialQueue, singleFlight, type ReadScope } from './roundtable-reads'

/** What the page does around the data: focus the opened conversation, return to the list, forget the list place. */
export interface RoundtableHooks { detailReady?: () => void; backToList?: () => void; cleared?: () => void }

/**
 * The 圆桌 data: the person's threads, Agent chat rooms (local and peer pages),
 * the open conversation and the live feed, for the route's selection. The UI
 * owns nothing here; it reads this state and calls these actions.
 */
export function useRoundtable(hooks: RoundtableHooks = {}) {
  const route = useRoute()
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
      if (scope === detail) { detailState.value = 'ready'; hooks.detailReady?.() }
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
    hooks.cleared?.()
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


  const listLoading = computed(() => threadsState.value === 'loading' && chatsState.value === 'loading')
  const empty = computed(() => threadsState.value === 'ready' && chatsState.value === 'ready' && !threads.value.length && !chats.value.length)
  // Both lists failed with nothing to show: one state with one retry, not two bare notices.
  const listsFailed = computed(() => threadsState.value === 'failed' && chatsState.value === 'failed' && !threads.value.length && !chats.value.length && !accessNotice.value)
  function retryLists() { void loadThreads(); void loadChats() }
  const hasMoreChats = computed(() => Boolean(localNext.value || remoteNext.value))

  watch([selectedId, selectedChatId], (_current, previous) => {
    void loadDetail()
    if (!hasSelection.value && (previous?.[0] || previous?.[1])) hooks.backToList?.()
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
  })

  return {
    spaceId, selectedId, selectedChatId, hasSelection,
    threads, threadsState, threadsStale, loadThreads,
    chats, chatsState, chatsStale, remoteUnavailable, localMoreFailed, loadingMoreChats, loadChats, loadMoreChats, hasMoreChats,
    thread, room, detailState, detailSlow, detailStale, loadingLater, laterFailed, laterStuck, newMessages, loadDetail, loadLater, threadUpdated,
    liveDisconnected, reloadFailed, reconnecting, reconnected,
    accessNotice, reloadAll, listLoading, empty, listsFailed, retryLists,
  }
}
