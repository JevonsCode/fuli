import { ref } from 'vue'

import { t } from '@/i18n'
import { editFailure, type EditFailure, type KnowledgeItemSummary, type RevisionResult } from './model'
import { reviseItem } from './quick-edit-api'

/**
 * One review action on the item page (D-20.7): send its PATCH body, show what
 * happened and tell the page, which reads the item again or moves to the new
 * version the action wrote.
 */
export function useRevisionAction(item: () => KnowledgeItemSummary, handlers: {
  done: (result: RevisionResult) => string | null
  failed: (reason: EditFailure) => void
}) {
  const pending = ref(false)
  const message = ref<{ kind: 'error' | 'status'; text: string } | null>(null)

  async function submit(body: object | null) {
    if (!body) return false
    pending.value = true
    message.value = null
    try {
      const text = handlers.done(await reviseItem(item(), body))
      if (text) message.value = { kind: 'status', text }
      return true
    } catch (error) {
      const failure = editFailure(error)
      message.value = { kind: 'error', text: failure === 'forbidden' ? t('knowledgeQuickEdit.forbidden')
        : failure === 'conflict' ? t('knowledgeQuickEdit.conflict') : String((error as Error).message) }
      handlers.failed(failure)
      return false
    } finally {
      pending.value = false
    }
  }

  return { pending, message, submit }
}
