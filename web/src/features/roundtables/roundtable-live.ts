import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { listThreads, type RoundtableThreadSummary } from './roundtable-api'

// Whether any roundtable conversation is live right now: an Agent's woken run
// is answering an ask (the threads list's `replying`). The dock's 圆桌 icon
// animates from this. The 圆桌 page reports every list it reads; elsewhere the
// shell reads the list itself, less often, and skips a read the page just made.
const POLL_MS = 15_000
const live = ref(false)
let reportedAt = 0

/** The 圆桌 page's latest list, or an empty one when it cleared what it showed. */
export function reportThreads(threads: readonly Pick<RoundtableThreadSummary, 'replying'>[]) {
  live.value = threads.some(item => item.replying === true)
  reportedAt = Date.now()
}

/** For the shell: the live state of the space, kept fresh while the window is visible. */
export function useRoundtableLive(spaceId: Ref<string>) {
  let timer: ReturnType<typeof setInterval> | undefined
  let reading = false
  async function read() {
    if (!spaceId.value || reading || document.visibilityState !== 'visible' || Date.now() - reportedAt < POLL_MS) return
    reading = true
    const space = spaceId.value
    try {
      const { threads } = await listThreads()
      if (space === spaceId.value) reportThreads(threads)
    } catch {
      // Unknown is not live: the icon stays still rather than claim a reply is running.
      if (space === spaceId.value) live.value = false
    } finally { reading = false }
  }
  watch(spaceId, () => { live.value = false; reportedAt = 0; void read() })
  onMounted(() => {
    void read()
    timer = setInterval(() => { void read() }, POLL_MS)
  })
  onBeforeUnmount(() => clearInterval(timer))
  return computed(() => live.value)
}
