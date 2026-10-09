export type RoundtableRuntime = 'mcp' | 'codex' | 'claude-code' | 'pi' | 'grok' | 'a2a'
export type RoundtableRole = 'moderator' | 'specialist' | 'implementer' | 'reviewer'
export type RoundtableTime = string | number
export interface RoundtableSeat {
  id: string; name: string; role: RoundtableRole; runtime: RoundtableRuntime
  joinedAt?: RoundtableTime | null; revokedAt?: RoundtableTime | null; status?: string
  sourceApplication?: string | null; sourceSessionId?: string | null
  identityKind?: 'standalone' | 'fuli'
  execution?: { permission: 'read-only' | 'workspace-write'; workspace: string | null }
}
export interface RoundtableLimits { maxRounds: number; maxMessages: number; maxDurationMs: number; turnTimeoutMs: number }
export interface RoundtableRoom {
  id: string; goal: string; mode: 'discussion' | 'collaboration'; seats: RoundtableSeat[]
  status: string; phase: string; revision: number; limits: RoundtableLimits
  round?: number; phaseIndex?: number; agentMessageCount?: number; createdAt: RoundtableTime; startedAt?: RoundtableTime; updatedAt?: RoundtableTime
  stopReason?: string | null; binding?: { personalSpaceId: string; projectId: string; coordinatedTaskId: string } | null
  scope?: { kind: string; projectPath?: string; [key: string]: unknown }
}
export interface RoundtableActual {
  sourceApplication?: string | null; model?: string | null; sessionId?: string | null
  applicationLabel?: string | null; reportedApplication?: string | null
  usage?: Record<string, unknown> | null
  provenance?: string; identityVerified?: boolean
}
export interface RoundtableMessage {
  id: string; seq: number; seatId: string | null; kind: string; body: string; createdAt: RoundtableTime
  actual?: RoundtableActual | null; artifacts?: unknown[]; turnId?: string; attemptId?: string
  verification?: { reported?: unknown; confirmed?: boolean }
}
export interface RoundtableTask {
  id: string; title?: string; seatId: string; phase: string; status: string
  dependencies?: string[]; permission?: string; artifacts?: unknown[]; verification?: unknown
}
export interface RoundtableOutcome {
  body: string; dissent?: unknown[]; artifacts?: unknown[]; acceptance: string
  verification?: { reported?: unknown; confirmed?: boolean }; createdAt: RoundtableTime
}
export interface RoundtableSnapshot {
  room: RoundtableRoom; messages: RoundtableMessage[]; tasks: RoundtableTask[]
  currentTurn: { id: string; seatId: string; status: string; phase: string; deadline?: RoundtableTime | null; taskId?: string | null } | null
  outcome: RoundtableOutcome | null; nextCursor?: number
  hasMore?: boolean
  events?: { id: string; kind: string; createdAt: RoundtableTime; confirmed?: boolean }[]
  attempts?: { id: string; turnId: string; seatId: string; status: string; startedAt: RoundtableTime; finishedAt?: RoundtableTime | null; actual?: RoundtableActual | null }[]
  lateResults?: { turnId: string; attemptId: string; seatId: string; receivedAt: RoundtableTime; body: string; status: string }[]
}
export interface RoundtableCreateInput {
  goal: string; mode: 'discussion' | 'collaboration'; seats: RoundtableSeat[]; limits: RoundtableLimits
  projectPath?: string; personalProjectId?: string
  binding?: { taskId?: string; artifactRevision?: number }
}
export type RoundtableControl = 'start' | 'pause' | 'resume' | 'stop' | 'next_round' | 'advance_phase' | 'retry_turn' | 'skip_turn' | 'complete' | 'update_limits'
export interface RoundtableInvite { roomId: string; seatId: string; seatToken: string; expiresAt: RoundtableTime }

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/roundtables${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    // Never include the submitted body: invite tokens and participant data are private.
    throw new Error(typeof payload?.error?.message === 'string' ? payload.error.message
      : typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`)
  }
  if (payload === null) throw new Error('Invalid roundtable response')
  return payload as T
}

export const roundtableApi = {
  list: () => request<{ rooms: RoundtableRoom[] }>(''),
  read: (id: string, after = 0) => request<RoundtableSnapshot>(`/${encodeURIComponent(id)}?after=${after}&limit=100`),
  create: async (input: RoundtableCreateInput) => {
    const result = await request<RoundtableRoom | { room: RoundtableRoom }>('', input)
    return 'room' in result ? result.room : result
  },
  control: (id: string, action: RoundtableControl, expectedRevision: number, reason?: string, limits?: RoundtableLimits) => request<unknown>(`/${encodeURIComponent(id)}/control`, { action, expectedRevision, ...(reason ? { reason } : {}), ...(limits ? { limits } : {}) }),
  message: (id: string, body: string) => request<unknown>(`/${encodeURIComponent(id)}/messages`, { body }),
  invite: (id: string, seatId: string) => request<RoundtableInvite>(`/${encodeURIComponent(id)}/invites`, { seatId }),
  revoke: (id: string, seatId: string) => request<unknown>(`/${encodeURIComponent(id)}/revoke`, { seatId }),
}
