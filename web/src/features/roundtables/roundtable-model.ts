import type { RoundtableMessage, RoundtablePerson } from './roundtable-api'

/** Statuses after which an ask will not be answered by this delivery. */
const SETTLED = new Set(['answered', 'failed', 'cancelled', 'expired', 'unknown'])

export interface RoundtableExchange { ask: RoundtableMessage | null; replies: RoundtableMessage[] }
export interface RoundtableSeat { key: string; person: RoundtablePerson; spoke: number; awaited: boolean }

/**
 * Separate real two-way exchanges from one-way asks.
 * An ask belongs to the conversation only once a reply points at it; every
 * other ask is a pending (or closed, unanswered) request, kept for audit.
 */
export function splitThread(messages: RoundtableMessage[]) {
  const replies = new Map<string, RoundtableMessage[]>()
  const orphanReplies: RoundtableMessage[] = []
  const askIds = new Set(messages.filter(message => message.kind === 'ask').map(message => message.id))
  for (const message of messages) {
    if (message.kind !== 'reply') continue
    if (message.inReplyTo && askIds.has(message.inReplyTo)) {
      replies.set(message.inReplyTo, [...(replies.get(message.inReplyTo) ?? []), message])
    } else {
      orphanReplies.push(message)
    }
  }
  const exchanges: RoundtableExchange[] = []
  const pending: RoundtableMessage[] = []
  const unanswered: RoundtableMessage[] = []
  for (const message of messages) {
    if (message.kind !== 'ask') continue
    const answers = replies.get(message.id)
    if (answers?.length) exchanges.push({ ask: message, replies: answers })
    else if (SETTLED.has(message.status)) unanswered.push(message)
    else pending.push(message)
  }
  for (const reply of orphanReplies) exchanges.push({ ask: null, replies: [reply] })
  return { exchanges, pending, unanswered }
}

const keyOf = (person: RoundtablePerson) => person.agentId ?? person.name ?? ''

/** Everyone at the table, in first-appearance order, with how often they spoke. */
export function tableSeats(messages: RoundtableMessage[], pending: RoundtableMessage[]): RoundtableSeat[] {
  const seats = new Map<string, RoundtableSeat>()
  for (const message of messages) {
    for (const person of [message.from, message.to]) {
      const key = keyOf(person)
      if (key && !seats.has(key)) seats.set(key, { key, person, spoke: 0, awaited: false })
    }
    const speaker = seats.get(keyOf(message.from))
    if (speaker) speaker.spoke += 1
  }
  for (const ask of pending) {
    const seat = seats.get(keyOf(ask.to))
    if (seat) seat.awaited = true
  }
  return [...seats.values()]
}

/** A chat room's name: its title, or for an untitled room the members' names. */
export function chatRoomName(room: { title: string | null; members: { name: string | null; address: string }[] }) {
  return room.title?.trim() || room.members.map(member => member.name ?? member.address).join(' · ')
}
