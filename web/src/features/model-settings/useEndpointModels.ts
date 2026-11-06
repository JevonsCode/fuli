import { onScopeDispose, ref, watch } from 'vue'

import { apiErrorCode } from '@/api/client'
import { createDebouncedAction } from '@/lib/debounce'
import { listEndpointModels, type ModelListRequest } from './model-list'

// The model list of the endpoint the dialog shows now: read on refresh (the
// dialog's 刷新, and when it opens) and a moment after the address, protocol
// or key name changes. A newer request replaces an older one; a refresh keeps
// the list it has until the answer arrives.
const TYPING_PAUSE_MS = 600

export type EndpointModels =
  | { status: 'idle'; ids: string[] }
  | { status: 'loading'; ids: string[]; host: string }
  | { status: 'ok'; ids: string[]; host: string }
  | { status: 'failed'; ids: string[]; host: string; code: string | null }

export function useEndpointModels(request: () => ModelListRequest | null) {
  const models = ref<EndpointModels>({ status: 'idle', ids: [] })
  let current: AbortController | null = null
  let asked = ''

  async function load() {
    later.cancel()
    current?.abort()
    const body = request()
    asked = JSON.stringify(body)
    if (!body) {
      current = null
      models.value = { status: 'idle', ids: [] }
      return
    }
    const own = current = new AbortController()
    const host = new URL(body.endpoint).host
    models.value = { status: 'loading', ids: models.value.ids, host }
    try {
      const answer = await listEndpointModels(body, own.signal)
      if (own === current) models.value = { status: 'ok', ids: answer.models.map(model => model.id), host }
    } catch (cause) {
      if (own === current) models.value = { status: 'failed', ids: [], host, code: apiErrorCode(cause) }
    }
  }

  const later = createDebouncedAction(() => void load(), TYPING_PAUSE_MS)
  watch(() => JSON.stringify(request()), (next) => { if (next !== asked) later.schedule(); else later.cancel() })
  onScopeDispose(() => {
    later.cancel()
    current?.abort()
  })

  return { models, refresh: () => void load() }
}
