// How a conversation reads like Messages: a centred time between messages far
// apart, and one name and portrait per run of messages from the same sender.
export const SEPARATOR_GAP_MS = 30 * 60_000
export const RUN_GAP_MS = 5 * 60_000

export interface ChatRunMark {
  /** Show the time centred above this message. */
  separator: boolean
  /** This message starts a sender's run: show its name and portrait. */
  runStart: boolean
}

const when = (value: string) => {
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : time
}

export function chatRunMarks(messages: readonly { from: string; at: string }[]): ChatRunMark[] {
  return messages.map((message, index) => {
    const previous = messages[index - 1]
    if (!previous) return { separator: true, runStart: true }
    const now = when(message.at)
    const before = when(previous.at)
    const gap = now === null || before === null ? Number.POSITIVE_INFINITY : now - before
    const separator = gap >= SEPARATOR_GAP_MS
    return { separator, runStart: separator || message.from !== previous.from || gap >= RUN_GAP_MS }
  })
}
