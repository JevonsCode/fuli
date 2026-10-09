import { t } from '@/i18n'

export interface AttentionReplyChoice { id: string; label: string; value: string }
export interface AttentionReplyDraft { choice: string; text: string }

export function attentionReplies(item: { kind: string; requestedAction: string }): AttentionReplyChoice[] {
  // Only explicit, consecutive A/B alternatives are converted to choices.
  // Numbered instructions and natural-language questions remain unchanged.
  const letters = item.requestedAction.split('\n').map(line => line.trim())
    .filter(line => /^[A-F][.、)）:：]\s*\S/.test(line))
  if (/(?:选择|选项|choose|select|options?|pick)/iu.test(item.requestedAction) && letters.length >= 2 && letters.every((line, index) => line[0] === String.fromCharCode(65 + index))) {
    return letters.map((value, index) => ({ id: `option-${index}`, label: value, value }))
  }
  const keys: Record<string, string[]> = {
    approval: ['agree', 'decline'], review: ['accept', 'revise'],
    permission: ['agree', 'decline'], blocked: ['resolved', 'clarify'], question: ['clarify'],
  }
  return (keys[item.kind] ?? ['clarify']).map(id => ({ id, label: t(`attention.replies.${id}`), value: t(`attention.replies.${id}`) }))
}

export function composeAttentionReply(choice: string, text: string, choices: AttentionReplyChoice[]) {
  if (choice === 'other') return text.trim()
  const selected = choices.find(item => item.id === choice)
  return selected ? [selected.value, text.trim()].filter(Boolean).join('\n\n') : ''
}
