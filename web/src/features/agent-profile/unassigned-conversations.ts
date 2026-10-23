import { ApiError, postJson } from '@/api/client'
import { shortUniqueIds } from '@/lib/short-ids'

export const ASSISTANT_AGENT_ID = 'employee.assistant'

export type UnassignedTriageStatus = 'pending' | 'needs_project' | 'assign_project' | 'one_off'

export interface RawConversationTriage {
  kind?: 'project' | 'topic' | 'one_off' | string | null
  personal_project_id?: string | null
  personalProjectId?: string | null
  topic?: string | null
  source?: 'host' | 'user' | string | null
  labeled_at?: string | null
  formed_project_id?: string | null
  formedProjectId?: string | null
}

interface RawConversationRecord {
  id?: string
  conversation_id?: string
  conversationId?: string
  title?: string | null
  summary?: string | null
  status?: string | null
  last_activity?: string | null
  startedAt?: string | null
  updatedAt?: string | null
  triage?: RawConversationTriage | null
  metadata?: {
    openingLine?: string | null
    jefaTriage?: string | null
    formedProjectId?: string | null
  } | null
}

export interface UnassignedConversationItem {
  conversationId: string
  // Readable text only; empty when the conversation has none (never its ID).
  openingLine: string
  // A short, collision-free ID to tell untitled conversations apart.
  shortId: string
  startedAt: string | null
  triageStatus: UnassignedTriageStatus
  topic: string | null
  suggestedProjectId: string | null
}

function isResolvedConversation(raw: RawConversationRecord): boolean {
  const triage = raw.triage
  if (triage?.formed_project_id || triage?.formedProjectId || raw.metadata?.formedProjectId) return true
  if (triage?.source === 'user' && (triage.kind === 'project' || triage.kind === 'one_off')) return true
  if (raw.metadata?.jefaTriage === 'one_off' || raw.metadata?.jefaTriage === 'assigned') return true
  return false
}

function resolveTriageStatus(raw: RawConversationRecord): UnassignedTriageStatus {
  const kind = raw.triage?.kind ?? raw.metadata?.jefaTriage
  if (kind === 'topic' || kind === 'needs_project') return 'needs_project'
  if (kind === 'project' || kind === 'assign_project') return 'assign_project'
  if (kind === 'one_off') return 'one_off'
  return 'pending'
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function readableLine(value: string | null | undefined, conversationId: string): string {
  const line = firstLine(value)
  return line && line !== conversationId && !UUID.test(line) ? line : ''
}

function firstLine(value: string | null | undefined): string {
  if (!value) return ''
  return value.split(/\r?\n/)[0]?.trim() ?? ''
}

// items: the conversations still to label. resolvedIds: those the same read
// shows a person or a formed topic already labeled, so a link to one can say so.
export async function readUnassignedConversations(personalSpaceId: string): Promise<{ items: UnassignedConversationItem[]; resolvedIds: string[] }> {
  if (!personalSpaceId) return { items: [], resolvedIds: [] }
  try {
    const response = await postJson<{ conversations?: RawConversationRecord[] }>('/api/agent-conversations/query', {
      personalSpaceId,
      personalProjectId: null,
      agentId: ASSISTANT_AGENT_ID,
      mode: 'list',
      limit: 50,
    })
    const rows = Array.isArray(response?.conversations) ? response.conversations : []
    const items = rows
      .filter((row) => !isResolvedConversation(row))
      .map((row) => {
        const conversationId = String(row.conversationId ?? row.conversation_id ?? row.id ?? '')
        const openingLine = readableLine(row.metadata?.openingLine, conversationId)
          || readableLine(row.title, conversationId)
          || readableLine(row.summary, conversationId)
        return {
          conversationId,
          openingLine,
          shortId: conversationId,
          startedAt: row.startedAt ?? row.last_activity ?? row.updatedAt ?? null,
          triageStatus: resolveTriageStatus(row),
          topic: row.triage?.topic ?? null,
          suggestedProjectId: row.triage?.personal_project_id ?? row.triage?.personalProjectId ?? null,
        }
      })
      .filter((item) => Boolean(item.conversationId))
    const shortIds = shortUniqueIds(items.map(item => item.conversationId))
    return { items: items.map(item => ({ ...item, shortId: shortIds.get(item.conversationId) ?? item.conversationId })),
      resolvedIds: rows.filter(isResolvedConversation).map(row => String(row.conversationId ?? row.conversation_id ?? row.id ?? '')).filter(Boolean) }
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { items: [], resolvedIds: [] }
    throw error
  }
}

export async function triageUnassignedConversation(input: {
  personalSpaceId: string
  conversationId: string
  kind: 'project' | 'topic' | 'one_off'
  personalProjectId?: string | null
  topic?: string | null
}) {
  return postJson('/api/conversation-triage/record', {
    personalSpaceId: input.personalSpaceId,
    conversationId: input.conversationId,
    kind: input.kind,
    personalProjectId: input.kind === 'project' ? (input.personalProjectId ?? null) : null,
    topic: input.kind === 'topic' ? (input.topic ?? null) : null,
    source: 'user',
  })
}
