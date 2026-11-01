import { ref } from 'vue'

import { patchJson } from '@/api/client'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import type { KnowledgeItem } from '@/types'
import { itemConfirmationBasis } from './model'
import { useKnowledgeWriteLifecycle } from './knowledge-write-lifecycle'

/**
 * 「确认这条偏好 / 知识」 in one click (Jevons 11-02): the person's own click in
 * the local console is the human confirmation, so no second dialog asks again.
 * It records the item's stored or source basis; correcting it stays one click
 * away and can confirm again. The result is a toast; on a failed write the
 * page reads again so the status shown is the server's.
 */
export function useKnowledgeConfirm(options: {
  personalSpaceId: () => string
  personalProjectId: (item: KnowledgeItem) => string | null
  accessDenied: () => void
  reload: () => unknown
}) {
  const store = useConsoleStore()
  const target = ref<KnowledgeItem | null>(null)
  let denied = false
  const { busy, locked, error, run } = useKnowledgeWriteLifecycle(
    () => target.value ? `${options.personalSpaceId()}:${target.value.itemKind}:${target.value.id}` : '',
    () => { denied = true; options.accessDenied() },
    () => [options.personalSpaceId(), target.value],
  )

  async function confirm(item: KnowledgeItem) {
    if (busy.value) return
    target.value = item
    denied = false
    if (locked.value) {
      store.reportError(new Error(t('preferences.detail.unconfirmed')))
      return
    }
    const personalSpaceId = options.personalSpaceId()
    const basis = itemConfirmationBasis(item)
    const subject = t(item.profileAspect ? 'knowledge.dialogs.confirm.preferenceSubject' : 'knowledge.dialogs.confirm.knowledgeSubject')
    let saved = false
    await run(() => patchJson(`/api/knowledge/${item.itemKind}/${encodeURIComponent(item.id)}`, {
      personalSpaceId,
      personalProjectId: options.personalProjectId(item),
      action: 'confirm',
      reason: t('knowledge.dialogs.confirm.confirmationReason'),
      confirmationStatus: 'confirmed',
      confirmationBasis: {
        ...basis,
        confirmedBy: { kind: 'user', label: t('knowledge.domain.actors.currentUser') },
        confirmedAt: new Date().toISOString(),
      },
    }), () => { saved = true })
    if (saved) store.notify(t('knowledge.dialogs.confirm.confirmed', { subject }))
    else if (error.value && !denied) store.reportError(new Error(error.value))
    // An unconfirmed result stays locked until a read shows the server's state.
    if (saved || locked.value) await options.reload()
  }

  return { confirm, confirming: busy }
}
