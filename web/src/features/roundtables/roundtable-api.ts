import { getJson } from '@/api/client'

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
}
export interface RoundtableThread { id: string; subject: string; projectId: string | null; createdAt: string; messages: RoundtableMessage[] }

export const listThreads = () => getJson<{ threads: RoundtableThreadSummary[] }>('/api/roundtable/threads')
export const readThread = (id: string) => getJson<RoundtableThread>(`/api/roundtable/threads/${encodeURIComponent(id)}`)

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

export const listChats = () => getJson<{ chats: RoundtableChatRoom[]; hasMore: boolean; remoteUnavailable?: string }>('/api/roundtable/chats')
export const readChat = (id: string, after = 0) =>
  getJson<RoundtableChatPage>(`/api/roundtable/chats/${encodeURIComponent(id)}?after=${after}&limit=100`)
