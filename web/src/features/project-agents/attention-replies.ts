import { t } from '@/i18n'

export interface AttentionReplyChoice { id: string; label: string; value: string }
export interface AttentionReplyDraft { choice: string; text: string }
/** What the console sends; the server stores both as one response and hands both to the Agent. */
export interface AttentionAnswer { choice: string | null; note: string | null }
type AttentionDeliveryStatus = 'woken' | 'delivered' | 'inbox' | 'unavailable'
export interface AttentionDelivery { status: AttentionDeliveryStatus; agentId: string }

export const ATTENTION_REPLY_LIMIT = 4096

// Requests that ask the person to do a step by hand (log in, trust hooks) are
// answered with "Done", which means the step was done.
const KIND_REPLIES: Record<string, string[]> = {
  approval: ['agree', 'decline'], review: ['accept', 'revise'],
  permission: ['done', 'agree', 'decline'], blocked: ['done', 'clarify'], question: ['clarify'],
}

export function attentionReplies(item: { kind: string; requestedAction: string; options?: string[] | null }): AttentionReplyChoice[] {
  // The Agent's own choices come first: they are what it asked.
  if (item.options?.length) return item.options.map((value, index) => ({ id: `option-${index}`, label: value, value }))
  // Only explicit, consecutive A/B alternatives are converted to choices.
  // Numbered instructions and natural-language questions remain unchanged.
  const letters = item.requestedAction.split('\n').map(line => line.trim())
    .filter(line => /^[A-F][.、)）:：]\s*\S/.test(line))
  if (/(?:选择|选项|choose|select|options?|pick)/iu.test(item.requestedAction) && letters.length >= 2 && letters.every((line, index) => line[0] === String.fromCharCode(65 + index))) {
    return letters.map((value, index) => ({ id: `option-${index}`, label: value, value }))
  }
  return (KIND_REPLIES[item.kind] ?? ['clarify']).map(id => ({ id, label: t(`attention.replies.${id}`), value: t(`attention.replies.${id}`) }))
}

export function composeAttentionReply(choice: string, text: string, choices: AttentionReplyChoice[]): AttentionAnswer | null {
  const note = text.trim() || null
  if (choice === 'other') return note ? { choice: null, note } : null
  const selected = choices.find(item => item.id === choice)
  return selected ? { choice: selected.value, note } : null
}

/** Length of the response text the server stores (choice, blank line, note). */
export function attentionAnswerLength(answer: AttentionAnswer) {
  return [answer.choice, answer.note].filter(Boolean).join('\n\n').length
}
