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
