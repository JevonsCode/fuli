import { getJson, postJson, putJson } from '@/api/client'

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
/** Who the person can start a conversation with (find_agents' local directory). */
export interface RoundtableDirectoryAgent { agentId: string; name: string; responsibility?: string | null; projects: string[] }

/** The latest 50 asks; the server returns no total or cursor for them. */
export const listThreads = (signal?: AbortSignal) => getJson<{ threads: RoundtableThreadSummary[] }>('/api/roundtable/threads', { signal })
export const readThread = (id: string, signal?: AbortSignal) =>
  getJson<RoundtableThread>(`/api/roundtable/threads/${encodeURIComponent(id)}`, { signal })
export const listDirectoryAgents = (signal?: AbortSignal) =>
  getJson<{ agents: RoundtableDirectoryAgent[] }>('/api/roundtable/agents', { signal })

export interface RoundtablePost { to?: string[]; body: string; mode?: RoundtableDelivery; projectId?: string }
/** The person's message: a new conversation without a thread, or the next post in one. */
export const postMessage = (threadId: string | null, post: RoundtablePost) => threadId
  ? postJson<RoundtableThread>(`/api/roundtable/threads/${encodeURIComponent(threadId)}/messages`, post)
  : postJson<RoundtableThread>('/api/roundtable/threads', post)
export const setThreadMode = (threadId: string, mode: RoundtableDelivery) =>
  putJson<RoundtableThread>(`/api/roundtable/threads/${encodeURIComponent(threadId)}/mode`, { mode })

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
  return getJson<RoundtableChatList>(`/api/roundtable/chats?${query}`, { signal })
}
/** Messages after a sequence number, in order: later messages, not older ones. */
export const readChat = (id: string, after = 0, signal?: AbortSignal) =>
  getJson<RoundtableChatPage>(`/api/roundtable/chats/${encodeURIComponent(id)}?after=${after}&limit=100`, { signal })

/** Appends a later page, keeping each message once and in sequence order. */
export function appendChatPage(current: RoundtableChatPage, next: RoundtableChatPage): RoundtableChatPage {
  const byId = new Map(current.messages.map(message => [message.messageId, message]))
  for (const message of next.messages) byId.set(message.messageId, message)
  return { ...next, messages: [...byId.values()].sort((a, b) => a.seq - b.seq) }
}
