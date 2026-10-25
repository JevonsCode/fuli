import { ref, toValue, type MaybeRefOrGetter } from 'vue'

import { apiErrorReason, isKnowledgeRecoveryPending } from '@/api/client'
import { readRoleSuggestions, type RoleSuggestion } from './suggestions'
import { readTonborgSuggestions, type TonborgSuggestion } from './tonborg-suggestions'

// The 建议 reads of the model settings page: the role log (Astro, Bole,
// Jefa) and Tonborg's knowledge review suggestions in the active space. The
// page starts them together with the role settings read, so the section never
// appears before its content. Each read keeps its own state; without a space
// yet only the log is read.
export function useRoleSuggestions(spaceId: MaybeRefOrGetter<string> = '') {
  const entries = ref<RoleSuggestion[] | null>(null)
  const loading = ref(false)
  const error = ref('')
  const reviews = ref<TonborgSuggestion[] | null>(null)
  const reviewsLoading = ref(false)
  const reviewsError = ref('')
  let reading: AbortController | null = null

  async function load() {
    reading?.abort()
    const current = new AbortController()
    reading = current
    const space = toValue(spaceId)
    await Promise.all([
      settle(current, () => readRoleSuggestions(current.signal), { result: entries, loading, error }),
      space ? settle(current, () => readTonborgSuggestions(space, current.signal), { result: reviews, loading: reviewsLoading, error: reviewsError }) : null,
    ])
  }

  async function settle<T>(current: AbortController, read: () => Promise<T>,
    state: { result: { value: T | null }; loading: { value: boolean }; error: { value: string } }) {
    state.loading.value = true
    state.error.value = ''
    try {
      const value = await read()
      if (reading === current && !current.signal.aborted) state.result.value = value
    } catch (cause) {
      if (reading !== current || current.signal.aborted) return
      if (!blockForRecovery(cause) && (cause as Error)?.name !== 'AbortError') state.error.value = apiErrorReason(cause)
    } finally {
      if (reading === current) state.loading.value = false
    }
  }

  function stop() {
    reading?.abort()
    reading = null
    loading.value = false
    reviewsLoading.value = false
  }

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
