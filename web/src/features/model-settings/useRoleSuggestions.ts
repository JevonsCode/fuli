import { ref } from 'vue'

import { apiErrorReason } from '@/api/client'
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
      entries.value = await readRoleSuggestions(current.signal)
    } catch (cause) {
      if ((cause as Error)?.name !== 'AbortError') error.value = apiErrorReason(cause)
    } finally {
      if (reading === current) loading.value = false
    }
  }

  return { entries, loading, error, load, stop: () => reading?.abort() }
}
