import { ref, toValue, watch, type MaybeRefOrGetter, type Ref } from 'vue'

import { apiErrorReason, isKnowledgeRecoveryPending } from '@/api/client'
import { readRoleSuggestions, type RoleSuggestion } from './suggestions'
import { readTonborgSuggestions, type TonborgSuggestion } from './tonborg-suggestions'

// The 建议 reads of the model settings page: the role log (Astro, Bole,
// Jefa) and Tonborg's knowledge review suggestions in the active space, the
// latter an owner read the console must prove. The page starts them together
// with the role settings read, so the section never appears before its
// content. Each read keeps its own state and request. A read that fails drops
// what it showed before, so an old list never stays on screen under a refusal
// or an error; the failure line says which read failed. A change of the
// active space, or losing it, cancels Tonborg's read and drops its list, and
// a new space is read at once.
export function useRoleSuggestions(spaceId: MaybeRefOrGetter<string> = '') {
  const entries = ref<RoleSuggestion[] | null>(null)
  const loading = ref(false)
  const error = ref('')
  const reviews = ref<TonborgSuggestion[] | null>(null)
  const reviewsLoading = ref(false)
  const reviewsError = ref('')
  const log = { result: entries, loading, error, reading: null as AbortController | null }
  const tonborg = { result: reviews, loading: reviewsLoading, error: reviewsError, reading: null as AbortController | null }

  function load() {
    const space = toValue(spaceId)
    return Promise.all([
      settle(log, signal => readRoleSuggestions(signal)),
      space ? settle(tonborg, signal => readTonborgSuggestions(space, signal)) : null,
    ])
  }

  async function settle<T>(read: ReadState<T>, request: (signal: AbortSignal) => Promise<T>) {
    read.reading?.abort()
    const current = new AbortController()
    read.reading = current
    read.loading.value = true
    read.error.value = ''
    try {
      const value = await request(current.signal)
      if (read.reading === current && !current.signal.aborted) read.result.value = value
    } catch (cause) {
      if (read.reading !== current || current.signal.aborted) return
      if (blockForRecovery(cause)) return
      read.result.value = null
      if ((cause as Error)?.name !== 'AbortError') read.error.value = apiErrorReason(cause)
    } finally {
      if (read.reading === current) read.loading.value = false
    }
  }

  function cancel(read: { reading: AbortController | null; loading: Ref<boolean> }) {
    read.reading?.abort()
    read.reading = null
    read.loading.value = false
  }

  function stop() {
    cancel(log)
    cancel(tonborg)
  }

  watch(() => toValue(spaceId), (space) => {
    cancel(tonborg)
    reviews.value = null
    reviewsError.value = ''
    if (space) void settle(tonborg, signal => readTonborgSuggestions(space, signal))
  })

  // A nested score-card read, or either read here, can discover the same
  // closed gate. It invalidates every read, so a late answer cannot restore
  // bodies, and clears what both showed.
  function blockForRecovery(cause: unknown) {
    if (!isKnowledgeRecoveryPending(cause)) return false
    stop()
    entries.value = null
    reviews.value = null
    error.value = apiErrorReason(cause)
    reviewsError.value = error.value
    return true
  }

  return { entries, loading, error, reviews, reviewsLoading, reviewsError, load, stop, blockForRecovery }
}

interface ReadState<T> { result: Ref<T | null>; loading: Ref<boolean>; error: Ref<string>; reading: AbortController | null }
