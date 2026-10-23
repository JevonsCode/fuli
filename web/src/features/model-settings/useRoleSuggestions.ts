import { ref } from 'vue'

import { apiErrorReason, isKnowledgeRecoveryPending } from '@/api/client'
import { readRoleSuggestions, type RoleSuggestion } from './suggestions'

// The 建议 read of the model settings page. The page starts it together with
// the role settings read, so the section never appears before its content.
export function useRoleSuggestions() {
  const entries = ref<RoleSuggestion[] | null>(null)
  const loading = ref(false)
  const error = ref('')
  let reading: AbortController | null = null

  async function load() {
    reading?.abort()
    const current = new AbortController()
    reading = current
    loading.value = true
    error.value = ''
    try {
      const value = await readRoleSuggestions(current.signal)
      if (reading === current && !current.signal.aborted) entries.value = value
    } catch (cause) {
      if (reading !== current || current.signal.aborted) return
      if (!blockForRecovery(cause) && (cause as Error)?.name !== 'AbortError') error.value = apiErrorReason(cause)
    } finally {
      if (reading === current) loading.value = false
    }
  }

  function stop() {
    reading?.abort()
    reading = null
    loading.value = false
  }

  // A nested score-card read can discover the same closed gate. It must
  // invalidate the parent read too, so a late answer cannot restore bodies.
  function blockForRecovery(cause: unknown) {
    if (!isKnowledgeRecoveryPending(cause)) return false
    stop()
    entries.value = null
    error.value = apiErrorReason(cause)
    return true
  }

  return { entries, loading, error, load, stop, blockForRecovery }
}
