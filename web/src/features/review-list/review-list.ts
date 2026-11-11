import { confirmationActorLabel, knowledgeReviewState, personalProjectIdForItem } from '@/features/knowledge/model'
import type { KnowledgeItem } from '@/types'

/**
 * 待决策 as one list (rec#96): what waits for the person, each item one line,
 * grouped by why it waits. Built from reads that already exist — the pending
 * knowledge items, Tonborg's delegated decisions and questions — so there is no
 * second queue to drift from the first.
 */

export type ReviewGuess = 'keep' | 'drop' | 'edit'
/** Why a knowledge item still waits, in the few words the list uses. */
export type WaitReason = 'unreviewed' | 'tonborg_reviewed' | 'tonborg_unsure' | 'conflict' | 'attention' | 'basis_changed'

/** One of Tonborg's delegated reviews, as /api/judgment/delegated lists it. */
export interface DelegatedReview {
  id: string
  createdAt: string
  personalProjectId: string | null
  target: string
  title: string | null
  summary: string
  confidence: number | null
  guess: ReviewGuess | null
  question: string | null
  feedbackRevision: number
  /** A question's one plain sentence, as the server words it for the console's language. */
  ask?: string
  /** Its two choices: Tonborg's guess first, the opposite second. */
  answers?: ReviewGuess[]
}
export interface DelegatedReviews { confirmed: DelegatedReview[]; questions: DelegatedReview[] }

export interface ReviewLine {
  key: string
  item: KnowledgeItem | null
  text: string
  projectId: string | null
  proposer: string
  reason: WaitReason | null
  /** Tonborg's review behind this line: its question, or the confirmation it made. */
  review: DelegatedReview | null
}
/** echoes: earlier Agent replies FULI kept by mistake (the server finds them), in their own group. */
export interface ReviewList { echoes: ReviewLine[]; questions: ReviewLine[]; pending: ReviewLine[]; confirmed: ReviewLine[] }

/** The cap on one line of visible copy; the whole text is in 查看详情. */
export const LINE_LIMIT = 100

export function oneLine(text: string, limit = LINE_LIMIT) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

export const itemKey = (item: Pick<KnowledgeItem, 'itemKind' | 'id'>) => `${item.itemKind}:${item.id}`

/** The project an item belongs to, or null for knowledge that holds everywhere. */
export function projectIdOf(item: KnowledgeItem) {
  return item.preferenceProjectId
    ?? personalProjectIdForItem(item)
    ?? item.evidence.find(evidence => evidence.personal_project_id)?.personal_project_id
    ?? item.inheritedProjectIds[0]
    ?? null
}

/** Who proposed it: the recorded proposer, else the client its source came from. */
// A recorded label that is only an internal id (an Agent's uuid) tells a person nothing.
const INTERNAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-|^[0-9a-f]{16,}$/i

export function proposerOf(item: KnowledgeItem) {
  const proposer = item.confirmationBasis?.proposed_by
  if (proposer) return confirmationActorLabel(proposer.label && INTERNAL_ID.test(proposer.label) ? { ...proposer, label: '' } : proposer)
  return item.evidence.find(evidence => evidence.source_application)?.source_application ?? confirmationActorLabel(null)
}

export function waitReason(item: KnowledgeItem): WaitReason {
  if (item.conflicts.length) return 'conflict'
  if (item.raw.requires_attention === true) return 'attention'
  if (item.waitsForReview) return 'basis_changed'
  if (knowledgeReviewState(item) === 'ai_reviewed') return 'tonborg_reviewed'
  return 'unreviewed'
}

/** A current item no one has confirmed: neither the person nor an Agent. */
export function waitsForPerson(item: KnowledgeItem) {
  if (item.invalidAt || item.replacedByItemId) return false
  const state = knowledgeReviewState(item)
  return state === 'pending' || state === 'ai_reviewed'
}

