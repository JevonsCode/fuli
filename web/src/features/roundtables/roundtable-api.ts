import { z } from 'zod'
import { getJson, postJson, putJson } from '@/api/client'
import { shapeFor } from '@/api/response-shape'

export interface RoundtablePerson { agentId: string | null; name: string | null; client: string | null }
export interface RoundtableThreadSummary {
  id: string
  subject: string
  projectId: string | null
  updatedAt: string
  messageCount: number
  participants: RoundtablePerson[]
  waiting: boolean
  /** Recipients of asks still open; absent from older servers. */
  waitingFor?: string[]
  /** How the person's own conversation delivers; null for a thread only Agents wrote. Absent from older servers. */
  mode?: RoundtableDelivery | null
  /** An Agent is answering an ask in this thread right now. Absent from older servers. */
  replying?: boolean
  last: { from: string | null; body: string } | null
}
export interface RoundtableMessage {
  id: string
  kind: 'ask' | 'reply'
  status: string
  body: string
  inReplyTo: string | null
  via: string | null
  error: string | null
  createdAt: string
  from: RoundtablePerson
  to: RoundtablePerson
  /** Present when a wake left process cleanup unconfirmed; never inferred as clean. */
  cleanup?: { status: string; code?: string | null } | null
}
/** board: a post waits until the FLA next works; instant: a post wakes the FLA at once. */
export type RoundtableDelivery = 'board' | 'instant'
/** An FLA subscribed to the person's conversation; instantBlocked says why it cannot be woken at once. */
export interface RoundtableSubscriber { agentId: string; name: string | null; delivery: RoundtableDelivery; instantBlocked: string | null }
export interface RoundtableThread {
  id: string
  subject: string
  projectId: string | null
  createdAt: string
  messages: RoundtableMessage[]
  /** The person's own conversation: null and empty for threads only Agents wrote. Absent from older servers. */
  mode?: RoundtableDelivery | null
  subscribers?: RoundtableSubscriber[]
}

// What the conversations page reads (src/agent-roundtable/http.js, packages/roundtable/src/roundtable/service.js).
// The unions stay with the interfaces above, so a kind or status is checked as
// text. People are nullable because an Agent or session may be unnamed; fields
// the server added later (waitingFor, mode, subscribers, cleanup) may be absent.
const personSchema = z.looseObject({ agentId: z.string().nullish(), name: z.string().nullish(), client: z.string().nullish() })
const summarySchema = z.looseObject({
  id: z.string(), subject: z.string(), updatedAt: z.string(), participants: z.array(personSchema),
  waiting: z.boolean(), waitingFor: z.array(z.string()).nullish(), mode: z.string().nullish(), replying: z.boolean().nullish(),
  last: z.looseObject({ from: z.string().nullish(), body: z.string() }).nullish(),
})
const messageSchema = z.looseObject({
  id: z.string(), kind: z.string(), status: z.string(), body: z.string(), via: z.string().nullish(), error: z.string().nullish(),
  createdAt: z.string(), from: personSchema, to: personSchema,
  cleanup: z.looseObject({ status: z.string(), code: z.string().nullish() }).nullish(),
})
const threadSchema = z.looseObject({
  id: z.string(), subject: z.string(), createdAt: z.string(), messages: z.array(messageSchema),
  mode: z.string().nullish(),
  subscribers: z.array(z.looseObject({
    agentId: z.string(), name: z.string().nullish(), delivery: z.string(), instantBlocked: z.string().nullish(),
  })).nullish(),
})
const threadsShape = shapeFor<{ threads: RoundtableThreadSummary[] }>(z.looseObject({ threads: z.array(summarySchema) }))
const threadShape = shapeFor<RoundtableThread>(threadSchema)
const memberSchema = z.looseObject({ address: z.string(), agentId: z.string().nullish(), name: z.string().nullish() })
const roomSchema = z.looseObject({
  chatId: z.string(), kind: z.string(), title: z.string().nullish(), members: z.array(memberSchema), createdAt: z.string(),
})
const chatListShape = shapeFor<RoundtableChatList>(z.looseObject({
  chats: z.array(roomSchema), hasMore: z.boolean(), nextChat: z.string().nullish(),
  remotePage: z.looseObject({ hasMore: z.boolean(), nextChat: z.string().nullish() }).nullish(),
  remoteUnavailable: z.string().nullish(),
}))
const chatPageShape = shapeFor<RoundtableChatPage>(roomSchema.extend({
  messages: z.array(z.looseObject({ messageId: z.string(), seq: z.number(), from: z.string(), body: z.string(), createdAt: z.string() })),
  nextAfter: z.number(), hasMore: z.boolean(),
}))

/** The latest 50 asks; the server returns no total or cursor for them. */
export const listThreads = (signal?: AbortSignal) => getJson('/api/roundtable/threads', threadsShape, { signal })
export const readThread = (id: string, signal?: AbortSignal) =>
  getJson(`/api/roundtable/threads/${encodeURIComponent(id)}`, threadShape, { signal })

export interface RoundtablePost { to?: string[]; body: string; mode?: RoundtableDelivery }
/** The person's next post in a conversation; Agents open conversations from their own chats. */
export const postMessage = (threadId: string, post: RoundtablePost) =>
  postJson(`/api/roundtable/threads/${encodeURIComponent(threadId)}/messages`, post, threadShape)
export const setThreadMode = (threadId: string, mode: RoundtableDelivery) =>
  putJson(`/api/roundtable/threads/${encodeURIComponent(threadId)}/mode`, { mode }, threadShape)

/** An Agent chat room (agent_chat): 1:1 or a group, read-only for people. */
export interface RoundtableChatMember { address: string; agentId: string | null; name: string | null; node?: string; joinedSeq: number }
export interface RoundtableChatRoom {
  chatId: string
  kind: 'direct' | 'group'
  title: string | null
  members: RoundtableChatMember[]
  transport: string
  createdAt: string
  updatedAt: string
}
export interface RoundtableChatMessage { messageId: string; seq: number; from: string; body: string; createdAt: string }
export interface RoundtableChatPage extends RoundtableChatRoom { messages: RoundtableChatMessage[]; nextAfter: number; hasMore: boolean }

export interface RoundtableChatList {
  chats: RoundtableChatRoom[]
  hasMore: boolean
  nextChat?: string | null
  /** The other computer's rooms page separately, with their own cursor. */
  remotePage?: { hasMore: boolean; nextChat: string | null }
  remoteUnavailable?: string
}

// Without a transport the server merges the first local and remote pages; a
// later page names its transport so the two cursors never cross.
export function listChats(options: { transport?: 'local' | 'peer'; afterChat?: string } = {}, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: '50' })
  if (options.transport) query.set('transport', options.transport)
  if (options.afterChat) query.set('afterChat', options.afterChat)
  return getJson(`/api/roundtable/chats?${query}`, chatListShape, { signal })
}
/** Messages after a sequence number, in order: later messages, not older ones. */
export const readChat = (id: string, after = 0, signal?: AbortSignal) =>
  getJson(`/api/roundtable/chats/${encodeURIComponent(id)}?after=${after}&limit=100`, chatPageShape, { signal })

/** Appends a later page, keeping each message once and in sequence order. */
export function appendChatPage(current: RoundtableChatPage, next: RoundtableChatPage): RoundtableChatPage {
  const byId = new Map(current.messages.map(message => [message.messageId, message]))
  for (const message of next.messages) byId.set(message.messageId, message)
  return { ...next, messages: [...byId.values()].sort((a, b) => a.seq - b.seq) }
}
