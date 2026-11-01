import type { RoundtableMessage, RoundtablePerson, RoundtableThread, RoundtableThreadSummary } from './roundtable-api'

/** Statuses after which an ask will not be answered by this delivery. */
const SETTLED = new Set(['answered', 'failed', 'cancelled', 'expired', 'unknown'])
/** The client recorded for the person's own messages from the console. */
export const PERSON_CLIENT = 'person'
export const isPerson = (person: RoundtablePerson) => person.client === PERSON_CLIENT

/**
 * Where one message stands for one recipient, from the recorded state only:
 * replying (a run is going), waking (instant, the run is about to start),
 * board (waits for the recipient's next work), held (could not be woken; it
 * waits on the board with the reason), failed, answered, or another recorded status.
 */
export type DeliveryState =
  | { kind: 'answered' | 'replying' | 'waking' | 'board' }
  | { kind: 'held' | 'failed'; reason: string | null }
  | { kind: 'status'; status: string }

export interface ChatDelivery { messageId: string; to: RoundtablePerson; state: DeliveryState }
export interface ChatBubble {
  id: string
  from: RoundtablePerson
  body: string
  createdAt: string
  mine: boolean
  kind: RoundtableMessage['kind']
  via: string | null
  /** One per recipient of an ask; a group post has several. Replies have none. */
  deliveries: ChatDelivery[]
  cleanup: RoundtableMessage['cleanup']
}
export interface RoundtableSeat { key: string; person: RoundtablePerson; spoke: number; awaited: boolean }

function deliveryState(message: RoundtableMessage, instant: boolean): DeliveryState {
  if (message.status === 'answered') return { kind: 'answered' }
  if (message.status === 'delivering') return { kind: 'replying' }
  if (message.status === 'queued') return message.error ? { kind: 'held', reason: message.error } : { kind: instant ? 'waking' : 'board' }
  if (message.status === 'failed') return { kind: 'failed', reason: message.error }
  return { kind: 'status', status: message.status }
}

/**
 * The thread as a chat: one bubble per message, in order. The person's post to
 * several FLAs is stored as one ask per recipient; it shows as one bubble with
 * each recipient's own delivery state.
 */
export function chatBubbles(thread: Pick<RoundtableThread, 'messages' | 'subscribers'>): ChatBubble[] {
  const instant = new Set((thread.subscribers ?? []).filter(item => item.delivery === 'instant').map(item => item.agentId))
  const bubbles: ChatBubble[] = []
  for (const message of thread.messages) {
    const mine = isPerson(message.from)
    const delivery = message.kind === 'ask'
      ? [{ messageId: message.id, to: message.to, state: deliveryState(message, mine && instant.has(message.to.agentId ?? '')) }] : []
    const previous = bubbles.at(-1)
    if (mine && message.kind === 'ask' && previous?.mine && previous.kind === 'ask' && previous.body === message.body
      && !previous.deliveries.some(item => item.to.agentId === message.to.agentId)) {
      previous.deliveries.push(...delivery)
      continue
    }
    bubbles.push({ id: message.id, from: message.from, body: message.body, createdAt: message.createdAt, mine, kind: message.kind,
      via: message.via, deliveries: delivery, cleanup: message.cleanup })
  }
  return bubbles
}

/** True while a recorded run or wake is under way, so the page reads it more often. */
export const deliveryInFlight = (bubbles: ChatBubble[]) =>
  bubbles.some(bubble => bubble.deliveries.some(item => ['replying', 'waking'].includes(item.state.kind)))

const keyOf = (person: RoundtablePerson) => person.agentId ?? person.name ?? ''

/** Every Agent at the table, in first-appearance order, with how often they spoke. */
export function tableSeats(messages: RoundtableMessage[]): RoundtableSeat[] {
  const seats = new Map<string, RoundtableSeat>()
  for (const message of messages) {
    for (const person of [message.from, message.to]) {
      const key = keyOf(person)
      if (key && !isPerson(person) && !seats.has(key)) seats.set(key, { key, person, spoke: 0, awaited: false })
    }
    const speaker = seats.get(keyOf(message.from))
    if (speaker) speaker.spoke += 1
  }
  for (const ask of messages) {
    if (ask.kind !== 'ask' || SETTLED.has(ask.status)) continue
    const seat = seats.get(keyOf(ask.to))
    if (seat) seat.awaited = true
  }
  return [...seats.values()]
}

/**
 * Who the person's next post goes to: the thread's subscribers, or, in a thread
 * only Agents wrote, the local FLAs at the table (never a remote device's Agent).
 */
export function postRecipients(thread: Pick<RoundtableThread, 'messages' | 'subscribers'>): { agentId: string; name: string }[] {
  if (thread.subscribers?.length) return thread.subscribers.map(item => ({ agentId: item.agentId, name: item.name ?? item.agentId }))
  const local = new Map<string, string>()
  for (const message of thread.messages) {
    for (const person of [message.from, message.to]) {
      if (person.agentId && !isPerson(person) && !person.agentId.startsWith('peer:') && !local.has(person.agentId)) {
        local.set(person.agentId, person.name ?? person.agentId)
      }
    }
  }
  return [...local].map(([agentId, name]) => ({ agentId, name }))
}

/** A chat room's name: its title, or for an untitled room the members' names. */
export function chatRoomName(room: { title: string | null; members: { name: string | null; address: string }[] }) {
  return room.title?.trim() || room.members.map(member => member.name ?? member.address).join(' · ')
}

/** How a conversation in the list delivers a post: it wakes the Agent now, or waits on the board for its next work. */
export type ConversationDelivery = 'instant' | 'board'

/**
 * The person's own conversation delivers as its subscribers do. A thread only
 * Agents wrote is instant (message_agent wakes the recipient), and so is an
 * Agent chat room (agent_chat wakes its members).
 */
export const threadDelivery = (thread: Pick<RoundtableThreadSummary, 'mode'>): ConversationDelivery =>
  thread.mode === 'board' ? 'board' : 'instant'