function line(item: KnowledgeItem, review: DelegatedReview | null, reason: WaitReason | null = waitReason(item)): ReviewLine {
  return { key: itemKey(item), item, text: oneLine(item.title && item.body && item.title !== item.body
    ? `${item.title}：${item.body}` : item.body || item.title),
  projectId: projectIdOf(item), proposer: proposerOf(item), reason, review }
}

/**
 * The earlier Agent replies among the pending items (echoKeys, as itemKey
 * names them), Tonborg's questions about the other items still pending (one it
 * asked about an item the person handled elsewhere is not asked again), every
 * other pending item, and the items Tonborg confirmed that the person has not
 * looked at yet.
 */
export function buildReviewList(items: KnowledgeItem[], delegated: DelegatedReviews = { confirmed: [], questions: [] },
  echoKeys: ReadonlySet<string> = new Set()): ReviewList {
  const byKey = new Map(items.map(item => [itemKey(item), item]))
  const pendingNow = items.filter(waitsForPerson)
  const echoes = pendingNow.filter(item => echoKeys.has(itemKey(item))).map(item => line(item, null))
  const waiting = pendingNow.filter(item => !echoKeys.has(itemKey(item)))
  const asked = new Map(delegated.questions.map(review => [review.target, review]))
  const questions = waiting.filter(item => asked.has(itemKey(item))).map(item => line(item, asked.get(itemKey(item)) ?? null, 'tonborg_unsure'))
  const pending = waiting.filter(item => !asked.has(itemKey(item))).map(item => line(item, null))
  const confirmed = delegated.confirmed.flatMap((review) => {
    const item = byKey.get(review.target)
    // Still Tonborg's confirmation: one the person changed since is theirs now.
    if (item && knowledgeReviewState(item) !== 'agent_confirmed') return []
    return [item ? line(item, review, null) : { key: review.target, item: null, text: oneLine(review.title ?? review.target),
      projectId: review.personalProjectId, proposer: 'Tonborg', reason: null, review }]
  })
  return { echoes, questions, pending, confirmed }
}

export const reviewTotal = (list: ReviewList) => list.echoes.length + list.questions.length + list.pending.length

/** The person's answer to a line, as the vote on Tonborg's guess it is. */
export type ReviewAction = 'confirm' | 'drop' | 'edit'
const GUESSED: Record<ReviewGuess, ReviewAction> = { keep: 'confirm', drop: 'drop', edit: 'edit' }
export const guessedAction = (guess: ReviewGuess | null): ReviewAction | null => guess ? GUESSED[guess] : null
export const agreesWithGuess = (review: DelegatedReview | null, action: ReviewAction) =>
  Boolean(review?.guess && GUESSED[review.guess] === action)

/** What a question's row offers. */
export interface RowChoice {
  answer: ReviewGuess
  action: ReviewAction
  /** Which word names it: 原样保留 is the opposite of 改一下. */
  label: ReviewGuess | 'keepAsIs'
  /** Tonborg's guess: the filled button. */
  guessed: boolean
}
const EVERY_ANSWER: ReviewGuess[] = ['keep', 'drop', 'edit']
const choice = (answer: ReviewGuess, review: DelegatedReview, label: RowChoice['label'] = answer): RowChoice =>
  ({ answer, action: GUESSED[answer], label, guessed: review.guess === answer })

/**
 * A question's row (Jevons 11-11): two buttons, Tonborg's guess first and its
 * opposite second, in the same places on every row; the third way to answer
 * (rest) sits under 其他 with the person's own words.
 */
export function rowChoices(review: DelegatedReview): { choices: RowChoice[]; rest: RowChoice } {
  const [yes = 'keep', no = 'drop'] = review.answers ?? []
  const rest = EVERY_ANSWER.find(answer => answer !== yes && answer !== no) ?? 'edit'
  return { choices: [choice(yes, review), choice(no, review, yes === 'edit' && no === 'keep' ? 'keepAsIs' : no)], rest: choice(rest, review) }
}
