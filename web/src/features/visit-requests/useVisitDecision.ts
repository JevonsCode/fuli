import { ref } from 'vue'
import { apiErrorCode, apiErrorReason } from '@/api/client'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { decideVisitRequest, type VisitAction } from './visit-request-api'
import type { VisitRequest } from './visit-request-shape'
import { useVisitAwaiting } from './useVisitAwaiting'
import { visitRequestLocation } from './useVisitPeek'
import { warningText } from './visit-request-model'

const KNOWN_ERRORS = new Set(['state_conflict', 'request_not_found', 'requests_unavailable'])

/** A refused call in the person's words: the ones this feature knows, else `fallback` or the API's own text. */
export function visitErrorText(error: unknown, fallback?: string) {
  const code = apiErrorCode(error)
  return code && KNOWN_ERRORS.has(code) ? t(`visitRequests.errors.${code}`) : fallback ?? apiErrorReason(error)
}

/**
 * One click on a request: approve, decline, cancel, keep or discard. There is
 * no second confirmation; the floating toast names the request and links to it,
 * and 等你拍板 reads again whatever the answer.
 */
export function useVisitDecision() {
  const store = useConsoleStore()
  const awaiting = useVisitAwaiting()
  const busy = ref<VisitAction | ''>('')

  async function decide(request: Pick<VisitRequest, 'id' | 'title'>, action: VisitAction, reason?: string) {
    if (busy.value) return null
    busy.value = action
    try {
      const { request: moved, warning } = await decideVisitRequest(request.id, action, reason)
      const done = t(`visitRequests.done.${action}`, { title: request.title })
      store.notify(warning ? `${done} ${warningText(warning)}` : done, { to: visitRequestLocation(request.id) })
      return moved
    } catch (error) {
      store.reportError(new Error(visitErrorText(error)))
      return null
    } finally {
      busy.value = ''
      void awaiting.load()
    }
  }
  return { busy, decide }
}
