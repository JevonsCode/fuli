import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { ApiError, apiErrorReason } from '@/api/client'
import { knowledgeItems } from '@/features/knowledge/model'
import { confirmKnowledgeItem } from '@/features/knowledge/useKnowledgeConfirm'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import type { KnowledgeItem } from '@/types'

import {
  CONFIRM_BATCH, confirmReviewBatch, dropKnowledgeItem, readDelegatedReviews, readSpaceKnowledge, undoTonborgReview, voteOnReview,
} from './review-api'
import {
  agreesWithGuess, buildReviewList, guessedAction, oneLine, reviewTotal,
  type DelegatedReviews, type ReviewAction, type ReviewLine,
} from './review-list'

const EMPTY: DelegatedReviews = { confirmed: [], questions: [] }
const TOAST_TEXT = 24
/** Votes on Tonborg's guesses sent at once after a whole group is handled. */
const VOTES_AT_ONCE = 4

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
  /** How far a whole group's action got, counted from the requests that came back. */
  const progress = ref<Record<string, { done: number; total: number }>>({})
  let version = 0

  const list = computed(() => buildReviewList(items.value, delegated.value))
  const total = computed(() => reviewTotal(list.value))

  function setSpace(id: string) {
    if (spaceId.value === id) return
    version++
    spaceId.value = id; items.value = []; delegated.value = EMPTY
    loaded.value = false; error.value = ''; pending.value = {}; progress.value = {}
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

  /**
   * Tonborg reviews on its own schedule, so its questions can arrive after the
   * page read the list (Jevons 11-06 saw none of them). Its small list is read
   * again, and the items only when that list changed.
   */
  async function refreshIfTonborgMoved() {
    const space = spaceId.value
    if (!space || !loaded.value || loading.value || Object.keys(pending.value).length) return
    const reviews = await readDelegatedReviews(space).catch(() => null)
    if (!reviews || space !== spaceId.value) return
    const ids = (value: DelegatedReviews) => [...value.questions, ...value.confirmed].map(review => review.id).sort().join()
    if (ids(reviews) !== ids(delegated.value)) await refresh()
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

  /** The lines leave the list together: one change, one list animation. */
  function leave(lines: ReviewLine[]) {
    const gone = new Set(lines.map(line => line.item))
    if (gone.size) items.value = items.value.filter(candidate => !gone.has(candidate))
  }

  /**
   * Confirms up to CONFIRM_BATCH lines in one request. If the batch is refused
   * because one item moved since the list read it, each line goes on its own,
   * so the rest are still confirmed; the lines that went through are returned.
   */
  async function confirmBatch(lines: ReviewLine[]) {
    if (lines.length > 1) {
      try {
        await confirmReviewBatch(spaceId.value, lines.map(line => line.item!))
        return lines
      } catch (cause) {
        if (!(cause instanceof ApiError) || cause.status !== 409) throw cause
      }
    }
    const confirmed: ReviewLine[] = []
    for (const line of lines) {
      try {
        await confirmKnowledgeItem(spaceId.value, line.projectId, line.item!)
        confirmed.push(line)
      } catch { /* it stays in the list; the read after says why */ }
    }
    return confirmed
  }

  /**
   * 全部确认 / 全按猜的办 (Jevons 11-06): confirmations go in batches of one
   * transaction each, the progress counts what came back, the handled lines
   * leave once per batch, and one toast names the result at the end.
   */
  async function actAll(group: 'pending' | 'questions') {
    const chosen = list.value[group].filter(line => line.item).map(line => ({
      line, action: group === 'questions' ? guessedAction(line.review?.guess ?? null) : 'confirm' as ReviewAction,
    }))
    // A guess to edit needs the person's own words; it stays in the list.
    const confirms = chosen.filter(({ action }) => action === 'confirm').map(({ line }) => line)
    const drops = chosen.filter(({ action }) => action === 'drop').map(({ line }) => line)
    const total = confirms.length + drops.length
    if (!total) return
    let handled: ReviewLine[] = []
    let failed = 0
    const advance = (done: ReviewLine[], tried: number) => {
      handled = handled.concat(done); failed += tried - done.length
      progress.value = { ...progress.value, [group]: { done: handled.length + failed, total } }
      leave(done)
    }
    progress.value = { ...progress.value, [group]: { done: 0, total } }
    const finished = await guarded(group, 'confirm', async () => {
      for (let start = 0; start < confirms.length; start += CONFIRM_BATCH) {
        const batch = confirms.slice(start, start + CONFIRM_BATCH)
        advance(await confirmBatch(batch), batch.length)
      }
      for (const line of drops) {
        const done = await dropKnowledgeItem(spaceId.value, line.projectId, line.item!).then(() => true, () => false)
        advance(done ? [line] : [], 1)
      }
      // Answering Tonborg's questions is also the vote on each guess.
      const asked = handled.filter(line => line.review?.question)
      for (let start = 0; start < asked.length; start += VOTES_AT_ONCE) {
        await Promise.all(asked.slice(start, start + VOTES_AT_ONCE).map(line =>
          vote(line, drops.includes(line) ? 'drop' : 'confirm').catch(() => {})))
      }
    })
    const { [group]: _finished, ...rest } = progress.value
    progress.value = rest
    // A failed request already showed its error; a read then shows what the server kept.
    if (!finished) return refresh()
    if (failed) {
      consoleStore.notify(t('reviewList.done.partial', { count: handled.length, failed }))
      await refresh()
    } else consoleStore.notify(t(`reviewList.done.${group === 'pending' ? 'confirmedAll' : 'all'}`, { count: handled.length }), { to: '/knowledge' })
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

  return { spaceId, items, delegated, loaded, loading, error, pending, progress, list, total,
    setSpace, refresh, refreshIfTonborgMoved, act, edit, actAll, undo, acknowledgeConfirmed }
})
