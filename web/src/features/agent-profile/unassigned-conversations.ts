import { ApiError, postJson } from '@/api/client'

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
  openingLine: string
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

function firstLine(value: string | null | undefined): string {
  if (!value) return ''
  return value.split(/\r?\n/)[0]?.trim() ?? ''
}

export async function readUnassignedConversations(personalSpaceId: string): Promise<UnassignedConversationItem[]> {
  if (!personalSpaceId) return []
  try {
    const response = await postJson<{ conversations?: RawConversationRecord[] }>('/api/agent-conversations/query', {
      personalSpaceId,
      personalProjectId: null,
      agentId: ASSISTANT_AGENT_ID,
      mode: 'list',
      limit: 50,
    })
    const rows = Array.isArray(response?.conversations) ? response.conversations : []
    return rows
      .filter((row) => !isResolvedConversation(row))
      .map((row) => {
        const conversationId = String(row.conversationId ?? row.conversation_id ?? row.id ?? '')
        const openingLine = firstLine(row.metadata?.openingLine)
          || firstLine(row.title)
          || firstLine(row.summary)
          || conversationId
        return {
          conversationId,
          openingLine,
          startedAt: row.startedAt ?? row.last_activity ?? row.updatedAt ?? null,
          triageStatus: resolveTriageStatus(row),
          topic: row.triage?.topic ?? null,
          suggestedProjectId: row.triage?.personal_project_id ?? row.triage?.personalProjectId ?? null,
        }
      })
      .filter((item) => Boolean(item.conversationId))
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return []
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
