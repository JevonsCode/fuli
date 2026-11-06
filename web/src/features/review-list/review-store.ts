import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { apiErrorReason } from '@/api/client'
import { knowledgeItems } from '@/features/knowledge/model'
import { confirmKnowledgeItem } from '@/features/knowledge/useKnowledgeConfirm'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import type { KnowledgeItem } from '@/types'

import { dropKnowledgeItem, readDelegatedReviews, readSpaceKnowledge, undoTonborgReview, voteOnReview } from './review-api'
import {
  agreesWithGuess, buildReviewList, guessedAction, oneLine, reviewTotal,
  type DelegatedReviews, type ReviewAction, type ReviewLine,
} from './review-list'

const EMPTY: DelegatedReviews = { confirmed: [], questions: [] }
const TOAST_TEXT = 24

/**
 * What waits for the person in the active space (rec#96), read once for the
 * 待决策 page and the top bar's count. A pending action is kept per line, so
 * one indicator shows per operation and the rest of the list stays usable.
 */
export const useReviewList = defineStore('review-list', () => {
  const consoleStore = useConsoleStore()
  const spaceId = ref('')
  const items = ref<KnowledgeItem[]>([])
  const delegated = ref<DelegatedReviews>(EMPTY)
  const loaded = ref(false)
  const loading = ref(false)
  const error = ref('')
  /** The line key (or a whole group's name) whose action is pending, and which action. */
  const pending = ref<Record<string, ReviewAction | 'undo' | 'ack'>>({})
  let version = 0

  const list = computed(() => buildReviewList(items.value, delegated.value))
  const total = computed(() => reviewTotal(list.value))

  function setSpace(id: string) {
    if (spaceId.value === id) return
    version++
    spaceId.value = id; items.value = []; delegated.value = EMPTY
    loaded.value = false; error.value = ''; pending.value = {}
    if (id) void refresh()
  }

  async function refresh() {
    const space = spaceId.value
    if (!space) return
    const current = ++version
    loading.value = true
    try {
      // Tonborg's side is optional: without it the list still shows every pending item.
      const [graph, reviews] = await Promise.all([
        readSpaceKnowledge(space, () => current !== version),
        readDelegatedReviews(space).catch(() => EMPTY),
      ])
      if (current !== version || !graph) return
      items.value = knowledgeItems(graph)
      delegated.value = reviews
      loaded.value = true
      error.value = ''
    } catch (cause) {
      if (current === version) error.value = apiErrorReason(cause)
    } finally {
      if (current === version) loading.value = false
    }
  }

  async function guarded(key: string, action: ReviewAction | 'undo' | 'ack', work: () => Promise<void>) {
    if (pending.value[key]) return false
    pending.value = { ...pending.value, [key]: action }
    try {
      await work()
      return true
    } catch (cause) {
      consoleStore.reportError(new Error(apiErrorReason(cause)))
      return false
    } finally {
      const { [key]: _done, ...rest } = pending.value
      pending.value = rest
    }
  }

  // Answering a line Tonborg asked about is also the vote on its guess.
  async function vote(line: ReviewLine, action: ReviewAction) {
    if (!line.review || !line.review.question) return
    const agrees = agreesWithGuess(line.review, action)
    await voteOnReview(spaceId.value, line.review.id, agrees ? 'up' : 'down',
      agrees ? '' : t('reviewList.voteReason', { action: t(`reviewList.actions.${action}`) }), line.review.feedbackRevision)
  }

  async function apply(line: ReviewLine, action: Exclude<ReviewAction, 'edit'>) {
    const item = line.item
    if (!item) return
    if (action === 'confirm') await confirmKnowledgeItem(spaceId.value, line.projectId, item)
    else await dropKnowledgeItem(spaceId.value, line.projectId, item)
    await vote(line, action).catch(() => {})
    items.value = items.value.filter(candidate => candidate !== item)
  }

  /** 确认 or 不要 one line, with a toast naming it and linking to it. */
  async function act(line: ReviewLine, action: Exclude<ReviewAction, 'edit'>) {
    const done = await guarded(line.key, action, () => apply(line, action))
    if (done) consoleStore.notify(t(`reviewList.done.${action}`, { text: oneLine(line.text, TOAST_TEXT) }))
    return done
  }

  /** 改一下 is answered on the item's own page; the vote records what the person chose. */
  async function edit(line: ReviewLine) {
    await vote(line, 'edit').catch(() => {})
  }

  /** 全部确认 / 全按猜的办: one line after another, one toast for all of them. */
  async function actAll(group: 'pending' | 'questions') {
    const lines = list.value[group]
    let count = 0
    await guarded(group, 'confirm', async () => {
      for (const line of lines) {
        const action = group === 'questions' ? guessedAction(line.review?.guess ?? null) : 'confirm'
        // A guess to edit needs the person's own words; it stays in the list.
        if (action === 'confirm' || action === 'drop') { await apply(line, action); count++ }
      }
    })
    if (count) consoleStore.notify(t('reviewList.done.all', { count }))
    await refresh()
  }

  async function undo(line: ReviewLine) {
    const review = line.review
    if (!review) return
    const done = await guarded(line.key, 'undo', async () => {
      await undoTonborgReview(spaceId.value, review.id)
      await voteOnReview(spaceId.value, review.id, 'down', t('reviewList.undoReason'), review.feedbackRevision).catch(() => {})
    })
    if (done) {
      consoleStore.notify(t('reviewList.done.undo', { text: oneLine(line.text, TOAST_TEXT) }))
      await refresh()
    }
  }

  /** 都对: the person saw Tonborg's confirmations and agrees; they leave the list. */
  async function acknowledgeConfirmed() {
    const lines = list.value.confirmed
    const done = await guarded('confirmed', 'ack', async () => {
      for (const line of lines) if (line.review) await voteOnReview(spaceId.value, line.review.id, 'up', '', line.review.feedbackRevision)
    })
    if (done) delegated.value = { ...delegated.value, confirmed: [] }
  }

  return { spaceId, items, delegated, loaded, loading, error, pending, list, total,
    setSpace, refresh, act, edit, actAll, undo, acknowledgeConfirmed }
})
